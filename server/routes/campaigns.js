import crypto from 'node:crypto'
import { withCampaignParamWriteLock } from '../utils.js'
import * as campaignsRepo from '../db/postgres/repositories/campaigns.repo.js'
import * as membersRepo from '../db/postgres/repositories/members.repo.js'
import * as lexiconRepo from '../db/postgres/repositories/lexicon.repo.js'
import * as trackersRepo from '../db/postgres/repositories/trackers.repo.js'
import * as journalRepo from '../db/postgres/repositories/journal.repo.js'
import * as bardTalesRepo from '../db/postgres/repositories/bard-tales.repo.js'
import * as docsRepo from '../db/postgres/repositories/campaign-documents.repo.js'
import { BARD_PROMPT_VERSION } from '../config.js'

// ── Auth helpers ─────────────────────────────────────────────────────────────

async function resolveCampaign(slug, user) {
  const campaign = await campaignsRepo.findCampaignBySlug(slug)
  if (!campaign) return null
  if (user.role !== 'admin') {
    const member = await membersRepo.findMember(campaign.id, user.id)
    if (!member) return null
  }
  return campaign
}

function isDmOfCampaign(user, campaign) {
  if (user.role === 'admin') return true
  return user.role === 'dm' && user.id === campaign.owner_user_id
}

// ── Bard persona metadata ─────────────────────────────────────────────────────

const BARD_PERSONAS = {
  grandiose: { id: 'grandiose', bardName: 'Milo Thrice-Stabbed' },
  drunken:   { id: 'drunken',   bardName: 'Bramble Alebelly' },
  grim:      { id: 'grim',      bardName: 'Sister Ash' },
  hymnist:   { id: 'hymnist',   bardName: 'Brother Candlewick' },
  replacement7: { id: 'replacement7', bardName: 'Tobble, Last-Minute Hire' },
}

const VALID_FAITHFULNESS = new Set(['close', 'dramatic', 'performance'])

function sourceHash(text) {
  if (!text) return ''
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

// ── Route registration ────────────────────────────────────────────────────────

export function setupCampaignRoutes(app) {

  // ── Bard tales ──────────────────────────────────────────────────────────────

  app.post('/api/campaigns/:id/bards-tales', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const tale = String(req.body?.tale || '').trim()
    if (!tale) return res.status(400).json({ ok: false, error: 'tale is required' })

    const personaId = (BARD_PERSONAS[String(req.body?.personaId || '')] || BARD_PERSONAS.grandiose).id
    const faithfulness = VALID_FAITHFULNESS.has(String(req.body?.faithfulness || '')) ? req.body.faithfulness : 'dramatic'
    const sourceText = String(req.body?.journal || '')

    const entry = {
      id: crypto.randomUUID(),
      journalEntryId: String(req.body?.journalEntryId || '').trim() || null,
      journalEntryTitle: String(req.body?.journalEntryTitle || req.body?.title || 'The Tale').trim(),
      title: String(req.body?.title || req.body?.journalEntryTitle || 'The Tale').trim(),
      bardName: String(req.body?.bardName || BARD_PERSONAS[personaId]?.bardName || '').trim(),
      personaId,
      faithfulness,
      promptVersion: String(req.body?.promptVersion || BARD_PROMPT_VERSION),
      sourceHash: String(req.body?.sourceHash || sourceHash(sourceText)).trim(),
      sourceLength: Number(req.body?.sourceLength || 0) || sourceText.length,
      text: tale,
      tale,
      createdAt: Date.now(),
    }

    await bardTalesRepo.upsertBardTale(campaign.id, entry)
    res.json({ ok: true, entry })
  }))

  app.delete('/api/campaigns/:id/bards-tales/:taleId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const taleId = String(req.params.taleId || '').trim()
    if (!taleId) return res.status(400).json({ ok: false, error: 'taleId required' })

    await bardTalesRepo.deleteBardTale(taleId)
    res.json({ ok: true, deleted: true, taleId })
  }))

  // ── DM sneak peek ────────────────────────────────────────────────────────────

  app.post('/api/campaigns/:id/dm-sneak-peek', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const text = String(req.body?.text || '').trim()
    if (!text) return res.status(400).json({ ok: false, error: 'text required' })

    const items = await docsRepo.loadDocument(campaign.id, 'dmSneakPeek') ?? []
    const entry = {
      id: crypto.randomUUID(),
      text,
      dueTag: String(req.body?.dueTag || '').trim(),
      done: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    items.push(entry)
    await docsRepo.upsertDocument(campaign.id, 'dmSneakPeek', items)
    res.json({ ok: true, item: entry })
  }))

  app.put('/api/campaigns/:id/dm-sneak-peek/:itemId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const itemId = String(req.params.itemId || '').trim()
    const items = await docsRepo.loadDocument(campaign.id, 'dmSneakPeek') ?? []
    const idx = items.findIndex((x) => String(x.id || '') === itemId)
    if (idx === -1) return res.status(404).json({ ok: false, error: 'item not found' })

    const cur = items[idx]
    const next = {
      ...cur,
      text: req.body?.text !== undefined ? String(req.body.text).trim() : cur.text,
      dueTag: req.body?.dueTag !== undefined ? String(req.body.dueTag).trim() : cur.dueTag,
      done: req.body?.done !== undefined ? !!req.body.done : !!cur.done,
      updatedAt: Date.now(),
    }
    items[idx] = next
    await docsRepo.upsertDocument(campaign.id, 'dmSneakPeek', items)
    res.json({ ok: true, item: next })
  }))

  app.delete('/api/campaigns/:id/dm-sneak-peek/:itemId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const itemId = String(req.params.itemId || '').trim()
    const items = await docsRepo.loadDocument(campaign.id, 'dmSneakPeek') ?? []
    const next = items.filter((x) => String(x.id || '') !== itemId)
    if (next.length === items.length) return res.status(404).json({ ok: false, error: 'item not found' })
    await docsRepo.upsertDocument(campaign.id, 'dmSneakPeek', next)
    res.json({ ok: true, deleted: true, itemId })
  }))

  // ── Journal ──────────────────────────────────────────────────────────────────

  app.put('/api/campaigns/:id/journal/:entryId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const entryId = String(req.params.entryId || '').trim()
    const markdown = String(req.body?.markdown || '')

    const entry = await journalRepo.findJournalEntry(campaign.id, entryId)
    if (!entry) return res.status(404).json({ ok: false, error: 'Journal entry not found' })

    await journalRepo.upsertJournalEntry(campaign.id, { ...entry, markdown, updatedAt: Date.now() })

    // Keep storyJournal document in sync (legacy mirrors journal_entries)
    const storyDoc = await docsRepo.loadDocument(campaign.id, 'storyJournal') ?? { entries: [] }
    storyDoc.entries = (storyDoc.entries || []).map((e) =>
      String(e?.id || '') === entryId ? { ...e, markdown, updatedAt: Date.now() } : e
    )
    await docsRepo.upsertDocument(campaign.id, 'storyJournal', storyDoc)

    res.json({ ok: true })
  }))

  app.delete('/api/campaigns/:id/journal/:entryId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const entryId = String(req.params.entryId || '').trim()
    const entry = await journalRepo.findJournalEntry(campaign.id, entryId)
    if (!entry) return res.status(404).json({ ok: false, error: 'Journal entry not found' })

    await journalRepo.deleteJournalEntry(entryId)

    const storyDoc = await docsRepo.loadDocument(campaign.id, 'storyJournal') ?? { entries: [] }
    storyDoc.entries = (storyDoc.entries || []).filter((e) => String(e?.id || '') !== entryId)
    await docsRepo.upsertDocument(campaign.id, 'storyJournal', storyDoc)

    res.json({ ok: true, deleted: true, entryId })
  }))

  // ── Game sessions ────────────────────────────────────────────────────────────

  app.get('/api/campaigns/:id/sessions', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })

    const sessions = await docsRepo.loadDocument(campaign.id, 'gameSessions') ?? []
    res.json({ ok: true, sessions: sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) })
  })

  app.post('/api/campaigns/:id/sessions', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    // Find existing session if ID provided
    const sessions = await docsRepo.loadDocument(campaign.id, 'gameSessions') ?? []
    const gameSessionId = String(req.body?.gameSessionId || '').trim()
    if (gameSessionId) {
      const existing = sessions.find((s) => s.id === gameSessionId)
      if (!existing) return res.status(404).json({ ok: false, error: 'Session not found' })
      return res.json({ ok: true, session: existing })
    }

    // Create a new session
    const raw = String(req.body?.number ?? req.body?.title ?? '').trim()
    if (!raw) return res.status(400).json({ ok: false, error: 'session number required' })
    const match = raw.match(/(\d+)/)
    if (!match) return res.status(400).json({ ok: false, error: 'session number required' })

    const number = Number(match[1])
    const session = {
      id: `session-${number}-${crypto.randomUUID().slice(0, 6)}`,
      title: String(number),
      number,
      label: String(req.body?.label || '').trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceCount: 0,
    }
    sessions.push(session)
    await docsRepo.upsertDocument(campaign.id, 'gameSessions', sessions)
    res.json({ ok: true, session })
  }))

  app.delete('/api/campaigns/:id/sessions/:sessionId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const sessions = await docsRepo.loadDocument(campaign.id, 'gameSessions') ?? []
    const next = sessions.filter((s) => s.id !== req.params.sessionId)
    if (next.length === sessions.length) return res.status(404).json({ ok: false, error: 'Session not found' })
    await docsRepo.upsertDocument(campaign.id, 'gameSessions', next)
    res.json({ ok: true })
  }))

  // ── Player characters ────────────────────────────────────────────────────────

  app.get('/api/campaigns/:id/pcs', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })

    const pcs = await docsRepo.loadDocument(campaign.id, 'pcs') ?? []
    res.json({ ok: true, pcs })
  })

  app.post('/api/campaigns/:id/pcs', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const characterName = String(req.body?.characterName || req.body?.name || '').trim()
    if (!characterName) return res.status(400).json({ ok: false, error: 'Character name required' })

    const pcs = await docsRepo.loadDocument(campaign.id, 'pcs') ?? []
    const pc = {
      id: crypto.randomUUID(),
      playerName: String(req.body?.playerName || '').trim(),
      ddbUsername: String(req.body?.ddbUsername || '').trim(),
      characterName,
      class: String(req.body?.class || '').trim(),
      race: String(req.body?.race || '').trim(),
      level: Number(req.body?.level || 1),
      notes: String(req.body?.notes || '').trim(),
      updatedAt: Date.now(),
    }
    pcs.push(pc)
    await docsRepo.upsertDocument(campaign.id, 'pcs', pcs)
    res.json({ ok: true, pc })
  }))

  app.put('/api/campaigns/:id/pcs/:pcId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const pcs = await docsRepo.loadDocument(campaign.id, 'pcs') ?? []
    const idx = pcs.findIndex((p) => p.id === req.params.pcId)
    if (idx === -1) return res.status(404).json({ ok: false, error: 'PC not found' })

    const prev = pcs[idx]
    const updated = {
      ...prev,
      playerName:    String(req.body?.playerName    ?? prev.playerName    ?? '').trim(),
      ddbUsername:   String(req.body?.ddbUsername   ?? prev.ddbUsername   ?? '').trim(),
      characterName: String(req.body?.characterName ?? prev.characterName ?? '').trim(),
      class:         String(req.body?.class         ?? prev.class         ?? '').trim(),
      race:          String(req.body?.race          ?? prev.race          ?? '').trim(),
      level:         Number(req.body?.level         ?? prev.level         ?? 1),
      notes:         String(req.body?.notes         ?? prev.notes         ?? '').trim(),
      sourceType:    String(req.body?.sourceType    ?? prev.sourceType    ?? '').trim(),
      sourceUrl:     String(req.body?.sourceUrl     ?? prev.sourceUrl     ?? '').trim(),
      avatarUrl:     String(req.body?.avatarUrl     ?? prev.avatarUrl     ?? '').trim(),
      lastSyncedAt:         req.body?.lastSyncedAt  ?? prev.lastSyncedAt  ?? null,
      updatedAt: Date.now(),
    }
    if (!updated.characterName) return res.status(400).json({ ok: false, error: 'Character name required' })

    pcs[idx] = updated
    await docsRepo.upsertDocument(campaign.id, 'pcs', pcs)
    res.json({ ok: true, pc: updated })
  }))

  app.delete('/api/campaigns/:id/pcs/:pcId', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const pcs = await docsRepo.loadDocument(campaign.id, 'pcs') ?? []
    const next = pcs.filter((p) => p.id !== req.params.pcId)
    if (next.length === pcs.length) return res.status(404).json({ ok: false, error: 'PC not found' })
    await docsRepo.upsertDocument(campaign.id, 'pcs', next)
    res.json({ ok: true })
  }))

  // ── DnD Beyond PC integration ─────────────────────────────────────────────────

  async function fetchDdbCharacter(characterId) {
    const u = `https://character-service.dndbeyond.com/character/v5/character/${characterId}`
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) {
      if (r.status === 403) throw new Error('DDB access denied (403). The character is likely private. Set character privacy to Public in D&D Beyond and try again.')
      if (r.status === 404) throw new Error('DDB character not found (404). Check the character ID/URL.')
      throw new Error(`DDB fetch failed (${r.status})`)
    }
    const j = await r.json()
    if (!j?.success || !j?.data) throw new Error(j?.message || 'DDB returned no character data')
    return j.data
  }

  function mapDdbCharacter(d, characterId) {
    return {
      ddbUsername: String(d.username || '').trim(),
      characterName: String(d.name || '').trim(),
      class: (Array.isArray(d.classes) ? d.classes.map((c) => c?.definition?.name).filter(Boolean).join(' / ') : '') || '',
      race: String(d?.race?.fullName || d?.race?.baseName || '').trim(),
      level: Math.max(1, Array.isArray(d.classes) ? d.classes.reduce((sum, c) => sum + Number(c?.level || 0), 0) : Number(d.level || 1)),
      notes: String(d?.notes?.backstory || d?.notes?.others || '').trim(),
      avatarUrl: String(d?.decorations?.avatarUrl || d?.race?.avatarUrl || '').trim(),
      sourceType: 'dndbeyond',
      sourceUrl: String(d.readonlyUrl || `https://www.dndbeyond.com/characters/${characterId}`).trim(),
      ddbCharacterId: String(characterId || '').trim(),
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  app.post('/api/campaigns/:id/pcs/import-dndbeyond', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const pcs = await docsRepo.loadDocument(campaign.id, 'pcs') ?? []

    const raw = String(req.body?.characterId || req.body?.url || '').trim()
    const match = raw.match(/(\d{6,})/)
    const characterId = match?.[1]
    if (!characterId) return res.status(400).json({ ok: false, error: 'characterId or DDB character URL required' })

    try {
      const d = await fetchDdbCharacter(characterId)
      const mapped = mapDdbCharacter(d, characterId)
      if (!mapped.characterName) return res.status(400).json({ ok: false, error: 'Character has no visible name (privacy?)' })

      const idx = pcs.findIndex((p) => String(p.ddbCharacterId || '') === String(characterId) || String(p.sourceUrl || '').includes(`/characters/${characterId}`) || String(p.characterName || '').toLowerCase() === mapped.characterName.toLowerCase())
      const prev = idx >= 0 ? pcs[idx] : {}
      const pc = {
        id: idx >= 0 ? prev.id : crypto.randomUUID(),
        ...prev,
        ...mapped,
        playerName: String(prev.playerName || '').trim() || String(mapped.ddbUsername || '').trim(),
      }
      if (idx >= 0) pcs[idx] = pc
      else pcs.push(pc)

      await docsRepo.upsertDocument(campaign.id, 'pcs', pcs)
      res.json({ ok: true, pc })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  }))

  app.post('/api/campaigns/:id/pcs/:pcId/link-dndbeyond', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const pcs = await docsRepo.loadDocument(campaign.id, 'pcs') ?? []
    const idx = pcs.findIndex((p) => p.id === req.params.pcId)
    if (idx === -1) return res.status(404).json({ ok: false, error: 'PC not found' })

    const raw = String(req.body?.characterId || req.body?.url || '').trim()
    const match = raw.match(/(\d{6,})/)
    const characterId = match?.[1]
    if (!characterId) return res.status(400).json({ ok: false, error: 'characterId or DDB character URL required' })

    pcs[idx] = {
      ...pcs[idx],
      ddbCharacterId: characterId,
      sourceType: 'dndbeyond',
      sourceUrl: `https://www.dndbeyond.com/characters/${characterId}`,
      updatedAt: Date.now(),
    }
    await docsRepo.upsertDocument(campaign.id, 'pcs', pcs)
    res.json({ ok: true, pc: pcs[idx] })
  }))

  app.post('/api/campaigns/:id/pcs/:pcId/sync-dndbeyond', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const pcs = await docsRepo.loadDocument(campaign.id, 'pcs') ?? []
    const idx = pcs.findIndex((p) => p.id === req.params.pcId)
    if (idx === -1) return res.status(404).json({ ok: false, error: 'PC not found' })
    const characterId = String(pcs[idx].ddbCharacterId || '').trim()
    if (!characterId) return res.status(400).json({ ok: false, error: 'PC is not linked to DDB yet' })

    try {
      const d = await fetchDdbCharacter(characterId)
      const mapped = mapDdbCharacter(d, characterId)
      pcs[idx] = {
        ...pcs[idx],
        ...mapped,
        playerName: String(pcs[idx].playerName || '').trim() || String(mapped.ddbUsername || '').trim(),
      }
      await docsRepo.upsertDocument(campaign.id, 'pcs', pcs)
      res.json({ ok: true, pc: pcs[idx] })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  }))

  // ── DM notes ─────────────────────────────────────────────────────────────────

  app.put('/api/campaigns/:id/dm-notes', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const text = String(req.body?.text || '')
    await docsRepo.upsertDocument(campaign.id, 'dmNotes', { text, updatedAt: Date.now() })
    res.json({ ok: true })
  }))

  // ── Trackers ─────────────────────────────────────────────────────────────────

  app.get('/api/campaigns/:id/trackers/:type', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })

    const type = String(req.params.type || '').trim().toLowerCase()
    const allowed = new Set(['quest', 'npc', 'place', 'event'])
    if (!allowed.has(type)) return res.status(400).json({ ok: false, error: 'Unsupported tracker type' })

    const rows = await trackersRepo.loadTrackersByType(campaign.id, type)
    res.json({ ok: true, rows, source: 'postgres' })
  })

  app.post('/api/campaigns/:id/rebuild-trackers-from-lexicon', withCampaignParamWriteLock(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })
    if (!isDmOfCampaign(req.user, campaign)) return res.status(403).json({ ok: false, error: 'DM access required' })

    const { entities, aliases } = await lexiconRepo.loadEntities(campaign.id)
    const trackerRows = []

    for (const entity of entities) {
      if (!['quest', 'npc', 'place'].includes(entity.entityType)) continue
      trackerRows.push({
        id: crypto.randomUUID(),
        campaignId: campaign.id,
        trackerType: entity.entityType,
        entityId: entity.id,
        snapshot: entity.entityType === 'quest'
          ? { status: String(entity.data?.status || '').trim() || 'Unknown',
              subtitle: String(entity.data?.objective || entity.data?.latestUpdate || '').trim() }
          : { subtitle: String(entity.notes || '').trim() },
        linkMethod: 'rebuild',
        linkConfidence: 1,
        updatedAt: Date.now(),
      })
    }

    await lexiconRepo.replaceCanonicalStores(campaign.id, { entities, aliases, trackerRows })
    res.json({ ok: true, rebuilt: trackerRows.length })
  }))

  // ── Approvals (read) ─────────────────────────────────────────────────────────

  app.get('/api/campaigns/:id/approvals', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const campaign = await resolveCampaign(req.params.id, req.user)
    if (!campaign) return res.status(404).json({ ok: false, error: 'Campaign not found' })

    const approvals = await docsRepo.loadDocument(campaign.id, 'approvals') ?? []
    res.json({ ok: true, approvals: approvals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) })
  })

}
