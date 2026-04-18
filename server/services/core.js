export function normalizeLexTerm(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function upsertLexiconEntry(lexMap, { term = '', kind = '', role = '', relation = '', aliases = [], notes = '' } = {}) {
  const normalized = normalizeLexTerm(term)
  if (!normalized) return null

  const existing = lexMap.get(normalized) || {}
  const aliasSet = new Set([...(existing.aliases || []), ...(Array.isArray(aliases) ? aliases : [])].map((x) => String(x || '').trim()).filter(Boolean))

  const next = {
    id: existing.id || crypto.randomUUID(),
    term: String(existing.term || term).trim(),
    kind: String(kind || existing.kind || '').trim(),
    role: String(role || existing.role || '').trim(),
    relation: String(relation || existing.relation || '').trim(),
    aliases: Array.from(aliasSet),
    notes: String(notes || existing.notes || '').trim(),
    updatedAt: Date.now(),
  }

  lexMap.set(normalized, next)
  return next
}

export function normalizeEntityType(value = '') {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return 'term'
  if (['npc', 'quest', 'place', 'event', 'item', 'faction', 'term'].includes(raw)) return raw
  if (['city', 'town', 'region', 'dungeon', 'landmark', 'location'].includes(raw)) return 'place'
  return 'term'
}

export function trackerTypeForEntityType(entityType = '') {
  const t = normalizeEntityType(entityType)
  if (t === 'quest' || t === 'npc' || t === 'place') return t
  return null
}

export function parseQuestDataFromLegacy(legacy = {}) {
  const status = String(legacy?.status || '').trim()
  const objective = String(legacy?.objective || '').trim()
  const reward = String(legacy?.reward || '').trim()
  const latestUpdate = String(legacy?.update || legacy?.latestUpdate || '').trim()
  return { status, objective, reward, latestUpdate }
}

export function makeCanonicalEntity({ campaignId, term = '', entityType = 'term', legacy = {}, source = {} }) {
  return {
    id: String(legacy?.id || '').trim() || crypto.randomUUID(),
    campaignId,
    entityType: normalizeEntityType(entityType || legacy?.entityType || legacy?.kind),
    canonicalTerm: String(term || legacy?.term || legacy?.name || '').trim(),
    notes: String(legacy?.notes || '').trim(),
    data: (legacy?.data && typeof legacy.data === 'object')
      ? legacy.data
      : normalizeEntityType(entityType || legacy?.entityType || legacy?.kind) === 'quest'
        ? parseQuestDataFromLegacy(legacy)
        : {},
    resolution: {
      state: String(legacy?.resolution?.state || '').trim() || 'resolved',
      resolvedToLexiconId: legacy?.resolution?.resolvedToLexiconId || null,
    },
    ownership: {
      canonicalTerm: 'locked',
      entityType: 'locked',
      aliases: 'append_only_review',
      dataStatus: 'mutable',
      dataLatestUpdate: 'mutable',
      listFields: 'append_only_review',
      ...(legacy?.ownership || {}),
    },
    evidence: Array.isArray(legacy?.evidence) ? legacy.evidence : [],
    aliases: Array.isArray(legacy?.aliases) ? legacy.aliases.map((x) => String(x || '').trim()).filter(Boolean) : [],
    createdBy: String(legacy?.createdBy || source.createdBy || 'import').trim(),
    lastUpdatedBy: String(legacy?.lastUpdatedBy || source.lastUpdatedBy || 'import').trim(),
    lastSourceType: String(legacy?.lastSourceType || source.lastSourceType || '').trim(),
    lastSourceId: String(legacy?.lastSourceId || source.lastSourceId || '').trim() || null,
    createdAt: Number(legacy?.createdAt || Date.now()),
    updatedAt: Number(legacy?.updatedAt || Date.now()),
  }
}

export async function ensureCanonicalStores(campaignId, state = null) {
  const { base } = await ensureCampaignDirs(campaignId)
  const now = Date.now()

  const canon = await loadCanonicalStoresSqlPrimary(campaignId, base)
  let entities = Array.isArray(canon.entities) ? canon.entities : []
  let aliases = Array.isArray(canon.aliases) ? canon.aliases : []
  let trackerRows = Array.isArray(canon.trackerRows) ? canon.trackerRows : []

  const src = state || {
    lexicon: await loadCampaignDocument(campaignId, base, 'lexicon'),
    quests: await loadCampaignDocument(campaignId, base, 'quests'),
    npcs: await loadCampaignDocument(campaignId, base, 'npcs'),
    places: await loadCampaignDocument(campaignId, base, 'places'),
  }

  const byNorm = new Map()
  for (const e of entities) {
    byNorm.set(normalizeLexTerm(e?.canonicalTerm || ''), e)
  }

  const ensureEntity = ({ term, entityType, legacy, source }) => {
    const norm = normalizeLexTerm(term)
    if (!norm) return null
    const existing = byNorm.get(norm)
    if (existing) return existing
    const created = makeCanonicalEntity({ campaignId, term, entityType, legacy, source })
    byNorm.set(norm, created)
    entities.push(created)
    return created
  }

  // Full-cutover behavior: only run legacy backfill on empty canonical store.
  // Once canonical entities exist, avoid re-importing legacy JSON name-based rows.
  // Also skip if the user explicitly reset the lexicon (skipLegacyBackfill flag).
  const lexiconMeta = await loadCampaignDocument(campaignId, base, 'lexiconMeta')
  const needsLegacyBackfill = entities.length === 0 && !lexiconMeta?.skipLegacyBackfill
  if (needsLegacyBackfill) {
    for (const l of (src.lexicon || [])) {
      ensureEntity({ term: l.term, entityType: l.entityType || l.kind, legacy: l, source: { createdBy: 'import', lastUpdatedBy: 'import' } })
    }
    for (const q of (src.quests || [])) {
      const entity = ensureEntity({ term: q.name, entityType: 'quest', legacy: q, source: { createdBy: 'import', lastUpdatedBy: 'import' } })
      if (!entity) continue
      entity.data = { ...parseQuestDataFromLegacy(q), ...(entity.data || {}) }
      entity.updatedAt = now

      const existingRow = trackerRows.find((r) => String(r?.entityId || '') === String(entity.id) && String(r?.trackerType || '') === 'quest')
      const snapshot = {
        status: String(entity?.data?.status || '').trim() || 'Unknown',
        subtitle: String(entity?.data?.objective || entity?.data?.latestUpdate || '').trim(),
      }
      if (existingRow) {
        existingRow.snapshot = snapshot
        existingRow.updatedAt = now
        if (!existingRow.linkMethod) existingRow.linkMethod = 'legacy-backfill'
        if (existingRow.linkConfidence == null) existingRow.linkConfidence = 1
      } else {
        trackerRows.push({
          id: crypto.randomUUID(),
          campaignId,
          trackerType: 'quest',
          entityId: entity.id,
          snapshot,
          linkMethod: 'legacy-backfill',
          linkConfidence: 1,
          updatedAt: now,
        })
      }
    }

    for (const n of (src.npcs || [])) {
      ensureEntity({ term: n.name, entityType: 'npc', legacy: n, source: { createdBy: 'import', lastUpdatedBy: 'import' } })
    }

    for (const p of (src.places || [])) {
      ensureEntity({ term: p.name, entityType: 'place', legacy: p, source: { createdBy: 'import', lastUpdatedBy: 'import' } })
    }
  }

  // Opt-in tracker policy: remove historical NPC/place rows that were auto-backfilled.
  trackerRows = trackerRows.filter((r) => {
    const t = String(r?.trackerType || '')
    const m = String(r?.linkMethod || '')
    if ((t === 'npc' || t === 'place') && m === 'legacy-backfill') return false
    return true
  })

  for (const e of entities) {
    const entityAliases = Array.isArray(e.aliases) ? e.aliases : []
    for (const alias of entityAliases) {
      const normalizedAlias = normalizeLexTerm(alias)
      if (!normalizedAlias) continue
      const exists = aliases.some((a) => normalizeLexTerm(a?.alias || '') === normalizedAlias && String(a?.entityId || '') === String(e.id))
      if (exists) continue
      aliases.push({
        id: crypto.randomUUID(),
        entityType: e.entityType,
        entityId: e.id,
        alias: String(alias).trim(),
        confidence: 1,
        source: 'backfill',
        createdAt: now,
      })
    }
  }

  return await persistCanonicalStoresSqlPrimary(campaignId, base, { entities, aliases, trackerRows })
}

export async function ensureCampaignDirs(campaignId, options = {}) {
  const { create = false } = options
  const resolved = resolveCampaignBase(campaignId)
  const sessionsDir = path.join(resolved.base, 'sessions')
  const importsDir = path.join(resolved.base, 'imports')
  const exportsDir = path.join(resolved.base, 'exports')
  const backupsDir = path.join(resolved.base, 'backups')

  if (create) {
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.mkdir(importsDir, { recursive: true })
    await fs.mkdir(exportsDir, { recursive: true })
    await fs.mkdir(backupsDir, { recursive: true })
    return resolved
  }

  try {
    const stat = await fs.stat(resolved.base)
    if (!stat.isDirectory()) throw new CampaignNotFoundError(resolved.campaignId)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new CampaignNotFoundError(resolved.campaignId)
    throw error
  }

  await fs.mkdir(sessionsDir, { recursive: true })
  await fs.mkdir(importsDir, { recursive: true })
  await fs.mkdir(exportsDir, { recursive: true })
  await fs.mkdir(backupsDir, { recursive: true })
  return resolved
}

export async function persistPreAiArtifact(job, { transcript = '', rawSegments = [], inputType = '', extra = {} } = {}) {
  const { base } = await ensureCampaignDirs(job.campaignId)
  const importsDir = path.join(base, 'imports')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeLabel = String(job.sourceLabel || 'source').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  const outPath = path.join(importsDir, `${stamp}-${job.sourceId}-${inputType || job.type}-${safeLabel}.json`)

  const payload = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    campaignId: job.campaignId,
    gameSessionId: job.gameSessionId,
    gameSessionTitle: job.gameSessionTitle,
    sourceId: job.sourceId,
    sourceLabel: job.sourceLabel,
    sourceFile: job.file || null,
    inputType: inputType || job.type,
    transcript: String(transcript || ''),
    rawSegments: Array.isArray(rawSegments) ? rawSegments : [],
    pipelineConfig: {
      provider: job.llmConfig?.provider || LLM_PROVIDER,
      model: job.llmConfig?.model || LLM_MODEL,
      pipelineChatgptOnly: PIPELINE_CHATGPT_ONLY,
      pipelineOpenaiModel: PIPELINE_OPENAI_MODEL,
      pipelineOpenaiFallbackModel: PIPELINE_OPENAI_FALLBACK_MODEL,
    },
    ...extra,
  }

  await writeJson(outPath, payload)
  job.preAiArtifactPath = outPath
  job.preAiArtifactSavedAt = Date.now()
  return outPath
}

export async function persistPipelineCheckpoint(job, stage, data = {}) {
  const { base } = await ensureCampaignDirs(job.campaignId)
  const importsDir = path.join(base, 'imports')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeStage = String(stage || 'checkpoint').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
  const outPath = path.join(importsDir, `${stamp}-${job.sourceId}-checkpoint-${safeStage}.json`)
  const payload = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    campaignId: job.campaignId,
    gameSessionId: job.gameSessionId,
    sourceId: job.sourceId,
    stage,
    provider: job.llmConfig?.provider || LLM_PROVIDER,
    model: job.llmConfig?.model || LLM_MODEL,
    data,
  }
  await writeJson(outPath, payload)
  if (!Array.isArray(job.checkpointPaths)) job.checkpointPaths = []
  job.checkpointPaths.push(outPath)
  return outPath
}

export function filesForCampaign(base) {
  return {
    rawSessionsDir: path.join(base, 'sessions'),
    importsDir: path.join(base, 'imports'),
    exportsDir: path.join(base, 'exports'),
    backupsDir: path.join(base, 'backups'),
  }
}

export function timestampForFilename(value = Date.now()) {
  return new Date(value).toISOString().replace(/[:.]/g, '-')
}

export function escapeSqlString(value = '') {
  return String(value).replace(/'/g, "''")
}

export async function buildCampaignExportPayload(campaignId, options = {}) {
  const { includeArtifactIndex = true } = options
  const { base } = await ensureCampaignDirs(campaignId)
  const f = filesForCampaign(base)
  const meta = await readJson(path.join(base, 'meta.json'), null)
  const state = await getCampaignState(campaignId)

  const payload = {
    version: 1,
    exportedAt: Date.now(),
    campaign: meta,
    persistence: {
      mode: 'sqlite-only',
      databaseFile: 'campaign.sqlite',
    },
    state,
  }

  if (includeArtifactIndex) {
    payload.artifacts = {
      sessions: await fs.readdir(f.rawSessionsDir).catch(() => []),
      imports: await fs.readdir(f.importsDir).catch(() => []),
    }
  }

  return payload
}

export async function writeCampaignExportFile(campaignId, options = {}) {
  const { base } = await ensureCampaignDirs(campaignId)
  const f = filesForCampaign(base)
  const payload = await buildCampaignExportPayload(campaignId, options)
  const stamp = timestampForFilename(payload.exportedAt)
  const fileName = `${stamp}-${campaignId}-export.json`
  const filePath = path.join(f.exportsDir, fileName)
  await writeJson(filePath, payload)
  const stat = await fs.stat(filePath)
  return {
    fileName,
    filePath,
    bytes: stat.size,
    exportedAt: payload.exportedAt,
  }
}

export async function createCampaignSqliteBackup(campaignId) {
  const { base } = await ensureCampaignDirs(campaignId)
  const f = filesForCampaign(base)
  const meta = await readJson(path.join(base, 'meta.json'), null)
  const db = dbForCampaignBase(base)
  ensureSqlSchema(db)

  const createdAt = Date.now()
  const stamp = timestampForFilename(createdAt)
  const fileName = `${stamp}-${campaignId}.sqlite`
  const filePath = path.join(f.backupsDir, fileName)

  try {
    db.exec('PRAGMA wal_checkpoint(FULL)')
  } catch {
    // Database may not be using WAL journaling.
  }

  db.exec(`VACUUM INTO '${escapeSqlString(filePath)}'`)
  const stat = await fs.stat(filePath)

  const manifest = {
    createdAt,
    campaignId,
    campaignName: meta?.name || '',
    databaseFile: 'campaign.sqlite',
    backupFile: fileName,
    bytes: stat.size,
  }
  const manifestFileName = `${stamp}-${campaignId}.json`
  const manifestPath = path.join(f.backupsDir, manifestFileName)
  await writeJson(manifestPath, manifest)

  return {
    fileName,
    filePath,
    manifestFileName,
    manifestPath,
    bytes: stat.size,
    createdAt,
  }
}

export async function listCampaigns() {
  await fs.mkdir(CAMPAIGNS_DIR, { recursive: true })
  const items = await fs.readdir(CAMPAIGNS_DIR, { withFileTypes: true })
  const out = []
  for (const it of items) {
    if (!it.isDirectory()) continue
    // Skip backup/snapshot directories so they don't appear as ghost campaigns in UI.
    if (/\.pre-sync-\d+$/.test(it.name) || /^backup-clear-\d+$/.test(it.name)) continue

    const metaPath = path.join(CAMPAIGNS_DIR, it.name, 'meta.json')
    const meta = await readJson(metaPath, null)
    if (!meta || !meta.id || !meta.name) continue
    out.push(meta)
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

export async function getCampaignState(campaignId) {
  const { base } = await ensureCampaignDirs(campaignId)

  // Load SQL-primary stores and all campaign documents in parallel.
  const [
    storyJournalDoc,
    journalEntries,
    bardsTales,
    canon,
    npcs,
    quests,
    quotes,
    pcs,
    gameSessions,
    approvals,
    lexicon,
    places,
    dmSneakPeek,
    dmNotesDoc,
  ] = await Promise.all([
    loadCampaignDocument(campaignId, base, 'storyJournal'),
    loadJournalEntriesSqlPrimary(campaignId, base),
    loadBardTalesSqlPrimary(campaignId, base),
    loadCanonicalStoresSqlPrimary(campaignId, base),
    loadCampaignDocument(campaignId, base, 'npcs'),
    loadCampaignDocument(campaignId, base, 'quests'),
    loadCampaignDocument(campaignId, base, 'quotes'),
    loadCampaignDocument(campaignId, base, 'pcs'),
    loadCampaignDocument(campaignId, base, 'gameSessions'),
    loadCampaignDocument(campaignId, base, 'approvals'),
    loadCampaignDocument(campaignId, base, 'lexicon'),
    loadCampaignDocument(campaignId, base, 'places'),
    loadCampaignDocument(campaignId, base, 'dmSneakPeek'),
    loadCampaignDocument(campaignId, base, 'dmNotes'),
  ])

  const storyJournalEntries = storyJournalDoc?.entries || []
  const journalById = new Map(journalEntries.map((j) => [String(j?.id || ''), j]))
  const bardsTalesWithState = bardsTales.map((t) => {
    const j = journalById.get(String(t?.journalEntryId || ''))
    const currentHash = j ? sourceHashForText(String(j?.markdown || '')) : null
    const sourceHash = String(t?.sourceHash || '')
    return {
      ...t,
      isStale: !!(currentHash && sourceHash && currentHash !== sourceHash),
    }
  })

  return {
    npcs,
    quests,
    quotes,
    journal: journalEntries,
    storyJournal: storyJournalEntries,
    pcs,
    gameSessions,
    approvals,
    lexicon,
    lexiconEntities: canon.entities,
    entityAliases: canon.aliases,
    trackerRows: canon.trackerRows,
    places,
    bardsTales: bardsTalesWithState,
    dmSneakPeek,
    dmNotes: dmNotesDoc?.text || '',
  }
}

export async function listCampaignSessions(campaignId) {
  const state = await getCampaignState(campaignId)
  return (state.gameSessions || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

export async function upsertGameSession(campaignId, { gameSessionId, newGameSessionTitle, newGameSessionNumber, newGameSessionLabel }) {
  const { base } = await ensureCampaignDirs(campaignId)
  const sessions = await loadCampaignDocument(campaignId, base, 'gameSessions')

  if (gameSessionId) {
    const found = sessions.find((s) => s.id === gameSessionId)
    if (!found) throw new Error('gameSessionId not found')
    return found
  }

  const rawNumber = String(newGameSessionNumber ?? newGameSessionTitle ?? '').trim()
  if (!rawNumber) throw new Error('Provide gameSessionId or newGameSessionNumber')
  const numMatch = rawNumber.match(/(\d+)/)
  if (!numMatch) throw new Error('Session number required')
  const title = String(Number(numMatch[1]))
  const label = String(newGameSessionLabel || '').trim()
  const created = {
    id: `${slugify(`session-${title}`)}-${crypto.randomUUID().slice(0, 6)}`,
    title,
    number: Number(title),
    label,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceCount: 0,
  }
  sessions.push(created)
  await persistCampaignDocument(campaignId, base, 'gameSessions', sessions)
  return created
}

export async function addSourceToGameSession(campaignId, gameSessionId, sourceInfo) {
  const { base } = await ensureCampaignDirs(campaignId)
  const sessions = await loadCampaignDocument(campaignId, base, 'gameSessions')
  const idx = sessions.findIndex((s) => s.id === gameSessionId)
  if (idx === -1) return
  sessions[idx].sourceCount = (sessions[idx].sourceCount || 0) + 1
  sessions[idx].updatedAt = Date.now()
  sessions[idx].lastSource = sourceInfo
  await persistCampaignDocument(campaignId, base, 'gameSessions', sessions)
}

export function normalizeNpcName(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\b(count|lord|lady|sir|ser|mr|mrs|ms|dr)\b/g, '')
    .replace(/\b(von|van|de|du|the)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function npcNameVariants(name = '') {
  const base = String(name || '').trim()
  const n = normalizeNpcName(base)
  const variants = new Set([n])
  return Array.from(variants).filter(Boolean)
}

export function resolveCanonicalName(inputName = '', canonicalNames = []) {
  const input = String(inputName || '').trim()
  if (!input) return { name: '', matched: false }
  const lower = input.toLowerCase()
  const exact = canonicalNames.find((n) => String(n || '').toLowerCase() === lower)
  if (exact) return { name: exact, matched: true }

  const inVars = new Set(npcNameVariants(input))
  for (const c of canonicalNames) {
    const cVars = new Set(npcNameVariants(c))
    const overlap = [...inVars].some((v) => cVars.has(v))
    if (overlap) return { name: c, matched: true }
  }

  return { name: input, matched: false }
}

const BARD_PROMPT_VERSION = 'bard-v1'

const BARD_PERSONAS = {
  grandiose: {
    id: 'grandiose',
    displayName: 'The Grandiose Lutenist',
    bardName: 'Milo Thrice-Stabbed',
    styleBlock: 'Speak with epic grandeur, noble cadence, and heroic emphasis. Favor sweeping phrasing and dramatic momentum.',
  },
  drunken: {
    id: 'drunken',
    displayName: 'The Drunken Tavern Fool',
    bardName: 'Bramble Alebelly',
    styleBlock: 'Sound lively, rowdy, and slightly disreputable. Favor humor, tavern energy, and playful irreverence without losing the facts.',
  },
  grim: {
    id: 'grim',
    displayName: 'The Grim Chronicler',
    bardName: 'Sister Ash',
    styleBlock: 'Use somber, ominous language with a heavy sense of dread and fate. Emphasize danger, sacrifice, and foreboding.',
  },
  hymnist: {
    id: 'hymnist',
    displayName: 'The Sanctimonious Hymnist',
    bardName: 'Brother Candlewick',
    styleBlock: 'Speak as though delivering a moral ballad. Use reverent, judgmental, sermon-like phrasing with spiritual weight.',
  },
  replacement7: {
    id: 'replacement7',
    displayName: 'The Replacement Bard #7',
    bardName: 'Tobble, Last-Minute Hire',
    styleBlock: 'Sound earnest, underqualified, and oddly specific. Lean into awkward delivery, selective emphasis, and accidental comedy while preserving the facts.',
  },
}

const FAITHFULNESS_RULES = {
  close: `- Stay close to the journal entry.\n- Preserve structure and order where possible.\n- Use light stylistic flair only.\n- Do not heighten emotions beyond what is already implied.`,
  dramatic: `- Preserve all core facts, but use moderate dramatic flourish.\n- You may compress or slightly reorder details for flow.\n- Emphasize emotional beats and tension.\n- Do not add new facts, characters, items, or events.`,
  performance: `- Preserve all core facts, but tell them with full theatrical energy.\n- You may strongly heighten tone, rhythm, and emotional emphasis.\n- You may compress and reorder for performance flow.\n- Do not add new facts, characters, items, or events.`,
}

export function normalizeSourceForHash(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function sourceHashForText(text = '') {
  return crypto.createHash('sha256').update(normalizeSourceForHash(text), 'utf8').digest('hex')
}

export function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))))
}

export function parityHashRows(rows = [], keyFn = (x) => x) {
  const payload = (Array.isArray(rows) ? rows : []).map(keyFn).sort()
  return sourceHashForText(JSON.stringify(payload))
}

export function extractJson(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        return fallback
      }
    }
    return fallback
  }
}

export function buildFallbackJournal(cleanedTranscript = '', timeline = []) {
  const excerpt = String(cleanedTranscript || '')
    .trim()
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 80)
    .join('\n')

  const timelineBlock = Array.isArray(timeline) && timeline.length
    ? `\n\n## Session Timeline\n${timeline.map((t, i) => `${i + 1}. ${String(t).trim()}`).join('\n')}`
    : ''

  return [
    '## Session Journal (Fallback Draft)',
    'Structured journal generation returned empty output. This fallback draft was built from transcript content so review is never blank.',
    timelineBlock,
    '\n\n## Transcript Excerpt',
    excerpt || '(No transcript excerpt available.)',
  ].join('\n').trim()
}

export async function ollamaGenerate(prompt) {
  const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(180000),
  })
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`)
  const j = await r.json()
  return j.response || ''
}

export async function openaiGenerate(prompt, modelOverride = null) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured')
  const model = modelOverride || LLM_MODEL
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  }

  // Try Chat Completions first (works for many models).
  const chatResp = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(180000),
  })

  if (chatResp.ok) {
    const j = await chatResp.json()
    return j?.choices?.[0]?.message?.content || ''
  }

  // Fallback to Responses API for models exposed there (ex: chat-latest variants).
  const resp = await fetch(`${OPENAI_BASE}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      input: prompt,
    }),
    signal: AbortSignal.timeout(180000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`OpenAI HTTP ${resp.status}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }

  const jr = await resp.json()
  const outText = typeof jr?.output_text === 'string' ? jr.output_text : ''
  if (outText) return outText

  const pieces = []
  for (const item of (jr?.output || [])) {
    for (const c of (item?.content || [])) {
      if (typeof c?.text === 'string') pieces.push(c.text)
    }
  }
  return pieces.join('\n').trim()
}

export async function anthropicGenerate(prompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured')

  let attempt = 0
  let lastErr = null

  while (attempt <= ANTHROPIC_RETRY_MAX) {
    attempt += 1

    const now = Date.now()
    if (anthropicNextAllowedAt > now) {
      await sleep(anthropicNextAllowedAt - now)
    }

    const r = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 4096,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(180000),
    })

    if (r.ok) {
      anthropicNextAllowedAt = Date.now() + ANTHROPIC_MIN_GAP_MS
      const j = await r.json()
      const txt = (j?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
      return txt || ''
    }

    if (r.status === 429 && attempt <= ANTHROPIC_RETRY_MAX) {
      const retryAfterHeader = Number(r.headers.get('retry-after') || 0)
      const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : (ANTHROPIC_RETRY_BASE_MS * (2 ** (attempt - 1))) + Math.floor(Math.random() * 400)
      anthropicNextAllowedAt = Date.now() + Math.max(retryAfterMs, ANTHROPIC_MIN_GAP_MS)
      await sleep(Math.max(retryAfterMs, ANTHROPIC_MIN_GAP_MS))
      lastErr = new Error(`Anthropic HTTP 429 (retry ${attempt}/${ANTHROPIC_RETRY_MAX})`)
      continue
    }

    const body = await r.text().catch(() => '')
    throw new Error(`Anthropic HTTP ${r.status}${body ? `: ${body.slice(0, 240)}` : ''}`)
  }

  throw lastErr || new Error('Anthropic HTTP 429 after retries')
}

export async function geminiGenerate(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured')
  const model = String(LLM_MODEL || 'gemini-2.5-flash').trim()
  const r = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: String(prompt || '') }] }],
      generationConfig: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(180000),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Gemini HTTP ${r.status}${body ? `: ${body.slice(0, 240)}` : ''}`)
  }
  const j = await r.json()
  const txt = (j?.candidates || [])
    .flatMap((c) => c?.content?.parts || [])
    .map((p) => String(p?.text || ''))
    .filter(Boolean)
    .join('\n')
  return txt || ''
}

// ── ASR transcription helpers ────────────────────────────────────────────────

// Parse retry-after delay from a Groq 429 response.
// Prefers the Retry-After header (seconds), then parses "try again in Xm Ys" from the body.
export function parseGroqRetryAfter(headers, body) {
  const hdr = headers.get('retry-after') || headers.get('x-ratelimit-reset-requests')
  if (hdr) {
    const secs = Number(hdr)
    if (!Number.isNaN(secs) && secs > 0) return secs * 1000
  }
  // Parse "Please try again in 2m3s" or "in 30s" from error body
  const m = String(body || '').match(/try again in\s+(?:(\d+)m\s*)?(\d+(?:\.\d+)?s?)/i)
  if (m) {
    const mins = m[1] ? parseInt(m[1], 10) : 0
    const secs = m[2] ? parseFloat(m[2]) : 0
    const ms = (mins * 60 + secs) * 1000
    if (ms > 0) return ms
  }
  return 60_000 // default: wait 60s
}

// Transcribe a local audio file via Groq Whisper API.
// Returns { text, segments } where segments may be empty.
// Retries automatically on HTTP 429 (rate limit) up to GROQ_RETRY_MAX times.
// Optional onRateLimit(waitSec, attempt, maxAttempts) callback for UI status updates.
// Optional checkCancelled() callback — called every 5s during rate-limit waits; should throw if cancelled.
const GROQ_RETRY_MAX = 4
export async function transcribeViaGroq(filePath, { onRateLimit, checkCancelled } = {}) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not configured')
  let attempt = 0
  while (true) {
    attempt++
    const fileData = await fs.readFile(filePath)
    const formData = new FormData()
    formData.append('file', new Blob([fileData]), path.basename(filePath))
    formData.append('model', GROQ_WHISPER_MODEL)
    formData.append('language', 'en')
    formData.append('response_format', 'verbose_json')
    const r = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: formData,
      signal: AbortSignal.timeout(300000),
    })
    if (r.status === 429 && attempt <= GROQ_RETRY_MAX) {
      const body = await r.text().catch(() => '')
      const waitMs = parseGroqRetryAfter(r.headers, body)
      const waitSec = Math.round(waitMs / 1000)
      console.warn(`[groq] rate-limited on attempt ${attempt}/${GROQ_RETRY_MAX}, waiting ${waitSec}s before retry…`)
      if (onRateLimit) onRateLimit(waitSec, attempt, GROQ_RETRY_MAX)
      // Wait in 5-second slices so cancellation is checked frequently
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline) {
        if (checkCancelled) checkCancelled()
        await new Promise((res) => setTimeout(res, Math.min(5000, deadline - Date.now())))
      }
      continue
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`Groq ASR HTTP ${r.status}${body ? `: ${body.slice(0, 240)}` : ''}`)
    }
    const j = await r.json()
    return { text: String(j?.text || '').trim(), segments: Array.isArray(j?.segments) ? j.segments : [] }
  }
}

// Transcribe a local audio file via OpenAI Whisper API.
export async function transcribeViaOpenAi(filePath) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured')
  const fileData = await fs.readFile(filePath)
  const formData = new FormData()
  formData.append('file', new Blob([fileData]), path.basename(filePath))
  formData.append('model', 'whisper-1')
  formData.append('language', 'en')
  formData.append('response_format', 'verbose_json')
  const r = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
    signal: AbortSignal.timeout(300000),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`OpenAI ASR HTTP ${r.status}${body ? `: ${body.slice(0, 240)}` : ''}`)
  }
  const j = await r.json()
  return { text: String(j?.text || '').trim(), segments: Array.isArray(j?.segments) ? j.segments : [] }
}

// Split audio into time-based chunks locally, transcribe each, return merged text + segments.
// Used by both groq and openai providers (both have 25MB file limit).
// checkCancelled() is called before each chunk — should throw if the job was cancelled.
export async function transcribeAudioApiChunked(localPath, totalSecs, onChunkProgress, transcribeFn, { checkCancelled } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dnd-asr-'))
  try {
    const totalChunks = Math.max(1, Math.ceil(totalSecs / CHUNK_SECONDS))
    const chunkTexts = []
    const chunkSegments = []

    for (let idx = 0; idx < totalChunks; idx++) {
      if (checkCancelled) checkCancelled()
      const startSec = idx * CHUNK_SECONDS
      const chunkFile = path.join(tmpDir, `chunk_${idx}.mp3`)
      // ffmpeg locally: extract chunk at 16kHz mono mp3
      await run('ffmpeg', [
        '-y', '-v', 'error',
        '-ss', String(startSec),
        '-i', localPath,
        '-t', String(CHUNK_SECONDS),
        '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame',
        chunkFile,
      ])

      const result = await transcribeFn(chunkFile)
      if (result.text) chunkTexts.push(result.text)
      for (const seg of result.segments) {
        const segText = String(seg?.text || '').trim()
        if (!segText) continue
        chunkSegments.push({
          start: startSec + Number(seg?.start || 0),
          end: startSec + Number(seg?.end || 0),
          text: segText,
        })
      }
      onChunkProgress(idx + 1, totalChunks)
    }
    return { text: chunkTexts.join('\n\n'), segments: chunkSegments }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function llmGenerate(prompt, cfg = null) {
  const provider = (cfg?.provider) || LLM_PROVIDER
  const model = (cfg?.model) || LLM_MODEL
  try {
    if (provider === 'openai') return await openaiGenerate(prompt, model)
    if (provider === 'anthropic') return await anthropicGenerate(prompt)
    if (provider === 'gemini') return await geminiGenerate(prompt)
    return await ollamaGenerate(prompt)
  } catch (e) {
    const msg = e?.name === 'TimeoutError'
      ? `${provider} timeout after 180s (${model})`
      : `${provider} request failed (${model}): ${e?.message || 'unknown error'}`
    throw new Error(msg)
  }
}

export async function llmGeneratePipeline(prompt, cfg = null) {
  // Flexible mode: use currently selected provider/model (or job-captured config).
  if (!PIPELINE_CHATGPT_ONLY) return llmGenerate(prompt, cfg)

  // Legacy compatibility mode: force OpenAI for pipeline.
  try {
    return await openaiGenerate(prompt, PIPELINE_OPENAI_MODEL)
  } catch (e) {
    if (PIPELINE_OPENAI_FALLBACK_MODEL && PIPELINE_OPENAI_FALLBACK_MODEL !== PIPELINE_OPENAI_MODEL) {
      try {
        return await openaiGenerate(prompt, PIPELINE_OPENAI_FALLBACK_MODEL)
      } catch (e2) {
        const msg = `pipeline openai failed primary=${PIPELINE_OPENAI_MODEL} and fallback=${PIPELINE_OPENAI_FALLBACK_MODEL}: ${e2?.message || e?.message || 'unknown error'}`
        throw new Error(msg)
      }
    }
    const msg = e?.name === 'TimeoutError'
      ? `pipeline openai timeout after 180s (${PIPELINE_OPENAI_MODEL})`
      : `pipeline openai request failed (${PIPELINE_OPENAI_MODEL}): ${e?.message || 'unknown error'}`
    throw new Error(msg)
  }
}

export async function llmGeneratePipelineWithFallback(prompt, job, stage = 'pipeline') {
  const cfg = job?.llmConfig || null
  const provider = cfg?.provider || LLM_PROVIDER
  const model = cfg?.model || LLM_MODEL
  try {
    return await llmGeneratePipeline(prompt, cfg)
  } catch (e) {
    const msg = String(e?.message || '')
    const isAnthropic429 = provider === 'anthropic' && /Anthropic HTTP 429/i.test(msg)
    if (!isAnthropic429) throw e

    // Auto-fallback provider path after Anthropic rate-limit exhaustion.
    if (OPENAI_API_KEY) {
      const fallbackModel = PIPELINE_OPENAI_FALLBACK_MODEL || PIPELINE_OPENAI_MODEL || 'gpt-4o-mini'
      const out = await openaiGenerate(prompt, fallbackModel)
      job.pipelineFallback = {
        triggeredAt: Date.now(),
        stage,
        from: `anthropic/${model}`,
        to: `openai/${fallbackModel}`,
        reason: msg,
      }
      return out
    }

    const out = await ollamaGenerate(prompt)
    job.pipelineFallback = {
      triggeredAt: Date.now(),
      stage,
      from: `anthropic/${model}`,
      to: `ollama/${model}`,
      reason: msg,
    }
    return out
  }
}

export function pipelineReviewerMeta(job = null) {
  const provider = job?.llmConfig?.provider || LLM_PROVIDER
  const model = job?.llmConfig?.model || LLM_MODEL
  if (PIPELINE_CHATGPT_ONLY) {
    return { reviewerProvider: 'openai', reviewerModel: PIPELINE_OPENAI_MODEL }
  }
  return { reviewerProvider: provider, reviewerModel: model }
}

export function estimateEtaSec(job) {
  if (!job.totalChunks || !job.startedAt || !job.doneChunks) return null
  const elapsedSec = Math.max(1, Math.floor((Date.now() - job.startedAt) / 1000))
  const avgPerChunk = elapsedSec / Math.max(1, job.doneChunks)
  const remaining = Math.max(0, job.totalChunks - job.doneChunks)
  return Math.ceil(avgPerChunk * remaining)
}

export function assertNotCancelled(job) {
  if (job?.cancelRequested) {
    const err = new Error('Job cancelled by user')
    err.code = 'JOB_CANCELLED'
    throw err
  }
}

export function fmtClock(sec = 0) {
  const s = Math.max(0, Math.floor(Number(sec || 0)))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export function speakerTranscriptFromMergedLines(lines = []) {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => {
      const spk = String(l?.speaker || 'U').trim() || 'U'
      const t = fmtClock(Number(l?.start || 0))
      const txt = String(l?.text || '').trim()
      if (!txt) return ''
      return `${spk} ${t} ${txt}`
    })
    .filter(Boolean)
    .join('\n')
}

export async function diarizeSegmentsGuess(segments = []) {
  if (!Array.isArray(segments) || segments.length === 0) return ''

  const out = []
  const batchSize = 80
  for (let start = 0; start < segments.length; start += batchSize) {
    const batch = segments.slice(start, start + batchSize)
    const batchText = batch
      .map((s, i) => `${i}|${fmtClock(s.start)}|${String(s.text || '').replace(/\n/g, ' ').trim()}`)
      .join('\n')

    let labels = []
    try {
      const raw = await llmGeneratePipeline(
        `Assign speaker labels to transcript lines. Use only speaker values: S1, S2, S3, S4, S5, U.
Return STRICT JSON only: {"labels":[{"i":0,"speaker":"S1"}]}
No markdown, no explanations.

Lines:
${batchText}`,
      )
      labels = extractJson(raw, { labels: [] }).labels || []
    } catch {
      labels = []
    }

    const labelMap = new Map(
      labels
        .map((x) => [Number(x?.i), String(x?.speaker || 'U').toUpperCase()])
        .filter(([i]) => Number.isFinite(i)),
    )

    for (let i = 0; i < batch.length; i += 1) {
      const seg = batch[i]
      const sp = labelMap.get(i) || 'U'
      const normalized = /^S[1-5]$/.test(sp) ? sp : 'U'
      out.push(`${normalized} ${fmtClock(seg.start)} ${String(seg.text || '').trim()}`)
    }
  }

  return out.join('\n')
}

export async function canonContext(campaignId) {
  const s = await getCampaignState(campaignId)
  const lex = (s.lexicon || []).slice(0, 200).map((x) => `- ${x.term}${x.kind ? ` (${x.kind})` : ''}${x.aliases?.length ? ` aliases: ${x.aliases.join(', ')}` : ''}`)
  const places = (s.places || []).slice(0, 200).map((p) => `- ${p.name}${p.type ? ` (${p.type})` : ''}${p.notes ? `: ${p.notes}` : ''}`)
  const pcs = (s.pcs || []).slice(0, 100).map((p) => `- ${p.characterName || p.name}${p.playerName ? ` [player: ${p.playerName}]` : ''} (${p.race || 'race?'}, ${p.class || 'class?'}, lvl ${p.level || 1})`)
  const dm = s.dmNotes ? `DM Notes:\n${s.dmNotes}\n` : ''
  return `Canon Terms:\n${lex.join('\n') || '- none'}\n\nPlaces:\n${places.join('\n') || '- none'}\n\nPlayer Characters:\n${pcs.join('\n') || '- none'}\n\n${dm}`
}

export async function canonLists(campaignId) {
  const s = await getCampaignState(campaignId)
  return {
    npcNames: (s.npcs || []).map((n) => String(n.name || '').trim()).filter(Boolean),
    placeNames: (s.places || []).map((p) => String(p.name || '').trim()).filter(Boolean),
    questNames: (s.quests || []).map((q) => String(q.name || '').trim()).filter(Boolean),
    pcNames: (s.pcs || []).map((p) => String(p.characterName || p.name || '').trim()).filter(Boolean),
    lexTerms: (s.lexicon || []).map((l) => String(l.term || '').trim()).filter(Boolean),
  }
}

export function buildNumberedTranscript(raw = '') {
  const lines = String(raw || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((text, idx) => ({ id: `line_${idx + 1}`, idx: idx + 1, text }))

  return {
    lines,
    text: lines.map((l) => `${l.id} ${l.text}`).join('\n'),
    evidenceIds: new Set(lines.map((l) => l.id)),
  }
}

export function normalizeEvidenceList(value) {
  if (!Array.isArray(value)) return []
  return value.map((x) => String(x || '').trim()).filter(Boolean)
}

export function quoteAppearsInRaw(quote = '', raw = '') {
  const q = String(quote || '').trim()
  if (!q) return false
  const hay = String(raw || '')
  if (hay.includes(q)) return true
  const normalize = (s) => String(s || '').toLowerCase().replace(/[“”"'`]/g, '').replace(/\s+/g, ' ').trim()
  return normalize(hay).includes(normalize(q))
}

export function dedupeBySummary(items = [], keyFn = (x) => x) {
  const out = []
  const seen = new Set()
  for (const item of (Array.isArray(items) ? items : [])) {
    const key = String(keyFn(item) || '').toLowerCase().trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export async function queueApproval(campaignId, proposal) {
  const { base } = await ensureCampaignDirs(campaignId)
  const approvals = await loadCampaignDocument(campaignId, base, 'approvals')
  approvals.push(proposal)
  await persistCampaignDocument(campaignId, base, 'approvals', approvals)
}

export async function applyApprovedProposal(campaignId, proposalId) {
  const { base } = await ensureCampaignDirs(campaignId)
  const f = filesForCampaign(base)

  const approvals = await loadCampaignDocument(campaignId, base, 'approvals')
  const p = approvals.find((x) => x.id === proposalId)
  if (!p) throw new Error('Proposal not found')
  if (p.status !== 'pending') throw new Error('Proposal already processed')

  const state = await getCampaignState(campaignId)

  const npcMap = new Map(state.npcs.map((n) => [String(n.name || '').toLowerCase(), n]))
  for (const n of p.npcUpdates || []) {
    const incomingName = String(n.name || '').trim()
    const rawKey = incomingName.toLowerCase()
    if (!rawKey) continue

    // Canonical match: exact lower-case key, then strict normalized full-name match (including aliases).
    let matchKey = npcMap.has(rawKey) ? rawKey : null
    if (!matchKey) {
      const incomingNorm = normalizeNpcName(incomingName)
      for (const [k, existing] of npcMap.entries()) {
        const candidateNorms = new Set([
          normalizeNpcName(existing?.name || ''),
          ...((existing?.aliases || []).map((a) => normalizeNpcName(a))),
        ])
        if (candidateNorms.has(incomingNorm)) {
          matchKey = k
          break
        }
      }
    }

    const key = matchKey || rawKey
    const prev = npcMap.get(key) || {}
    const aliases = new Set([...(prev.aliases || [])])
    if (incomingName && incomingName.toLowerCase() !== String(prev.name || '').toLowerCase()) aliases.add(incomingName)

    npcMap.set(key, {
      ...prev,
      ...n,
      name: prev.name || incomingName,
      aliases: Array.from(aliases),
      sourceType: p.sourceType || prev.sourceType || 'unknown',
      sourceId: p.sourceId || prev.sourceId || null,
      updatedAt: Date.now(),
    })
  }

  const questMap = new Map(state.quests.map((q) => [String(q.name || '').toLowerCase(), q]))
  const canon = await ensureCanonicalStores(campaignId, state)
  const entityByTerm = new Map((canon.entities || []).map((e) => [normalizeLexTerm(e?.canonicalTerm || ''), e]))
  const trackerRows = Array.isArray(canon.trackerRows) ? canon.trackerRows : []

  for (const q of p.questUpdates || []) {
    const name = String(q.name || '').trim()
    const key = name.toLowerCase()
    if (!key) continue

    const nextQuest = { ...questMap.get(key), ...q, updatedAt: Date.now() }
    questMap.set(key, nextQuest)

    const norm = normalizeLexTerm(name)
    let entity = entityByTerm.get(norm)
    if (!entity) {
      entity = makeCanonicalEntity({
        campaignId,
        term: name,
        entityType: 'quest',
        legacy: {
          aliases: Array.isArray(q.aliases) ? q.aliases : [],
          notes: String(q.notes || '').trim(),
          data: parseQuestDataFromLegacy(q),
        },
        source: {
          createdBy: 'ai',
          lastUpdatedBy: 'ai',
          lastSourceType: String(p.sourceType || '').trim(),
          lastSourceId: String(p.sourceId || '').trim(),
        },
      })
      canon.entities.push(entity)
      entityByTerm.set(norm, entity)
    } else {
      entity.data = {
        ...(entity.data || {}),
        ...parseQuestDataFromLegacy(q),
      }
      entity.notes = String(q.notes || entity.notes || '').trim()
      entity.lastUpdatedBy = 'ai'
      entity.lastSourceType = String(p.sourceType || entity.lastSourceType || '').trim()
      entity.lastSourceId = String(p.sourceId || entity.lastSourceId || '').trim() || entity.lastSourceId || null
      entity.updatedAt = Date.now()
    }

    const row = trackerRows.find((r) => String(r?.trackerType || '') === 'quest' && String(r?.entityId || '') === String(entity.id))
    const snapshot = {
      status: String(entity?.data?.status || nextQuest.status || '').trim() || 'Unknown',
      subtitle: String(entity?.data?.objective || entity?.data?.latestUpdate || nextQuest.update || '').trim(),
    }
    if (row) {
      row.snapshot = snapshot
      row.updatedAt = Date.now()
      row.linkMethod = row.linkMethod || 'exact-term'
      row.linkConfidence = row.linkConfidence == null ? 1 : row.linkConfidence
    } else {
      trackerRows.push({
        id: crypto.randomUUID(),
        campaignId,
        trackerType: 'quest',
        entityId: entity.id,
        snapshot,
        linkMethod: 'exact-term',
        linkConfidence: 1,
        updatedAt: Date.now(),
      })
    }
  }

  const existingQuotes = new Set(state.quotes.map((q) => String(q.text || q)))
  const mergedQuotes = [...state.quotes]
  for (const q of p.quotes || []) {
    const text = typeof q === 'string' ? q : q?.text
    if (!text || existingQuotes.has(text)) continue
    existingQuotes.add(text)
    mergedQuotes.push({ text, createdAt: Date.now(), gameSessionId: p.gameSessionId, sourceId: p.sourceId })
  }

  const journalEntry = {
    id: p.id,
    title: p.gameSessionTitle,
    createdAt: p.createdAt,
    markdown: p.journal || '',
    gameSessionId: p.gameSessionId,
    sourceId: p.sourceId,
    sourceType: p.sourceType || '',
  }

  const sourceType = String(p.sourceType || '')
  const shouldWriteJournal = new Set(['audio', 'transcript']).has(sourceType) && String(p.journal || '').trim().length > 0

  const journalEntries = shouldWriteJournal
    ? ([...(state.journal || []), journalEntry])
    : (state.journal || [])

  const storyEligible = new Set(['audio', 'transcript'])
  const storyJournalEntries = shouldWriteJournal && storyEligible.has(sourceType)
    ? ([...(state.storyJournal || []), journalEntry])
    : (state.storyJournal || [])

  const lexMap = new Map((state.lexicon || []).map((l) => [normalizeLexTerm(l.term || ''), l]))
  for (const l of p.lexiconAdds || []) {
    upsertLexiconEntry(lexMap, {
      term: l.term,
      kind: l.kind,
      aliases: l.aliases,
      notes: l.notes,
    })
  }

  for (const n of Array.from(npcMap.values())) {
    upsertLexiconEntry(lexMap, {
      term: n.name,
      kind: 'npc',
      role: n.role || '',
      relation: n.relation || '',
      aliases: n.aliases || [],
      notes: String(n.notes || n.update || '').trim(),
    })
  }

  for (const q of Array.from(questMap.values())) {
    upsertLexiconEntry(lexMap, {
      term: q.name,
      kind: 'quest',
      aliases: q.aliases || [],
      notes: [q.status, q.update].filter(Boolean).join(' • '),
    })
  }

  const placeMap = new Map((state.places || []).map((pl) => [String(pl.name || '').toLowerCase(), pl]))
  for (const pl of p.placeAdds || []) {
    const key = String(pl.name || '').toLowerCase()
    if (!key) continue
    placeMap.set(key, { ...placeMap.get(key), ...pl, updatedAt: Date.now(), id: placeMap.get(key)?.id || crypto.randomUUID() })
  }

  for (const pl of Array.from(placeMap.values())) {
    upsertLexiconEntry(lexMap, {
      term: pl.name,
      kind: pl.type || 'place',
      aliases: pl.tags || [],
      notes: pl.notes || '',
    })
  }

  await persistCampaignDocument(campaignId, base, 'npcs', Array.from(npcMap.values()))
  await persistCampaignDocument(campaignId, base, 'quests', Array.from(questMap.values()))
  await persistCampaignDocument(campaignId, base, 'quotes', mergedQuotes)
  await persistCampaignDocument(campaignId, base, 'lexicon', Array.from(lexMap.values()))
  await persistCanonicalStoresSqlPrimary(campaignId, base, { entities: canon.entities || [], aliases: canon.aliases || [], trackerRows })
  await persistCampaignDocument(campaignId, base, 'places', Array.from(placeMap.values()))
  await persistJournalEntriesSqlPrimary(campaignId, base, journalEntries)
  await persistCampaignDocument(campaignId, base, 'storyJournal', { entries: storyJournalEntries.slice(-300) })

  if (p.dmNotes && String(p.dmNotes).trim()) {
    const existingDm = await loadCampaignDocument(campaignId, base, 'dmNotes')
    const mergedDm = [existingDm.text || '', `\n\n[Imported ${new Date().toISOString()}]\n${String(p.dmNotes).trim()}`].join('').trim()
    await persistCampaignDocument(campaignId, base, 'dmNotes', { text: mergedDm, updatedAt: Date.now() })
  }

  const rawSessionFile = path.join(f.rawSessionsDir, `${Date.now()}-${p.id}.json`)
  await writeJson(rawSessionFile, p)

  for (const a of approvals) {
    if (a.id === proposalId) {
      a.status = 'approved'
      a.decidedAt = Date.now()
    }
  }
  await persistCampaignDocument(campaignId, base, 'approvals', approvals)
}

export async function rejectProposal(campaignId, proposalId) {
  const { base } = await ensureCampaignDirs(campaignId)
  const approvals = await loadCampaignDocument(campaignId, base, 'approvals')
  for (const a of approvals) {
    if (a.id === proposalId) {
      a.status = 'rejected'
      a.decidedAt = Date.now()
    }
  }
  await persistCampaignDocument(campaignId, base, 'approvals', approvals)
}

export async function runLLMStages(job) {
  assertNotCancelled(job)
  const transcript = job.transcript || ''
  const canon = await canonContext(job.campaignId)
  const canonNames = await canonLists(job.campaignId)
  const canonGuard = `CANON LOCK (STRICT):
- Do NOT invent new proper nouns.
- Prefer exact spellings from canon lists.
- If uncertain, keep transcript wording and mark as UNKNOWN.

Known NPCs:
${canonNames.npcNames.join(', ') || 'none'}
Known Places:
${canonNames.placeNames.join(', ') || 'none'}
Known Quests:
${canonNames.questNames.join(', ') || 'none'}
Known PCs:
${canonNames.pcNames.join(', ') || 'none'}
Known Terms:
${canonNames.lexTerms.join(', ') || 'none'}`

  if (!String(job.speakerTranscript || '').trim()) {
    job.stage = 'speaker diarization (guess)'
    job.progressPct = Math.max(job.progressPct, 80)
    job.etaSec = 180
    try {
      job.speakerTranscript = await diarizeSegmentsGuess(job.rawSegments || [])
    } catch {
      job.speakerTranscript = ''
    }
  }

  const transcriptForLLM = job.speakerTranscript || transcript
  const numbered = buildNumberedTranscript(transcriptForLLM)

  // Pass 0: normalize + scene segmentation + content-mode classification
  assertNotCancelled(job)
  job.stage = 'pass 0 normalization'
  job.progressPct = Math.max(job.progressPct, 84)
  job.etaSec = 120

  const pass0 = extractJson(
    await llmGeneratePipelineWithFallback(`You are preparing a robust extraction pipeline for a D&D transcript.
Return STRICT JSON ONLY with EXACT keys:
{
  "cleanedTranscript": "string",
  "scenes": [{"sceneId":"s1","label":"","evidenceStart":"line_1","evidenceEnd":"line_10","confidence":0.0}],
  "contentModes": [{"lineId":"line_1","mode":"signal|sludge|mixed","reason":"short"}]
}
Rules:
- Use provided line ids exactly.
- Preserve exact facts from transcript.
- No invented nouns.
- Keep output concise.

Canon:
${canon}

${canonGuard}

Raw transcript with immutable line IDs:
${numbered.text}`, job, 'pass0 normalization'),
    { cleanedTranscript: transcriptForLLM, scenes: [], contentModes: [] },
  )

  const cleanedTranscript = String(pass0.cleanedTranscript || transcriptForLLM).trim() || transcriptForLLM
  const sceneList = Array.isArray(pass0.scenes) ? pass0.scenes : []

  await persistPipelineCheckpoint(job, 'pass0-normalization', {
    cleanedTranscript,
    scenes: sceneList,
    contentModes: Array.isArray(pass0.contentModes) ? pass0.contentModes : [],
  })

  // Pass 1: candidate extraction only
  assertNotCancelled(job)
  job.stage = 'pass 1 candidate extraction'
  job.progressPct = Math.max(job.progressPct, 88)
  job.etaSec = 100

  const pass1 = extractJson(
    await llmGeneratePipelineWithFallback(`Extract candidates from this D&D transcript.
Return STRICT JSON ONLY with EXACT keys:
{
  "cleanedTranscript":"string",
  "scenes":[{"sceneId":"s1","label":"","evidenceStart":"line_1","evidenceEnd":"line_10","confidence":0.0}],
  "eventCandidates":[{"id":"e1","sceneId":"s1","type":"discovery|combat|social|travel|decision|reveal|loot|downtime","summary":"","evidence":["line_1"],"participants":[""],"stakes":"low|medium|high","confidence":0.0}],
  "quoteCandidates":[{"id":"q1","text":"","speakerRaw":"","sceneId":"s1","evidence":["line_1"],"tone":"comic|dramatic|tense|neutral","confidence":0.0}],
  "npcCandidates":[{"name":"","role":"","relation":"","update":"","evidence":["line_1"],"confidence":0.0}],
  "questCandidates":[{"name":"","objective":"","reward":"","leads":[""],"status":"Active|Pending|Completed|Blocked","update":"","evidence":["line_1"],"confidence":0.0}],
  "locationCandidates":[{"name":"","type":"","notes":"","evidence":["line_1"],"confidence":0.0}],
  "decisionCandidates":[{"summary":"","decisionMaker":"party|dm|unknown|name","impact":"low|medium|high","evidence":["line_1"],"confidence":0.0}]
}
Rules:
- Candidate extraction only. No recap writing.
- Every candidate must include evidence line IDs.
- Quotes must be exact wording.
- No invented nouns.

Canon:
${canon}

${canonGuard}

Raw transcript with immutable line IDs:
${numbered.text}

Pass 0 output:
${JSON.stringify({ cleanedTranscript, scenes: sceneList, contentModes: pass0.contentModes || [] })}`, job, 'pass1 candidate extraction'),
    {
      cleanedTranscript,
      scenes: sceneList,
      eventCandidates: [],
      quoteCandidates: [],
      npcCandidates: [],
      questCandidates: [],
      locationCandidates: [],
      decisionCandidates: [],
    },
  )

  // Code validation: evidence checks, quote verification, dedupe, canon normalization
  const validEvidence = numbered.evidenceIds

  const validScenes = dedupeBySummary((Array.isArray(pass1.scenes) ? pass1.scenes : []).filter((s) => {
    const start = String(s?.evidenceStart || '').trim()
    const end = String(s?.evidenceEnd || '').trim()
    return validEvidence.has(start) && validEvidence.has(end)
  }), (s) => s.sceneId || `${s.evidenceStart}-${s.evidenceEnd}`)

  const validEvents = dedupeBySummary((Array.isArray(pass1.eventCandidates) ? pass1.eventCandidates : []).filter((e) => {
    const ev = normalizeEvidenceList(e?.evidence)
    return ev.length > 0 && ev.every((id) => validEvidence.has(id)) && String(e?.summary || '').trim().length >= 8
  }), (e) => e.summary)

  // Validate quotes from quoteCandidates — require non-empty text, speaker, and valid evidence
  const validQuotes = dedupeBySummary((Array.isArray(pass1.quoteCandidates) ? pass1.quoteCandidates : []).filter((q) => {
    const ev = normalizeEvidenceList(q?.evidence)
    return String(q?.text || '').trim().length >= 4 &&
      String(q?.speakerRaw || '').trim().length >= 1 &&
      ev.length > 0 && ev.every((id) => validEvidence.has(id))
  }), (q) => q.text)

  const validNpcs = dedupeBySummary((Array.isArray(pass1.npcCandidates) ? pass1.npcCandidates : []).filter((n) => {
    const ev = normalizeEvidenceList(n?.evidence)
    return String(n?.name || '').trim() && ev.length > 0 && ev.every((id) => validEvidence.has(id))
  }), (n) => n.name).map((n) => {
    const resolved = resolveCanonicalName(n?.name || '', canonNames.npcNames)
    return { ...n, name: resolved.name, unresolved: !resolved.matched }
  })

  const validQuests = dedupeBySummary((Array.isArray(pass1.questCandidates) ? pass1.questCandidates : []).filter((q) => {
    const ev = normalizeEvidenceList(q?.evidence)
    return String(q?.name || '').trim() && ev.length > 0 && ev.every((id) => validEvidence.has(id))
  }), (q) => q.name).map((q) => {
    const resolved = resolveCanonicalName(q?.name || '', canonNames.questNames)
    const statusRaw = String(q?.status || '').trim()
    const allowed = new Set(['Active', 'Pending', 'Completed', 'Blocked'])
    return { ...q, name: resolved.name, unresolved: !resolved.matched, status: allowed.has(statusRaw) ? statusRaw : 'Pending' }
  })

  const validLocations = dedupeBySummary((Array.isArray(pass1.locationCandidates) ? pass1.locationCandidates : []).filter((l) => {
    const ev = normalizeEvidenceList(l?.evidence)
    return String(l?.name || '').trim() && ev.length > 0 && ev.every((id) => validEvidence.has(id))
  }), (l) => l.name).map((l) => {
    const resolved = resolveCanonicalName(l?.name || '', canonNames.placeNames)
    return { ...l, name: resolved.name, unresolved: !resolved.matched }
  })

  const validDecisions = dedupeBySummary((Array.isArray(pass1.decisionCandidates) ? pass1.decisionCandidates : []).filter((d) => {
    const ev = normalizeEvidenceList(d?.evidence)
    return String(d?.summary || '').trim() && ev.length > 0 && ev.every((id) => validEvidence.has(id))
  }), (d) => d.summary)

  await persistPipelineCheckpoint(job, 'pass1-validated-candidates', {
    cleanedTranscript: String(pass1.cleanedTranscript || cleanedTranscript).trim() || cleanedTranscript,
    scenes: validScenes,
    events: validEvents,
    npcs: validNpcs,
    quests: validQuests,
    locations: validLocations,
    decisions: validDecisions,
  })

  // Pass 2: ranking + composition from validated candidates (with raw attached to reduce drift)
  assertNotCancelled(job)
  job.stage = 'pass 2 ranking + composition'
  job.progressPct = Math.max(job.progressPct, 93)
  job.etaSec = 70

  const pass2 = extractJson(
    await llmGeneratePipelineWithFallback(`Using only validated candidates, compose DM-facing outputs.
Return STRICT JSON ONLY with EXACT keys:
{
  "topQuotes":[""],
  "rankedEvents":[""],
  "sessionRecap":"",
  "timeline":[""],
  "runningCampaignLog":[""],
  "fullCampaignJournal":""
}
Rules:
- Keep table feel: preserve funny lines, weird schemes, reveals, decisions, emotional beats.
- Drop repetitive rules coaching, device/app chatter, dead-end crosstalk, and generic roll chatter.
- No invented nouns/facts.

Canon:
${canon}

${canonGuard}

Raw transcript:
${transcriptForLLM}

Validated candidates JSON:
${JSON.stringify({
  scenes: validScenes,
  events: validEvents,
  quotes: validQuotes,
  npcs: validNpcs,
  quests: validQuests,
  locations: validLocations,
  decisions: validDecisions,
})}`, job, 'pass2 ranking + composition'),
    {
      topQuotes: [],
      rankedEvents: [],
      sessionRecap: '',
      timeline: [],
      runningCampaignLog: [],
      fullCampaignJournal: '',
    },
  )

  job.cleanedTranscript = String(pass1.cleanedTranscript || cleanedTranscript).trim() || cleanedTranscript
  job.scenes = validScenes
  job.events = validEvents
  job.decisions = validDecisions
  job.locations = validLocations
  job.timeline = Array.isArray(pass2.timeline) ? pass2.timeline.map((x) => String(x).trim()).filter(Boolean) : []
  job.sessionRecap = String(pass2.sessionRecap || '').trim()
  job.runningCampaignLog = Array.isArray(pass2.runningCampaignLog) ? pass2.runningCampaignLog.map((x) => String(x).trim()).filter(Boolean) : []
  job.journal = String(pass2.fullCampaignJournal || '').trim() || buildFallbackJournal(job.cleanedTranscript || transcriptForLLM, job.timeline)
  job.extractionFallback = !String(pass2.fullCampaignJournal || '').trim()

  job.quotes = []

  job.npcUpdates = validNpcs.map((n) => ({
    name: n.name,
    role: String(n.role || '').trim(),
    relation: String(n.relation || '').trim(),
    update: String(n.update || n.notes || '').trim(),
    unresolved: !!n.unresolved,
  }))

  job.questUpdates = validQuests.map((q) => ({
    name: q.name,
    objective: String(q.objective || '').trim(),
    reward: String(q.reward || '').trim(),
    leads: Array.isArray(q.leads) ? q.leads.map((x) => String(x).trim()).filter(Boolean) : [],
    status: q.status,
    update: String(q.update || '').trim(),
    unresolved: !!q.unresolved,
  }))

  await persistPipelineCheckpoint(job, 'pass2-composed-output', {
    timeline: job.timeline,
    sessionRecap: job.sessionRecap,
    runningCampaignLog: job.runningCampaignLog,
    journal: job.journal,
    npcUpdates: job.npcUpdates,
    questUpdates: job.questUpdates,
    extractionFallback: job.extractionFallback,
    pipelineFallback: job.pipelineFallback || null,
  })

  job.stage = 'awaiting approval'
  job.progressPct = 99
  job.etaSec = 5

  const proposalId = crypto.randomUUID()
  job.proposalId = proposalId
  const pipelineMeta = pipelineReviewerMeta(job)
  const proposal = {
    id: proposalId,
    status: 'pending',
    createdAt: Date.now(),
    campaignId: job.campaignId,
    gameSessionId: job.gameSessionId,
    gameSessionTitle: job.gameSessionTitle,
    sourceId: job.sourceId,
    sourceType: job.type,
    sourceLabel: job.sourceLabel,
    file: job.file,
    reviewerProvider: pipelineMeta.reviewerProvider,
    reviewerModel: pipelineMeta.reviewerModel,
    transcript: job.transcript,
    cleanedTranscript: job.cleanedTranscript,
    speakerTranscript: job.speakerTranscript,
    journal: job.journal,
    fullCampaignJournal: job.journal,
    timeline: job.timeline || [],
    sessionRecap: job.sessionRecap || '',
    runningCampaignLog: job.runningCampaignLog || [],
    extractionFallback: !!job.extractionFallback,
    scenes: job.scenes || [],
    events: job.events || [],
    decisions: job.decisions || [],
    locations: job.locations || [],
    npcUpdates: job.npcUpdates,
    questUpdates: job.questUpdates,
    quotes: job.quotes,
  }

  await queueApproval(job.campaignId, proposal)
}

export async function processAudioJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return

  // Capture LLM config at job start so mid-flight settings changes don't affect this run.
  if (!job.llmConfig) job.llmConfig = snapshotLlmConfig()
  // Snapshot ASR provider so a live settings change doesn't alter a running transcription.
  const asrProvider = job.asrProvider ?? (job.asrProvider = ASR_PROVIDER)

  job.status = 'running'
  job.stage = 'preparing'
  job.updatedAt = Date.now()
  job.startedAt = Date.now()

  try {
    assertNotCancelled(job)

    // ── Step 1: get audio duration ───────────────────────────────────────────
    let durationSec
    if (asrProvider === 'remote') {
      await run('ssh', ['-i', SSH_KEY_PATH, `${SSH_USER}@${SSH_HOST}`, `mkdir -p ${REMOTE_AUDIO_DIR} ${REMOTE_OUT_DIR}`])
      job.stage = 'uploading audio'
      await run('scp', ['-i', SSH_KEY_PATH, job.localPath, `${SSH_USER}@${SSH_HOST}:${job.remoteAudioPath}`])
      const probe = await run('ssh', ['-i', SSH_KEY_PATH, `${SSH_USER}@${SSH_HOST}`, `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 ${job.remoteAudioPath}`])
      durationSec = Math.max(1, Math.floor(Number(probe.stdout.trim() || '0')))
    } else {
      // local ffprobe
      const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', job.localPath])
      durationSec = Math.max(1, Math.floor(Number(probe.stdout.trim() || '0')))
    }

    const totalChunks = Math.max(1, Math.ceil(durationSec / CHUNK_SECONDS))
    job.durationSec = durationSec
    job.totalChunks = totalChunks
    job.doneChunks = 0
    job.progressPct = 0

    // ── Step 2: transcribe ───────────────────────────────────────────────────
    let transcript = ''
    let rawSegments = []

    if (asrProvider === 'remote') {
      // SSH path — unchanged original behaviour
      const baseNoExt = `${job.sourceId}`
      const remoteChunkDir = `${REMOTE_OUT_DIR}/${baseNoExt}_chunks`
      await run('ssh', ['-i', SSH_KEY_PATH, `${SSH_USER}@${SSH_HOST}`, `mkdir -p ${remoteChunkDir}`])

      const chunkTexts = []
      for (let idx = 0; idx < totalChunks; idx++) {
        assertNotCancelled(job)
        const startSec = idx * CHUNK_SECONDS
        const chunkBase = `${baseNoExt}_chunk_${idx}`
        const remoteChunkAudio = `${remoteChunkDir}/${chunkBase}.mp3`
        const remoteChunkJson = `${remoteChunkDir}/${chunkBase}.json`

        job.stage = `transcribing chunk ${idx + 1}/${totalChunks}`
        job.currentChunk = idx + 1
        job.updatedAt = Date.now()
        job.etaSec = estimateEtaSec(job)

        const exists = await run('ssh', ['-i', SSH_KEY_PATH, `${SSH_USER}@${SSH_HOST}`, `[ -f ${remoteChunkJson} ] && echo yes || echo no`])
        if (exists.stdout.trim() !== 'yes') {
          await run('ssh', ['-i', SSH_KEY_PATH, `${SSH_USER}@${SSH_HOST}`, `set -e; ffmpeg -y -v error -ss ${startSec} -i ${job.remoteAudioPath} -t ${CHUNK_SECONDS} -ac 1 -ar 16000 -c:a libmp3lame ${remoteChunkAudio}; whisper ${remoteChunkAudio} --model ${WHISPER_MODEL} --device ${WHISPER_DEVICE} --language en --task transcribe --output_format json --output_dir ${remoteChunkDir} >/dev/null 2>&1`])
        }
        const parsedChunk = JSON.parse((await run('ssh', ['-i', SSH_KEY_PATH, `${SSH_USER}@${SSH_HOST}`, `cat ${remoteChunkJson}`])).stdout)
        const text = (parsedChunk.text || '').trim()
        if (text) chunkTexts.push(text)
        if (Array.isArray(parsedChunk.segments)) {
          for (const seg of parsedChunk.segments) {
            const segText = String(seg?.text || '').trim()
            if (!segText) continue
            rawSegments.push({ start: startSec + Number(seg?.start || 0), end: startSec + Number(seg?.end || 0), text: segText })
          }
        }
        job.doneChunks = idx + 1
        job.progressPct = Math.min(80, Math.floor((job.doneChunks / totalChunks) * 80))
        job.etaSec = estimateEtaSec(job)
      }
      transcript = chunkTexts.join('\n\n')

    } else if (asrProvider === 'local') {
      // Local whisper CLI
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dnd-local-asr-'))
      try {
        const chunkTexts = []
        for (let idx = 0; idx < totalChunks; idx++) {
          assertNotCancelled(job)
          const startSec = idx * CHUNK_SECONDS
          const chunkFile = path.join(tmpDir, `chunk_${idx}.mp3`)
          job.stage = `transcribing chunk ${idx + 1}/${totalChunks} (local)`
          job.currentChunk = idx + 1
          job.updatedAt = Date.now()
          job.etaSec = estimateEtaSec(job)

          await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(startSec), '-i', job.localPath, '-t', String(CHUNK_SECONDS), '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', chunkFile])
          await run('whisper', [chunkFile, '--model', WHISPER_MODEL, '--device', WHISPER_DEVICE, '--language', 'en', '--task', 'transcribe', '--output_format', 'json', '--output_dir', tmpDir])

          const jsonFile = chunkFile.replace(/\.mp3$/, '.json')
          const parsedChunk = await readJson(jsonFile, { text: '', segments: [] })
          const text = (parsedChunk.text || '').trim()
          if (text) chunkTexts.push(text)
          for (const seg of (parsedChunk.segments || [])) {
            const segText = String(seg?.text || '').trim()
            if (!segText) continue
            rawSegments.push({ start: startSec + Number(seg?.start || 0), end: startSec + Number(seg?.end || 0), text: segText })
          }
          job.doneChunks = idx + 1
          job.progressPct = Math.min(80, Math.floor((job.doneChunks / totalChunks) * 80))
          job.etaSec = estimateEtaSec(job)
        }
        transcript = chunkTexts.join('\n\n')
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }

    } else {
      // groq or openai — API-based chunked upload
      const providerLabel = asrProvider === 'groq' ? `Groq (${GROQ_WHISPER_MODEL})` : 'OpenAI (whisper-1)'
      const checkCancelled = () => assertNotCancelled(job)
      const transcribeFn = asrProvider === 'groq'
        ? (fp) => transcribeViaGroq(fp, {
            onRateLimit: (waitSec, attempt, maxAttempts) => {
              job.stage = `Groq rate-limited — waiting ${waitSec}s (retry ${attempt}/${maxAttempts})…`
              job.updatedAt = Date.now()
            },
            checkCancelled,
          })
        : transcribeViaOpenAi
      job.stage = `transcribing via ${providerLabel}`
      job.updatedAt = Date.now()

      const result = await transcribeAudioApiChunked(
        job.localPath,
        durationSec,
        (done, total) => {
          job.stage = `transcribing chunk ${done}/${total} via ${providerLabel}`
          job.doneChunks = done
          job.totalChunks = total
          job.progressPct = Math.min(80, Math.floor((done / total) * 80))
          job.etaSec = estimateEtaSec(job)
          job.updatedAt = Date.now()
        },
        transcribeFn,
        { checkCancelled },
      )
      transcript = result.text
      rawSegments = result.segments
    }

    job.stage = 'merging transcript'
    job.transcript = transcript
    job.rawSegments = rawSegments

    // ── Step 3: diarization (optional) ───────────────────────────────────────
    const usePyannote = DIARIZATION_MODE === 'pyannote' ||
      (DIARIZATION_MODE === 'auto' && !!PYANNOTE_HF_TOKEN)
    if (usePyannote) {
      try {
        job.stage = 'diarization (pyannote)'
        const { base } = await ensureCampaignDirs(job.campaignId)
        const outDir = path.join(base, 'imports')
        const prefix = `${Date.now()}-${job.sourceId}`
        const scriptPath = path.join(process.cwd(), 'scripts', 'diarize_merge.py')
        const args = [scriptPath, '--audio', job.localPath, '--out-dir', outDir, '--prefix', prefix, '--model', DIARIZATION_ASR_MODEL, '--device', DIARIZATION_ASR_DEVICE, '--compute-type', DIARIZATION_COMPUTE_TYPE, '--pyannote-device', DIARIZATION_PYANNOTE_DEVICE]
        if (PYANNOTE_HF_TOKEN) args.push('--hf-token', PYANNOTE_HF_TOKEN)
        const py = await run('python3', args)
        const mergedPath = String(py.stdout || '').trim().split('\n').filter(Boolean).pop()
        if (mergedPath) {
          const merged = await readJson(mergedPath, { lines: [] })
          const lines = Array.isArray(merged?.lines) ? merged.lines : []
          const sp = speakerTranscriptFromMergedLines(lines)
          if (sp.trim()) {
            job.speakerTranscript = sp
            job.diarizationArtifactPath = mergedPath
          }
        }
      } catch (e) {
        job.diarizationFallback = `pyannote failed, falling back to LLM diarization: ${e?.message || 'unknown error'}`
      }
    }

    await persistPreAiArtifact(job, {
      inputType: 'audio-transcript',
      transcript: job.transcript,
      rawSegments,
      extra: {
        asrProvider,
        audioDurationSec: job.durationSec || null,
        totalChunks: job.totalChunks || null,
        diarizationMode: DIARIZATION_MODE,
        diarizationArtifactPath: job.diarizationArtifactPath || null,
        diarizationFallback: job.diarizationFallback || null,
      },
    })
    job.progressPct = 81
    await runWithCampaignWriteLock(job.campaignId, async () => {
      await runLLMStages(job)
      await addSourceToGameSession(job.campaignId, job.gameSessionId, {
        sourceId: job.sourceId,
        sourceType: 'audio',
        label: job.sourceLabel,
        file: job.file,
        createdAt: Date.now(),
        proposalId: job.proposalId,
      })
    })

    job.status = 'done'
    job.progressPct = 100
    job.updatedAt = Date.now()
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED') {
      job.status = 'cancelled'
      job.stage = 'cancelled'
      job.error = 'Cancelled by user'
      job.etaSec = 0
      job.updatedAt = Date.now()
    } else {
      job.status = 'error'
      job.stage = 'failed'
      job.error = error.message
      job.stderr = error.stderr || null
      job.stdout = error.stdout || null
      job.updatedAt = Date.now()
    }
  } finally {
    await fs.unlink(job.localPath).catch(() => {})
    compactJob(job)
    scheduleJobCleanup(job)
    pruneJobs()
  }
}

export async function processTranscriptJob(job) {
  // Capture LLM config at job start so mid-flight settings changes don't affect this run.
  if (!job.llmConfig) job.llmConfig = snapshotLlmConfig()
  try {
    assertNotCancelled(job)
    job.status = 'running'
    job.stage = 'transcript loaded'
    job.startedAt = Date.now()
    await persistPreAiArtifact(job, {
      inputType: 'transcript',
      transcript: job.transcript,
      rawSegments: job.rawSegments,
    })
    job.progressPct = 80
    await runWithCampaignWriteLock(job.campaignId, async () => {
      await runLLMStages(job)
      await addSourceToGameSession(job.campaignId, job.gameSessionId, {
        sourceId: job.sourceId,
        sourceType: 'transcript',
        label: job.sourceLabel,
        file: job.file,
        createdAt: Date.now(),
        proposalId: job.proposalId,
      })
    })
    job.status = 'done'
    job.progressPct = 100
    job.updatedAt = Date.now()
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED') {
      job.status = 'cancelled'
      job.stage = 'cancelled'
      job.error = 'Cancelled by user'
      job.etaSec = 0
    } else {
      job.status = 'error'
      job.stage = 'failed'
      job.error = error.message
    }
    job.updatedAt = Date.now()
  } finally {
    compactJob(job)
    scheduleJobCleanup(job)
    pruneJobs()
  }
}

// /api/health is intentionally placed AFTER the auth middleware above, so it is
// protected by APP_TOKEN when that is set. It also exposes infra details, so
// keep it out of completely open access.