// server/routes/legacy.js
// Auth-guarded wrappers for legacy business logic not yet fully strangled to Postgres.
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import multer from 'multer'
import * as campaignsRepo from '../db/postgres/repositories/campaigns.repo.js'
import * as membersRepo from '../db/postgres/repositories/members.repo.js'
import * as lexiconRepo from '../db/postgres/repositories/lexicon.repo.js'
import * as journalRepo from '../db/postgres/repositories/journal.repo.js'
import * as bardTalesRepo from '../db/postgres/repositories/bard-tales.repo.js'
import * as trackersRepo from '../db/postgres/repositories/trackers.repo.js'
import * as jobsRepo from '../db/postgres/repositories/jobs.repo.js'
import { dbForCampaignBase } from '../db/index.js'
import { withCampaignParamWriteLock, runWithCampaignWriteLock, sourceHashForText } from '../utils.js'
import { MAX_UPLOAD_BYTES, CAMPAIGNS_DIR, DATA_DIR, DIST_DIR, SSH_USER, SSH_HOST, BARD_PROMPT_VERSION, REMOTE_AUDIO_DIR } from '../config.js'
import { diagnosticRuntimeSnapshot, recentDiagnosticLogs } from '../services/diagnostics.js'
import {
  applyApprovedProposal, rejectProposal, queueApproval,
  ensureCanonicalStores, makeCanonicalEntity, upsertLexiconEntry,
  normalizeLexTerm, normalizeEntityType, trackerTypeForEntityType,
  ensureCampaignDirs, loadCampaignDocument, persistCampaignDocument,
  persistCanonicalStoresSqlPrimary, getCampaignState,
  buildCampaignExportPayload, writeCampaignExportFile, createCampaignSqliteBackup,
  upsertGameSession, addSourceToGameSession,
  filesForCampaign, parityHashRows,
  loadBardTalesSqlPrimary, persistBardTalesSqlPrimary,
  loadJournalEntriesSqlPrimary, persistJournalEntriesSqlPrimary,
  sqlTrackerRowsByType,
  normalizeSourceForHash,
  listCampaignSessions, listCampaigns,
} from '../services/campaign.js'

import {
  llmGeneratePipeline, llmGenerate, llmGeneratePipelineWithFallback,
  BARD_PERSONAS, FAITHFULNESS_RULES,
  run, extractJson,
  jobs, trackJob, scheduleJobCleanup,
  processAudioJob, processTranscriptJob,
  upload as pipelineUpload,
  loadDmJobConfig,
  getRuntimeConfig, getRuntimeApiKeys,
  loadPersistedOpenAiKey, persistOpenAiKey,
  loadPersistedAnthropicKey, persistAnthropicKey,
  loadPersistedGeminiKey, persistGeminiKey,
  loadPersistedPyannoteToken, persistPyannoteToken,
  loadPersistedGroqKey, persistGroqKey,
  persistAsrConfig,
} from '../services/pipeline.js'
import { promises as fs } from 'node:fs'

const legacyUpload = multer({
  dest: path.join(os.tmpdir(), 'dnd-upload'),
  limits: { fileSize: MAX_UPLOAD_BYTES },
})

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function resolveCampaign(slug, user) {
  const campaign = await campaignsRepo.findCampaignBySlug(slug)
  if (!campaign) return null
  if (user.role !== 'admin') {
    const member = await membersRepo.findMember(campaign.id, user.id)
    if (!member) return null
  }
  return campaign
}

function isDm(user, campaign) {
  return user.role === 'admin' || (user.role === 'dm' && user.id === campaign.owner_user_id)
}

function withBodyCampaignLock(handler) {
  return async (req, res, next) => {
    try {
      const campaignId = String(req.body?.campaignId || '').trim()
      if (!campaignId) return handler(req, res, next)
      await runWithCampaignWriteLock(campaignId, () => handler(req, res, next))
    } catch (err) { next(err) }
  }
}

export function setupLegacyProxyRoutes(app) {

  // ── Admin diagnostics ─────────────────────────────────────────────────────

  app.get('/api/admin/diagnostics', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' })

    const cfg = getRuntimeConfig()

    async function probe(url) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
        return { reachable: true, httpStatus: r.status }
      } catch (err) {
        return { reachable: false, error: err?.cause?.code || err.message }
      }
    }

    async function checkDataDir() {
      const testFile = path.join(DATA_DIR, `.diagnostics-${Date.now()}`)
      try {
        await fs.mkdir(DATA_DIR, { recursive: true })
        await fs.writeFile(testFile, 'ok')
        await fs.unlink(testFile)
        return { writable: true }
      } catch (err) {
        return { writable: false, error: err.message }
      }
    }

    const campaignEntries = await fs.readdir(CAMPAIGNS_DIR, { withFileTypes: true }).catch(() => [])
    const campaignCount = campaignEntries.filter((entry) => entry.isDirectory()).length
    const activeJobs = [...jobs.values()].filter((job) => !['done', 'error', 'cancelled'].includes(String(job.status || '')))
    const jobStatusCounts = [...jobs.values()].reduce((acc, job) => {
      const key = String(job.status || 'unknown')
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})
    const recentJobs = [...jobs.values()]
      .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
      .slice(0, 20)
      .map((job) => ({
        id: job.id,
        status: job.status,
        stage: job.stage,
        campaignId: job.campaignId,
        gameSessionTitle: job.gameSessionTitle,
        sourceLabel: job.sourceLabel,
        provider: job.llmProvider || job.reviewerProvider || null,
        model: job.llmModel || job.reviewerModel || null,
        progressPct: job.progressPct,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      }))

    const ollamaEndpoint = (cfg.ollamaBase || '').replace(/\/+$/, '')
    const whisperLocalEndpoint = (cfg.whisperLocalBase || '').replace(/\/+$/, '')
    const [dataDir, ollama, whisperLocal] = await Promise.all([
      checkDataDir(),
      probe(`${ollamaEndpoint}/api/tags`),
      probe(`${whisperLocalEndpoint}/health`),
    ])

    res.json({
      ok: true,
      runtime: diagnosticRuntimeSnapshot(),
      paths: {
        dataDir: DATA_DIR,
        campaignsDir: CAMPAIGNS_DIR,
        distDir: DIST_DIR,
      },
      config: {
        asrProvider: cfg.asrProvider,
        whisperModel: cfg.whisperModel,
        whisperDevice: cfg.whisperDevice,
        whisperLocalBase: cfg.whisperLocalBase,
        whisperLocalPath: cfg.whisperLocalPath,
        whisperLocalModel: cfg.whisperLocalModel,
        whisperLocalApiKeyHeader: cfg.whisperLocalApiKeyHeader,
        hasWhisperLocalApiKey: cfg.hasWhisperLocalApiKey,
        groqModel: cfg.groqWhisperModel,
        hasGroqKey: cfg.hasGroqKey,
        hasOpenaiKey: cfg.hasOpenaiKey,
        hasAnthropicKey: cfg.hasAnthropicKey,
        hasGeminiKey: cfg.hasGeminiKey,
        hasPyannoteToken: cfg.hasPyannoteToken,
        diarizationMode: cfg.diarizationMode,
        llmProvider: cfg.llmProvider,
        llmModel: cfg.llmModel,
        maxConcurrentJobs: cfg.maxConcurrentJobs,
        maxUploadBytes: cfg.maxUploadBytes,
      },
      counts: {
        campaigns: campaignCount,
        jobs: jobs.size,
        activeJobs: activeJobs.length,
        jobStatusCounts,
      },
      health: {
        dataDir,
        ollama: { endpoint: ollamaEndpoint, ...ollama },
        whisperLocal: { endpoint: whisperLocalEndpoint, ...whisperLocal },
      },
      jobs: recentJobs,
      logs: recentDiagnosticLogs(Number(req.query?.limit) || 120),
    })
  })

  // ── SQL parity (Postgres stats) ───────────────────────────────────────────

  app.get('/api/campaigns/:id/sql-parity', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    try {
      const [{ entities, aliases }, trackers, journalCount, bardTalesList] = await Promise.all([
        lexiconRepo.loadEntities(campaign.id),
        trackersRepo.loadTrackers(campaign.id),
        journalRepo.countJournalEntries(campaign.id),
        bardTalesRepo.loadBardTales(campaign.id),
      ])
      res.json({
        ok: true,
        parity: {
          mode: 'postgres',
          ok: true,
          canonical: { entityCount: entities.length, aliasCount: aliases.length, trackerCount: trackers.length },
          journal: { count: journalCount },
          bardTales: { count: bardTalesList.length },
        },
      })
    } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
  })

  // ── Export & backup ───────────────────────────────────────────────────────

  app.get('/api/campaigns/:id/export', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    try {
      const includeArtifactIndex = String(req.query?.includeArtifactIndex ?? 'true').toLowerCase() !== 'false'
      const payload = await buildCampaignExportPayload(req.params.id, { includeArtifactIndex })
      res.json({ ok: true, export: payload })
    } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
  }))

  app.post('/api/campaigns/:id/export', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    try {
      const includeArtifactIndex = req.body?.includeArtifactIndex !== false
      const exportFile = await writeCampaignExportFile(req.params.id, { includeArtifactIndex })
      res.json({ ok: true, exportFile })
    } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
  }))

  app.post('/api/campaigns/:id/backup', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    try {
      const backup = await createCampaignSqliteBackup(req.params.id)
      res.json({ ok: true, backup })
    } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
  }))

  // ── Bard's Tale generation (LLM) ──────────────────────────────────────────

  app.post('/api/campaigns/:id/bards-tale', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    try {
      const title = String(req.body?.title || 'The Tale').trim()
      const journal = String(req.body?.journal || '').trim()
      const personaIdRaw = String(req.body?.personaId || 'grandiose').trim()
      const faithfulnessRaw = String(req.body?.faithfulness || 'dramatic').trim()
      if (!journal) return res.status(400).json({ ok: false, error: 'journal is required' })

      const persona = BARD_PERSONAS[personaIdRaw] || BARD_PERSONAS.grandiose
      const faithfulness = FAITHFULNESS_RULES[faithfulnessRaw] ? faithfulnessRaw : 'dramatic'

      const tale = await llmGeneratePipeline(`You are a bard retelling a D&D campaign journal entry for an audience in a tavern.

Rules:
- Use only the characters, events, locations, and facts contained in the journal entry.
- Do not invent new characters, events, items, motives, or outcomes.
- Do not contradict the source text.
- Preserve the meaning of the source material.
- You may add dramatic flair, rhythm, vivid phrasing, and emotional emphasis.
- You may compress or reorder details only for flow and performance.
- If the journal is plain, enrich the language, not the facts.
- Keep the result readable, entertaining, and clearly based on the journal entry.

Bard persona:
${persona.styleBlock}

Faithfulness rules:
${FAITHFULNESS_RULES[faithfulness]}

Write in a strong spoken-storytelling voice suitable for performance in a tavern.

Journal entry title: ${title}
Journal entry:
${journal}`)

      const bardTitleRaw = await llmGeneratePipeline(`Create one short bardic title for this tale.
Rules:
- 4 to 9 words
- Title Case
- Evoke place/event vibe
- No quotes, no markdown, no punctuation at end

Session title: ${title}
Persona: ${persona.displayName}
Tale:\n${String(tale || '').slice(0, 1800)}`)

      const bardTitle = String(bardTitleRaw || '').split('\n')[0].trim().replace(/["'`]/g, '') || `${title} Bard's Tale`
      const normalized = normalizeSourceForHash(journal)

      res.json({
        ok: true,
        title,
        bardTitle,
        bardName: persona.bardName,
        personaId: persona.id,
        faithfulness,
        promptVersion: BARD_PROMPT_VERSION,
        sourceHash: sourceHashForText(normalized),
        sourceLength: normalized.length,
        tale: String(tale || '').trim(),
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'bard generation failed' })
    }
  }))

  // ── NPCs ──────────────────────────────────────────────────────────────────

  app.put('/api/campaigns/:id/npcs/update', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    const { base } = await ensureCampaignDirs(req.params.id)
    const npcs = await loadCampaignDocument(req.params.id, base, 'npcs')

    const matchName = String(req.body?.matchName || '').trim().toLowerCase()
    if (!matchName) return res.status(400).json({ ok: false, error: 'matchName required' })

    const idx = npcs.findIndex((n) => String(n.name || '').trim().toLowerCase() === matchName)
    if (idx === -1) return res.status(404).json({ ok: false, error: 'NPC not found' })

    const updated = {
      ...npcs[idx],
      name: String(req.body?.name ?? npcs[idx].name ?? '').trim(),
      role: String(req.body?.role ?? npcs[idx].role ?? '').trim(),
      relation: String(req.body?.relation ?? npcs[idx].relation ?? '').trim(),
      update: String(req.body?.update ?? npcs[idx].update ?? '').trim(),
      updatedAt: Date.now(),
    }

    if (!updated.name) return res.status(400).json({ ok: false, error: 'Name required' })

    npcs[idx] = updated
    await persistCampaignDocument(req.params.id, base, 'npcs', npcs)

    const lexicon = await loadCampaignDocument(req.params.id, base, 'lexicon')
    const lexMap = new Map((lexicon || []).map((l) => [normalizeLexTerm(l.term || ''), l]))
    upsertLexiconEntry(lexMap, {
      term: updated.name,
      kind: 'npc',
      role: updated.role || '',
      relation: updated.relation || '',
      aliases: updated.aliases || [],
      notes: String(updated.notes || updated.update || '').trim(),
    })
    await persistCampaignDocument(req.params.id, base, 'lexicon', Array.from(lexMap.values()))

    res.json({ ok: true, npc: updated })
  }))

  // ── Lexicon ───────────────────────────────────────────────────────────────

  app.post('/api/campaigns/:id/lexicon', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    const { base } = await ensureCampaignDirs(req.params.id)
    const lexicon = await loadCampaignDocument(req.params.id, base, 'lexicon')

    const term = String(req.body?.term || '').trim()
    const kind = String(req.body?.kind || '').trim()
    const creatureType = String(req.body?.creatureType || '').trim()
    const role = String(req.body?.role || '').trim()
    const relation = String(req.body?.relation || '').trim()
    const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases.map((x) => String(x).trim()).filter(Boolean) : []
    const notes = String(req.body?.notes || '').trim()

    if (!term) return res.status(400).json({ ok: false, error: 'term required' })

    const lexMap = new Map((lexicon || []).map((l) => [normalizeLexTerm(l.term || ''), l]))
    const merged = upsertLexiconEntry(lexMap, { term, kind, creatureType, role, relation, aliases, notes })

    await persistCampaignDocument(req.params.id, base, 'lexicon', Array.from(lexMap.values()))

    const canon = await ensureCanonicalStores(req.params.id)
    const trackerRows = Array.isArray(canon.trackerRows) ? canon.trackerRows : []
    const entityType = normalizeEntityType(kind)
    const norm = normalizeLexTerm(term)
    let entity = (canon.entities || []).find((e) => normalizeLexTerm(e?.canonicalTerm || '') === norm)
    if (!entity) {
      entity = makeCanonicalEntity({
        campaignId: req.params.id,
        term,
        entityType,
        legacy: { aliases, notes },
        source: { createdBy: 'dm', lastUpdatedBy: 'dm', lastSourceType: 'manual' },
      })
      canon.entities.push(entity)
    } else {
      entity.aliases = Array.from(new Set([...(entity.aliases || []), ...aliases]))
      entity.notes = notes || entity.notes || ''
      entity.entityType = entityType || entity.entityType
      entity.lastUpdatedBy = 'dm'
      entity.lastSourceType = 'manual'
      entity.updatedAt = Date.now()
    }

    const inTracker = typeof req.body?.inTracker === 'boolean' ? req.body.inTracker : null
    const trackerType = trackerTypeForEntityType(entity.entityType)
    if (trackerType && inTracker != null) {
      const existing = trackerRows.find((r) => String(r?.trackerType || '') === trackerType && String(r?.entityId || '') === String(entity.id))
      if (inTracker && !existing) {
        trackerRows.push({
          id: crypto.randomUUID(),
          campaignId: req.params.id,
          trackerType,
          entityId: entity.id,
          snapshot: {
            status: trackerType === 'quest' ? 'Pending' : undefined,
            subtitle: String(entity?.notes || '').trim(),
          },
          linkMethod: 'manual',
          linkConfidence: 1,
          updatedAt: Date.now(),
        })
      }
      if (!inTracker) {
        for (let i = trackerRows.length - 1; i >= 0; i -= 1) {
          const r = trackerRows[i]
          if (String(r?.trackerType || '') === trackerType && String(r?.entityId || '') === String(entity.id)) trackerRows.splice(i, 1)
        }
      }
    }

    await persistCanonicalStoresSqlPrimary(req.params.id, base, { entities: canon.entities || [], aliases: canon.aliases || [], trackerRows })

    res.json({ ok: true, term: merged })
  }))

  app.put('/api/campaigns/:id/lexicon/:termId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    const { base } = await ensureCampaignDirs(req.params.id)
    const entityId = String(req.params.termId || '').trim()
    if (!entityId) return res.status(400).json({ ok: false, error: 'entityId required' })

    const lexicon = await loadCampaignDocument(req.params.id, base, 'lexicon')

    const canon = await ensureCanonicalStores(req.params.id)
    const entities = Array.isArray(canon.entities) ? canon.entities : []
    const aliasesTable = Array.isArray(canon.aliases) ? canon.aliases : []
    const trackerRows = Array.isArray(canon.trackerRows) ? canon.trackerRows : []

    const entity = entities.find((e) => String(e?.id || '') === String(entityId))
    if (!entity) return res.status(404).json({ ok: false, error: 'canonical entity not found' })

    const idx = lexicon.findIndex((x) => String(x?.id || '') === entityId)
    const prev = idx >= 0 ? (lexicon[idx] || {}) : {
      id: entityId,
      term: entity.canonicalTerm || '',
      kind: entity.entityType || 'term',
      role: '',
      relation: '',
      aliases: Array.isArray(entity.aliases) ? entity.aliases : [],
      notes: entity.notes || '',
    }

    const updated = {
      ...prev,
      id: entityId,
      term: String(req.body?.term ?? prev.term ?? '').trim(),
      kind: String(req.body?.kind ?? prev.kind ?? '').trim(),
      creatureType: String(req.body?.creatureType ?? prev.creatureType ?? '').trim(),
      role: String(req.body?.role ?? prev.role ?? '').trim(),
      relation: String(req.body?.relation ?? prev.relation ?? '').trim(),
      aliases: Array.isArray(req.body?.aliases)
        ? req.body.aliases.map((x) => String(x).trim()).filter(Boolean)
        : (prev.aliases || []),
      notes: String(req.body?.notes ?? prev.notes ?? '').trim(),
      updatedAt: Date.now(),
    }

    if (!updated.term) return res.status(400).json({ ok: false, error: 'term required' })

    if (idx >= 0) lexicon[idx] = updated
    else lexicon.push(updated)
    await persistCampaignDocument(req.params.id, base, 'lexicon', lexicon)

    const priorTerm = String(entity?.canonicalTerm || prev.term || '').trim()
    entity.canonicalTerm = updated.term
    entity.entityType = normalizeEntityType(updated.kind)
    entity.aliases = Array.isArray(updated.aliases) ? updated.aliases : (entity.aliases || [])
    entity.notes = String(updated.notes || entity.notes || '').trim()
    entity.lastUpdatedBy = 'dm'
    entity.lastSourceType = 'manual'
    entity.updatedAt = Date.now()

    const priorNorm = normalizeLexTerm(priorTerm)
    const nextNorm = normalizeLexTerm(updated.term)
    if (priorNorm && nextNorm && priorNorm !== nextNorm) {
      aliasesTable.push({
        id: crypto.randomUUID(),
        entityType: entity.entityType,
        entityId: entity.id,
        alias: priorTerm,
        confidence: 1,
        source: 'dm-rename',
        createdAt: Date.now(),
      })
    }

    if (entity.entityType === 'quest') {
      const quests = await loadCampaignDocument(req.params.id, base, 'quests')
      const qIdx = quests.findIndex((q) => normalizeLexTerm(q?.name || '') === priorNorm || normalizeLexTerm(q?.name || '') === nextNorm)
      if (qIdx >= 0) {
        quests[qIdx] = { ...quests[qIdx], name: updated.term, updatedAt: Date.now() }
        await persistCampaignDocument(req.params.id, base, 'quests', quests)
      }
      for (const row of trackerRows) {
        if (String(row?.trackerType || '') !== 'quest') continue
        if (String(row?.entityId || '') !== String(entity.id)) continue
        row.snapshot = {
          ...(row.snapshot || {}),
          subtitle: String(entity?.data?.objective || entity?.data?.latestUpdate || row?.snapshot?.subtitle || '').trim(),
        }
        row.updatedAt = Date.now()
      }
    }

    if (entity.entityType === 'npc') {
      const npcs = await loadCampaignDocument(req.params.id, base, 'npcs')
      const nIdx = npcs.findIndex((n) => normalizeLexTerm(n?.name || '') === priorNorm || normalizeLexTerm(n?.name || '') === nextNorm)
      if (nIdx >= 0) {
        npcs[nIdx] = { ...npcs[nIdx], name: updated.term, updatedAt: Date.now() }
        await persistCampaignDocument(req.params.id, base, 'npcs', npcs)
      }
      for (const row of trackerRows) {
        if (String(row?.trackerType || '') !== 'npc') continue
        if (String(row?.entityId || '') !== String(entity.id)) continue
        row.snapshot = {
          ...(row.snapshot || {}),
          subtitle: String(entity?.notes || row?.snapshot?.subtitle || '').trim(),
        }
        row.updatedAt = Date.now()
      }
    }

    if (entity.entityType === 'place') {
      const places = await loadCampaignDocument(req.params.id, base, 'places')
      const pIdx = places.findIndex((p) => normalizeLexTerm(p?.name || '') === priorNorm || normalizeLexTerm(p?.name || '') === nextNorm)
      if (pIdx >= 0) {
        places[pIdx] = { ...places[pIdx], name: updated.term, updatedAt: Date.now() }
        await persistCampaignDocument(req.params.id, base, 'places', places)
      }
      for (const row of trackerRows) {
        if (String(row?.trackerType || '') !== 'place') continue
        if (String(row?.entityId || '') !== String(entity.id)) continue
        row.snapshot = {
          ...(row.snapshot || {}),
          subtitle: String(entity?.notes || row?.snapshot?.subtitle || '').trim(),
        }
        row.updatedAt = Date.now()
      }
    }

    const inTracker = typeof req.body?.inTracker === 'boolean' ? req.body.inTracker : null
    const trackerType = trackerTypeForEntityType(entity.entityType)
    if (trackerType && inTracker != null) {
      const existing = trackerRows.find((r) => String(r?.trackerType || '') === trackerType && String(r?.entityId || '') === String(entity.id))
      if (inTracker && !existing) {
        trackerRows.push({
          id: crypto.randomUUID(),
          campaignId: req.params.id,
          trackerType,
          entityId: entity.id,
          snapshot: {
            status: trackerType === 'quest' ? 'Pending' : undefined,
            subtitle: String(entity?.notes || '').trim(),
          },
          linkMethod: 'manual',
          linkConfidence: 1,
          updatedAt: Date.now(),
        })
      }
      if (!inTracker) {
        for (let i = trackerRows.length - 1; i >= 0; i -= 1) {
          const r = trackerRows[i]
          if (String(r?.trackerType || '') === trackerType && String(r?.entityId || '') === String(entity.id)) trackerRows.splice(i, 1)
        }
      }
    }

    await persistCanonicalStoresSqlPrimary(req.params.id, base, { entities, aliases: aliasesTable, trackerRows })

    res.json({ ok: true, term: updated })
  }))

  app.post('/api/campaigns/:id/lexicon/resolve-link', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    const { base } = await ensureCampaignDirs(req.params.id)
    const fromLexiconId = String(req.body?.fromLexiconId || '').trim()
    const toLexiconId = String(req.body?.toLexiconId || '').trim()
    if (!fromLexiconId || !toLexiconId) return res.status(400).json({ ok: false, error: 'fromLexiconId and toLexiconId required' })

    const canon = await ensureCanonicalStores(req.params.id)
    const entities = Array.isArray(canon.entities) ? canon.entities : []
    const aliases = Array.isArray(canon.aliases) ? canon.aliases : []
    const trackerRows = Array.isArray(canon.trackerRows) ? canon.trackerRows : []

    const fromEntity = entities.find((e) => String(e?.id || '') === fromLexiconId)
    const toEntity = entities.find((e) => String(e?.id || '') === toLexiconId)
    if (!fromEntity || !toEntity) return res.status(404).json({ ok: false, error: 'Entity not found' })

    fromEntity.resolution = { state: 'resolved', resolvedToLexiconId: toEntity.id }
    fromEntity.lastUpdatedBy = 'dm'
    fromEntity.lastSourceType = 'manual'
    fromEntity.updatedAt = Date.now()

    aliases.push({
      id: crypto.randomUUID(),
      entityType: toEntity.entityType,
      entityId: toEntity.id,
      alias: String(fromEntity.canonicalTerm || '').trim(),
      confidence: 1,
      source: 'dm-resolution',
      createdAt: Date.now(),
    })

    for (const row of trackerRows) {
      if (String(row?.entityId || '') === String(fromEntity.id)) {
        row.entityId = toEntity.id
        row.linkMethod = 'manual'
        row.linkConfidence = 1
        row.updatedAt = Date.now()
      }
    }

    await persistCanonicalStoresSqlPrimary(req.params.id, base, { entities, aliases, trackerRows })

    res.json({ ok: true, from: fromEntity.id, to: toEntity.id })
  }))

  app.post('/api/campaigns/:id/lexicon/alias', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    const { base } = await ensureCampaignDirs(req.params.id)
    const lexiconId = String(req.body?.lexiconId || '').trim()
    const alias = String(req.body?.alias || '').trim()
    const confidence = Number(req.body?.confidence)
    if (!lexiconId || !alias) return res.status(400).json({ ok: false, error: 'lexiconId and alias required' })

    const canon = await ensureCanonicalStores(req.params.id)
    const entities = Array.isArray(canon.entities) ? canon.entities : []
    const aliases = Array.isArray(canon.aliases) ? canon.aliases : []
    const entity = entities.find((e) => String(e?.id || '') === lexiconId)
    if (!entity) return res.status(404).json({ ok: false, error: 'Entity not found' })

    const exists = aliases.find((a) => String(a?.entityId || '') === lexiconId && normalizeLexTerm(a?.alias || '') === normalizeLexTerm(alias))
    if (!exists) {
      aliases.push({
        id: crypto.randomUUID(),
        entityType: entity.entityType,
        entityId: entity.id,
        alias,
        confidence: Number.isFinite(confidence) ? confidence : 1,
        source: 'manual',
        createdAt: Date.now(),
      })
    }

    entity.aliases = Array.from(new Set([...(entity.aliases || []), alias]))
    entity.lastUpdatedBy = 'dm'
    entity.lastSourceType = 'manual'
    entity.updatedAt = Date.now()

    await persistCanonicalStoresSqlPrimary(req.params.id, base, { entities, aliases, trackerRows: canon.trackerRows || [] })
    res.json({ ok: true, alias, lexiconId: entity.id })
  }))

  app.delete('/api/campaigns/:id/lexicon/:termId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    try {
      const { base } = await ensureCampaignDirs(req.params.id)
      const termId = String(req.params.termId || '').trim()
      const force = String(req.query?.force || '').trim().toLowerCase() === 'true'
      if (!termId) return res.status(400).json({ ok: false, error: 'termId required' })

      const lexicon = await loadCampaignDocument(req.params.id, base, 'lexicon')
      const idx = lexicon.findIndex((x) => String(x?.id || '') === termId)
      if (idx < 0) return res.status(404).json({ ok: false, error: 'Lexicon term not found' })
      const removed = lexicon[idx]

      const canon = await ensureCanonicalStores(req.params.id)
      const entities = Array.isArray(canon.entities) ? canon.entities : []
      const aliases = Array.isArray(canon.aliases) ? canon.aliases : []
      const trackerRows = Array.isArray(canon.trackerRows) ? canon.trackerRows : []

      const target = entities.find((e) => String(e?.id || '') === termId)
        || entities.find((e) => normalizeLexTerm(e?.canonicalTerm || '') === normalizeLexTerm(removed?.term || ''))

      const linkedRows = target ? trackerRows.filter((r) => String(r?.entityId || '') === String(target.id)) : []
      if (linkedRows.length > 0 && !force) {
        return res.status(409).json({
          ok: false,
          error: 'Lexicon term has linked tracker rows. Re-run delete with ?force=true to remove links.',
          linkedCount: linkedRows.length,
        })
      }

      lexicon.splice(idx, 1)

      let deletedEntityId = null
      if (target) {
        deletedEntityId = String(target.id)
        const eIdx = entities.findIndex((e) => String(e?.id || '') === deletedEntityId)
        if (eIdx >= 0) entities.splice(eIdx, 1)
      }

      const nextAliases = deletedEntityId
        ? aliases.filter((a) => String(a?.entityId || '') !== deletedEntityId)
        : aliases
      const nextTrackerRows = deletedEntityId
        ? trackerRows.filter((r) => String(r?.entityId || '') !== deletedEntityId)
        : trackerRows

      const removedTermNorm = normalizeLexTerm(removed?.term || '')
      const removedKind = normalizeEntityType(removed?.kind || '')

      if (removedKind === 'quest') {
        const quests = await loadCampaignDocument(req.params.id, base, 'quests')
        await persistCampaignDocument(req.params.id, base, 'quests', (quests || []).filter((q) => normalizeLexTerm(q?.name || '') !== removedTermNorm))
      }
      if (removedKind === 'npc') {
        const npcs = await loadCampaignDocument(req.params.id, base, 'npcs')
        await persistCampaignDocument(req.params.id, base, 'npcs', (npcs || []).filter((n) => normalizeLexTerm(n?.name || '') !== removedTermNorm))
      }
      if (removedKind === 'place') {
        const places = await loadCampaignDocument(req.params.id, base, 'places')
        await persistCampaignDocument(req.params.id, base, 'places', (places || []).filter((p) => normalizeLexTerm(p?.name || '') !== removedTermNorm))
      }

      await persistCampaignDocument(req.params.id, base, 'lexicon', lexicon)
      await persistCanonicalStoresSqlPrimary(req.params.id, base, { entities, aliases: nextAliases, trackerRows: nextTrackerRows })

      return res.json({ ok: true, removedId: termId, removedTerm: removed?.term || '', force, removedLinkedRows: linkedRows.length })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'Failed to delete lexicon term' })
    }
  }))

  app.delete('/api/campaigns/:id/lexicon', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    const campaignId = req.params.id
    try {
      const { base } = await ensureCampaignDirs(campaignId)

      const stamp = Date.now()
      const backupsDir = path.join(base, 'backups')
      await fs.mkdir(backupsDir, { recursive: true })

      const lexiconDoc = await loadCampaignDocument(campaignId, base, 'lexicon')
      const canon = await ensureCanonicalStores(campaignId)
      const snapshot = {
        lexiconDoc,
        lexiconEntities: canon.entities || [],
        entityAliases: canon.aliases || [],
        backedUpAt: stamp,
      }
      const backupPath = path.join(backupsDir, `lexicon-reset-backup-${stamp}.json`)
      await fs.writeFile(backupPath, JSON.stringify(snapshot, null, 2), 'utf8')

      const db = dbForCampaignBase(base)
      db.prepare('DELETE FROM lexicon_entities WHERE campaign_id = ?').run(campaignId)
      await persistCampaignDocument(campaignId, base, 'lexicon', [])
      await persistCampaignDocument(campaignId, base, 'lexiconMeta', { skipLegacyBackfill: true, resetAt: stamp })

      const removedEntities = (canon.entities || []).length
      const removedAliases = (canon.aliases || []).length

      res.json({ ok: true, removed: { entities: removedEntities, aliases: removedAliases }, backupPath })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'Failed to reset lexicon' })
    }
  }))

  // ── Places ────────────────────────────────────────────────────────────────

  app.post('/api/campaigns/:id/places', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    const { base } = await ensureCampaignDirs(req.params.id)
    const places = await loadCampaignDocument(req.params.id, base, 'places')
    const place = {
      id: crypto.randomUUID(),
      name: String(req.body?.name || '').trim(),
      type: String(req.body?.type || '').trim(),
      notes: String(req.body?.notes || '').trim(),
      tags: Array.isArray(req.body?.tags) ? req.body.tags.map((x) => String(x).trim()).filter(Boolean) : [],
      updatedAt: Date.now(),
    }
    if (!place.name) return res.status(400).json({ ok: false, error: 'place name required' })
    places.push(place)
    await persistCampaignDocument(req.params.id, base, 'places', places)

    const lexicon = await loadCampaignDocument(req.params.id, base, 'lexicon')
    const lexMap = new Map((lexicon || []).map((l) => [normalizeLexTerm(l.term || ''), l]))
    upsertLexiconEntry(lexMap, {
      term: place.name,
      kind: place.type || 'place',
      aliases: place.tags || [],
      notes: place.notes || '',
    })
    await persistCampaignDocument(req.params.id, base, 'lexicon', Array.from(lexMap.values()))

    res.json({ ok: true, place })
  }))

  // ── Module PDF upload ─────────────────────────────────────────────────────

  app.post('/api/campaigns/:id/module-pdf', legacyUpload.single('module'), withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    if (!req.file) return res.status(400).json({ ok: false, error: 'No PDF uploaded. Use form field name: module' })
    const campaignId = req.params.id
    const { llmProvider: legacyLlmProvider, llmModel: legacyLlmModel } = getRuntimeConfig()

    try {
      let extracted = ''
      try {
        const txt = await run('pdftotext', ['-layout', req.file.path, '-'])
        extracted = txt.stdout || ''
      } catch {
        throw new Error('pdftotext is not available or failed on this PDF')
      }

      const extractedText = extracted.trim()
      const extractedChars = extractedText.length
      if (extractedChars < 200) {
        throw new Error('PDF text extraction returned too little content. This file may be image-only/scanned; OCR fallback is needed.')
      }

      const snippet = extractedText.slice(0, 180000)
      const raw = await llmGenerate(
        `Extract campaign module canon from this text. Return STRICT JSON with keys: lexiconAdds, placeAdds, npcUpdates, questUpdates, quotes, journal, dmNotes.
Each list element should be compact objects.
No markdown.\n\n${snippet}`,
      )
      const parsed = extractJson(raw, {})

      const safeFileName = path.basename(req.file.originalname || 'module.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
      const proposal = {
        id: crypto.randomUUID(),
        status: 'pending',
        createdAt: Date.now(),
        campaignId,
        gameSessionId: null,
        gameSessionTitle: 'Module Import',
        sourceId: crypto.randomUUID().slice(0, 8),
        sourceType: 'module-pdf',
        sourceLabel: safeFileName,
        file: safeFileName,
        reviewerProvider: legacyLlmProvider,
        reviewerModel: legacyLlmModel,
        extractedChars,
        extractedPreview: extractedText.slice(0, 1200),
        transcript: '',
        cleanedTranscript: '',
        journal:
          typeof parsed.journal === 'string'
            ? parsed.journal
            : parsed.journal
              ? JSON.stringify(parsed.journal, null, 2)
              : '',
        npcUpdates: Array.isArray(parsed.npcUpdates) ? parsed.npcUpdates : [],
        questUpdates: Array.isArray(parsed.questUpdates) ? parsed.questUpdates : [],
        quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
        lexiconAdds: Array.isArray(parsed.lexiconAdds) ? parsed.lexiconAdds : [],
        placeAdds: Array.isArray(parsed.placeAdds) ? parsed.placeAdds : [],
        dmNotes: String(parsed.dmNotes || ''),
      }

      const hasContent =
        proposal.npcUpdates.length ||
        proposal.questUpdates.length ||
        proposal.quotes.length ||
        proposal.lexiconAdds.length ||
        proposal.placeAdds.length ||
        (proposal.journal || '').trim() ||
        (proposal.dmNotes || '').trim()

      if (!hasContent) {
        throw new Error('Module parsed but yielded no structured content. Try a different model or add OCR/text extraction improvements.')
      }

      await queueApproval(campaignId, proposal)
      res.json({ ok: true, proposalId: proposal.id, extractedChars })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    } finally {
      await fs.unlink(req.file.path).catch(() => {})
    }
  }))

  // ── Data browser import ───────────────────────────────────────────────────

  app.post('/api/campaigns/:id/data-browser/import', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    const campaignId = req.params.id
    const source = String(req.body?.source || 'dnd-data')
    const book = String(req.body?.book || '').trim()
    const mode = String(req.body?.mode || 'approval')
    const sets = req.body?.datasets || {}

    if (source !== 'dnd-data') {
      return res.status(400).json({ ok: false, error: 'Only dnd-data source is supported right now' })
    }

    try {
      const lib = await import('dnd-data')
      const datasets = {
        monsters: Array.isArray(lib.monsters) ? lib.monsters : [],
        spells: Array.isArray(lib.spells) ? lib.spells : [],
        items: Array.isArray(lib.items) ? lib.items : [],
        classes: Array.isArray(lib.classes) ? lib.classes : [],
        species: Array.isArray(lib.species) ? lib.species : [],
        backgrounds: Array.isArray(lib.backgrounds) ? lib.backgrounds : [],
      }

      const byBook = (x) => {
        if (!book || book.toLowerCase() === 'custom') return true
        return String(x?.book || '').toLowerCase().includes(book.toLowerCase())
      }

      const selected = Object.fromEntries(
        Object.entries(datasets).map(([k, arr]) => [k, arr.filter(byBook)]),
      )

      const npcUpdates = (sets.npcs || sets.monsters)
        ? selected.monsters.slice(0, 400).map((m) => ({
            name: String(m?.name || '').trim(),
            role: 'monster',
            relation: 'unknown',
            update: String(m?.description || '').slice(0, 900),
          })).filter((x) => x.name)
        : []

      const lexiconAdds = []
      const addLexFrom = (arr, kind, enabled) => {
        if (!enabled) return
        lexiconAdds.push(
          ...arr.slice(0, 500).map((r) => {
            const name = String(r?.name || '').trim()
            if (!name) return null
            const props = r?.properties && typeof r.properties === 'object' ? r.properties : {}
            const propParts = Object.entries(props)
              .filter(([k]) => !['Category', 'Expansion'].includes(k))
              .map(([k, v]) => `${k}: ${v}`)
            const propsHeader = propParts.length ? propParts.join(' · ') : ''
            let desc = String(r?.description || '')
            if (desc.startsWith(name)) desc = desc.slice(name.length).trim()
            const notes = [propsHeader, desc.slice(0, 700)].filter(Boolean).join('\n')
            return { term: name, kind, aliases: [], notes }
          }).filter(Boolean),
        )
      }

      addLexFrom(selected.spells, 'spell', !!sets.spells)
      addLexFrom(selected.items, 'item', !!sets.items)
      addLexFrom(selected.classes, 'class', !!sets.classes)
      addLexFrom(selected.species, 'species', !!sets.species)
      addLexFrom(selected.backgrounds, 'background', !!sets.backgrounds)
      addLexFrom(selected.monsters, 'monster', !!sets.monsters)

      const placeRaw = sets.places
        ? selected.monsters.slice(0, 500).flatMap((m) => {
            const habitat = m?.properties?.Habitat || m?.properties?.Environment || m?.properties?.Location || ''
            const parts = String(habitat).split(/[,;/]|\band\b/gi).map((x) => x.trim()).filter(Boolean)
            return parts.map((name) => ({
              name,
              type: 'region',
              notes: `Derived from ${m?.name || 'monster'} habitat/environment`,
              tags: ['dnd-data', 'derived'],
            }))
          })
        : []

      const placeMap = new Map()
      for (const p of placeRaw) {
        const k = String(p.name || '').toLowerCase()
        if (!k) continue
        if (!placeMap.has(k)) placeMap.set(k, p)
      }
      const placeAdds = Array.from(placeMap.values()).slice(0, 300)

      const journal = sets.lore
        ? JSON.stringify([
            { entry: `Imported from dnd-data (${book || 'all books'})` },
            { entry: `Monsters: ${selected.monsters.length}, Spells: ${selected.spells.length}, Items: ${selected.items.length}, Classes: ${selected.classes.length}, Species: ${selected.species.length}, Backgrounds: ${selected.backgrounds.length}` },
          ], null, 2)
        : ''

      const proposal = {
        id: crypto.randomUUID(),
        status: 'pending',
        createdAt: Date.now(),
        campaignId,
        gameSessionId: null,
        gameSessionTitle: 'Data Browser Import',
        sourceId: crypto.randomUUID().slice(0, 8),
        sourceType: 'data-browser',
        sourceLabel: `dnd-data${book ? ` • ${book}` : ''}`,
        file: '',
        reviewerProvider: 'data-browser',
        reviewerModel: 'dnd-data',
        extractedChars: 0,
        extractedPreview: `source=${source} book=${book || 'all'} mode=${mode}`,
        transcript: '',
        cleanedTranscript: '',
        journal,
        npcUpdates,
        questUpdates: [],
        quotes: [],
        lexiconAdds,
        placeAdds,
        dmNotes: '',
      }

      if (mode === 'merge') {
        await queueApproval(campaignId, proposal)
        await applyApprovedProposal(campaignId, proposal.id)
        return res.json({ ok: true, mode: 'merge', imported: { npcs: npcUpdates.length, lexicon: lexiconAdds.length, places: placeAdds.length } })
      }

      await queueApproval(campaignId, proposal)
      return res.json({ ok: true, mode: 'approval', proposalId: proposal.id, imported: { npcs: npcUpdates.length, lexicon: lexiconAdds.length, places: placeAdds.length } })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message })
    }
  }))

  // ── Approvals ─────────────────────────────────────────────────────────────

  app.post('/api/campaigns/:id/approvals/:proposalId/approve', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    try {
      const campaignId = req.params.id
      const proposalId = req.params.proposalId
      const editedFullCampaignJournal = typeof req.body?.editedFullCampaignJournal === 'string'
        ? req.body.editedFullCampaignJournal
        : null

      if (editedFullCampaignJournal !== null) {
        const { base } = await ensureCampaignDirs(campaignId)
        const approvals = await loadCampaignDocument(campaignId, base, 'approvals')
        const p = approvals.find((x) => x.id === proposalId)
        if (!p) return res.status(404).json({ ok: false, error: 'Proposal not found' })
        if (p.status !== 'pending') return res.status(400).json({ ok: false, error: 'Proposal already processed' })
        p.journal = editedFullCampaignJournal
        p.fullCampaignJournal = editedFullCampaignJournal
        await persistCampaignDocument(campaignId, base, 'approvals', approvals)
      }

      await applyApprovedProposal(campaignId, proposalId)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  }))

  app.post('/api/campaigns/:id/approvals/:proposalId/reject', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    await rejectProposal(req.params.id, req.params.proposalId)
    res.json({ ok: true })
  }))

  app.post('/api/campaigns/:id/approvals/:proposalId/approve-selected', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDm(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })
    const campaignId = req.params.id
    const proposalId = req.params.proposalId
    const selectedNpcNames = new Set((req.body?.npcNames || []).map((x) => String(x || '').trim()).filter(Boolean))
    const selectedQuestNames = new Set((req.body?.questNames || []).map((x) => String(x || '').trim()).filter(Boolean))
    const selectedQuotes = new Set((req.body?.quotes || []).map((x) => String(x || '').trim()).filter(Boolean))
    const editedFullCampaignJournal = typeof req.body?.editedFullCampaignJournal === 'string' ? req.body.editedFullCampaignJournal : null
    const includeFullCampaignJournal = req.body?.includeFullCampaignJournal !== false
    const includeTimeline = req.body?.includeTimeline !== false
    const includeSessionRecap = req.body?.includeSessionRecap !== false
    const includeRunningCampaignLog = req.body?.includeRunningCampaignLog !== false

    const { base } = await ensureCampaignDirs(campaignId)
    const approvals = await loadCampaignDocument(campaignId, base, 'approvals')
    const p = approvals.find((x) => x.id === proposalId)
    if (!p) return res.status(404).json({ ok: false, error: 'Proposal not found' })
    if (p.status !== 'pending') return res.status(400).json({ ok: false, error: 'Proposal already processed' })

    p.npcUpdates = (p.npcUpdates || []).filter((n) => selectedNpcNames.has(String(n?.name || '').trim()))
    p.questUpdates = (p.questUpdates || []).filter((q) => selectedQuestNames.has(String(q?.name || '').trim()))
    p.quotes = (p.quotes || []).filter((q) => selectedQuotes.has(String((typeof q === 'string' ? q : q?.text) || '').trim()))

    if (editedFullCampaignJournal !== null) {
      p.journal = editedFullCampaignJournal
      p.fullCampaignJournal = editedFullCampaignJournal
    }

    if (!includeFullCampaignJournal) {
      p.journal = ''
      p.fullCampaignJournal = ''
    }
    if (!includeTimeline) p.timeline = []
    if (!includeSessionRecap) p.sessionRecap = ''
    if (!includeRunningCampaignLog) p.runningCampaignLog = []

    await persistCampaignDocument(campaignId, base, 'approvals', approvals)
    await applyApprovedProposal(campaignId, proposalId)
    res.json({ ok: true })
  }))

  // ── Player submissions + quotes ───────────────────────────────────────────

  app.post('/api/campaigns/:id/player-submissions', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    // any campaign member can submit
    const campaignId = req.params.id
    const playerName = String(req.body?.playerName || '').trim()
    const submissionType = String(req.body?.type || 'note').trim().toLowerCase()
    const text = String(req.body?.text || '').trim()
    const gameSessionId = String(req.body?.gameSessionId || '').trim() || null
    const gameSessionTitle = String(req.body?.gameSessionTitle || '').trim() || 'Player Submission'

    if (!playerName) return res.status(400).json({ ok: false, error: 'playerName required' })
    if (!text) return res.status(400).json({ ok: false, error: 'text required' })

    const quoteLines = text
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => /^".*"$/.test(x) || /^".*"$/.test(x))
      .map((x) => x.replace(/^"|"$/g, '').replace(/^"|"$/g, ''))
      .filter(Boolean)

    const proposal = {
      id: crypto.randomUUID(),
      status: 'pending',
      createdAt: Date.now(),
      campaignId,
      gameSessionId,
      gameSessionTitle,
      sourceId: crypto.randomUUID().slice(0, 8),
      sourceType: 'player-submission',
      sourceLabel: `${playerName} • ${submissionType}`,
      file: '',
      submissionType,
      reviewerProvider: 'player',
      reviewerModel: 'manual-submission',
      extractedChars: text.length,
      extractedPreview: text.slice(0, 1200),
      transcript: text,
      cleanedTranscript: text,
      journal: text,
      npcUpdates: [],
      questUpdates: [],
      quotes: quoteLines,
      lexiconAdds: [],
      placeAdds: [],
      dmNotes: '',
    }

    await queueApproval(campaignId, proposal)
    res.json({ ok: true, applied: false, proposalId: proposal.id })
  }))

  app.post('/api/campaigns/:id/player-quotes', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    // any campaign member can submit quotes
    const campaignId = req.params.id
    const text = String(req.body?.text || '').trim()
    const speaker = String(req.body?.speaker || '').trim()
    const playerName = String(req.body?.playerName || '').trim()
    const gameSessionId = String(req.body?.gameSessionId || '').trim() || null
    const tag = String(req.body?.tag || '').trim()

    if (!text) return res.status(400).json({ ok: false, error: 'text required' })

    const { base } = await ensureCampaignDirs(campaignId)
    const state = await getCampaignState(campaignId)

    const normalized = text.replace(/^"|"$/g, '').replace(/^"|"$/g, '').trim()
    if (!normalized) return res.status(400).json({ ok: false, error: 'quote text is empty after normalization' })

    const existing = new Set((state.quotes || []).map((q) => String(q?.text || q || '').trim().toLowerCase()))
    if (existing.has(normalized.toLowerCase())) {
      return res.json({ ok: true, duplicate: true, added: false })
    }

    const entry = {
      text: normalized,
      speaker: speaker || null,
      playerName: playerName || null,
      tag: tag || null,
      sourceType: 'player-direct',
      createdAt: Date.now(),
      gameSessionId,
    }

    const quotes = [...(state.quotes || []), entry]
    await persistCampaignDocument(campaignId, base, 'quotes', quotes)
    res.json({ ok: true, added: true, quote: entry })
  }))

  // ── Transcription ─────────────────────────────────────────────────────────

  app.post('/api/transcribe', legacyUpload.single('audio'), withBodyCampaignLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    if (!req.file) return res.status(400).json({ ok: false, error: 'No audio file uploaded. Use form field name: audio' })

    const cfg = getRuntimeConfig()
    const activeJobCount = [...jobs.values()].filter((j) => !['done', 'error', 'cancelled'].includes(String(j.status || ''))).length
    if (activeJobCount >= cfg.maxConcurrentJobs) {
      await fs.unlink(req.file.path).catch(() => {})
      return res.status(429).json({ ok: false, error: `Too many active jobs (${activeJobCount}/${cfg.maxConcurrentJobs}). Wait for a running job to finish before submitting another.` })
    }

    const campaignId = String(req.body?.campaignId || '').trim()
    if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required' })

    // Verify user has access to this campaign
    const campaign = await resolveCampaign(campaignId, req.user)
    if (!campaign) {
      await fs.unlink(req.file.path).catch(() => {})
      return res.status(404).json({ ok: false, error: 'Campaign not found' })
    }

    let gameSession
    try {
      gameSession = await upsertGameSession(campaignId, {
        gameSessionId: req.body?.gameSessionId,
        newGameSessionTitle: req.body?.newGameSessionTitle,
      })
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message })
    }

    const originalName = req.file.originalname || 'session-audio'
    const safeBase = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_')
    const sourceId = crypto.randomUUID().slice(0, 8)
    const remoteAudioPath = `${REMOTE_AUDIO_DIR}/${safeBase}`
    const jobId = crypto.randomUUID()

    const llmConfig = await loadDmJobConfig(req.user?.id)

    trackJob({
      id: jobId,
      campaignId,
      gameSessionId: gameSession.id,
      gameSessionTitle: gameSession.title,
      sourceId,
      sourceLabel: String(req.body?.sourceLabel || originalName),
      type: 'audio',
      status: 'queued',
      stage: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      file: originalName,
      safeBase,
      localPath: req.file.path,
      remoteAudioPath,
      transcript: '',
      cleanedTranscript: '',
      speakerTranscript: '',
      rawSegments: [],
      journal: '',
      npcUpdates: [],
      questUpdates: [],
      quotes: [],
      durationSec: null,
      totalChunks: null,
      doneChunks: 0,
      currentChunk: 0,
      progressPct: 0,
      etaSec: null,
      expiresAt: null,
      proposalId: null,
      error: null,
      llmConfig,
    })

    processAudioJob(jobId)
    res.json({ ok: true, jobId, status: 'queued', stage: 'queued' })
  }))

  app.post('/api/transcribe-text', legacyUpload.single('transcript'), withBodyCampaignLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    if (!req.file) return res.status(400).json({ ok: false, error: 'No transcript file uploaded. Use form field name: transcript' })

    const cfg = getRuntimeConfig()
    const activeJobCountTxt = [...jobs.values()].filter((j) => !['done', 'error', 'cancelled'].includes(String(j.status || ''))).length
    if (activeJobCountTxt >= cfg.maxConcurrentJobs) {
      await fs.unlink(req.file.path).catch(() => {})
      return res.status(429).json({ ok: false, error: `Too many active jobs (${activeJobCountTxt}/${cfg.maxConcurrentJobs}). Wait for a running job to finish before submitting another.` })
    }

    const campaignId = String(req.body?.campaignId || '').trim()
    if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required' })

    // Verify user has access to this campaign
    const campaign = await resolveCampaign(campaignId, req.user)
    if (!campaign) {
      await fs.unlink(req.file.path).catch(() => {})
      return res.status(404).json({ ok: false, error: 'Campaign not found' })
    }

    let gameSession
    try {
      gameSession = await upsertGameSession(campaignId, {
        gameSessionId: req.body?.gameSessionId,
        newGameSessionTitle: req.body?.newGameSessionTitle,
      })
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message })
    }

    const jobId = crypto.randomUUID()
    try {
      const transcript = await fs.readFile(req.file.path, 'utf8')
      const safeFileName = path.basename(req.file.originalname || 'transcript').replace(/[^a-zA-Z0-9._-]/g, '_')
      const llmConfig = await loadDmJobConfig(req.user?.id)
      const job = {
        id: jobId,
        campaignId,
        gameSessionId: gameSession.id,
        gameSessionTitle: gameSession.title,
        sourceId: crypto.randomUUID().slice(0, 8),
        sourceLabel: String(req.body?.sourceLabel || safeFileName || 'transcript'),
        type: 'transcript',
        status: 'queued',
        stage: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        file: safeFileName || 'transcript.txt',
        transcript,
        cleanedTranscript: '',
        speakerTranscript: '',
        rawSegments: [],
        journal: '',
        npcUpdates: [],
        questUpdates: [],
        quotes: [],
        progressPct: 0,
        etaSec: 0,
        proposalId: null,
        error: null,
        llmConfig,
      }
      job.expiresAt = null
      trackJob(job)
      processTranscriptJob(job)
      res.json({ ok: true, jobId, status: 'queued', stage: 'queued' })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    } finally {
      await fs.unlink(req.file.path).catch(() => {})
    }
  }))

  app.get('/api/transcribe/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    let job = jobs.get(req.params.id)
    if (!job) {
      job = await jobsRepo.findJob(req.params.id).catch(() => null)
      if (job) jobs.set(job.id, job)
    }
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' })
    const cfg = getRuntimeConfig()
    res.json({
      ok: true,
      id: job.id,
      campaignId: job.campaignId,
      gameSessionId: job.gameSessionId,
      gameSessionTitle: job.gameSessionTitle,
      sourceId: job.sourceId,
      sourceLabel: job.sourceLabel,
      proposalId: job.proposalId,
      preAiArtifactPath: job.preAiArtifactPath,
      preAiArtifactSavedAt: job.preAiArtifactSavedAt,
      diarizationMode: cfg.diarizationMode,
      diarizationArtifactPath: job.diarizationArtifactPath,
      diarizationFallback: job.diarizationFallback,
      checkpointPaths: job.checkpointPaths || [],
      pipelineFallback: job.pipelineFallback || null,
      type: job.type,
      file: job.file,
      status: job.status,
      stage: job.stage,
      progressPct: job.progressPct,
      etaSec: job.etaSec,
      totalChunks: job.totalChunks,
      doneChunks: job.doneChunks,
      currentChunk: job.currentChunk,
      transcript: job.status === 'done' ? (job.cleanedTranscript || job.transcript) : undefined,
      diarizedTranscript: job.status === 'done' ? (job.speakerTranscript || undefined) : undefined,
      journal: job.status === 'done' ? job.journal : undefined,
      fullCampaignJournal: job.status === 'done' ? (job.journal || '') : undefined,
      timeline: job.status === 'done' ? (job.timeline || []) : undefined,
      sessionRecap: job.status === 'done' ? (job.sessionRecap || '') : undefined,
      runningCampaignLog: job.status === 'done' ? (job.runningCampaignLog || []) : undefined,
      npcUpdates: job.status === 'done' ? job.npcUpdates : undefined,
      questUpdates: job.status === 'done' ? job.questUpdates : undefined,
      quotes: job.status === 'done' ? job.quotes : undefined,
      error: (job.status === 'error' || job.status === 'cancelled') ? job.error : undefined,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })
  })

  app.post('/api/transcribe/:id/cancel', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const job = jobs.get(req.params.id) || await jobsRepo.findJob(req.params.id).catch(() => null)
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' })
    if (['done', 'error', 'cancelled'].includes(String(job.status || ''))) {
      return res.json({ ok: true, id: job.id, status: job.status, stage: job.stage, message: 'Job already terminal' })
    }
    if (!jobs.has(job.id)) jobs.set(job.id, job)
    const liveJob = jobs.get(job.id)
    liveJob.cancelRequested = true
    liveJob.updatedAt = Date.now()
    liveJob.stage = 'cancelling'
    liveJob.status = 'running'
    return res.json({ ok: true, id: liveJob.id, cancelRequested: true, status: liveJob.status, stage: liveJob.stage })
  })

}
