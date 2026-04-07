import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { execFile } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const app = express()

function envNumber(value, fallback, minimum = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, parsed)
}

const PORT = process.env.API_PORT || 8790
const SSH_KEY_PATH = process.env.OLLAMA_SSH_KEY || `${os.homedir()}/.ssh/openclaw_homelab`
const SSH_USER = process.env.OLLAMA_SSH_USER || 'root'
const SSH_HOST = process.env.OLLAMA_SSH_HOST || '10.0.50.5'
const REMOTE_AUDIO_DIR = process.env.REMOTE_AUDIO_DIR || '/tmp/dnd-audio-in'
const REMOTE_OUT_DIR = process.env.REMOTE_OUT_DIR || '/tmp/dnd-audio-out'
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'tiny'
const WHISPER_DEVICE = process.env.WHISPER_DEVICE || 'cuda'
const CHUNK_SECONDS = Number(process.env.WHISPER_CHUNK_SECONDS || 600)

// ASR provider: remote (SSH+whisper) | local (whisper CLI) | groq | openai
let ASR_PROVIDER = String(process.env.ASR_PROVIDER || 'remote').toLowerCase()

// Groq settings (used when ASR_PROVIDER=groq)
const GROQ_BASE = process.env.GROQ_BASE || 'https://api.groq.com/openai/v1'
const GROQ_WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3'
let GROQ_API_KEY = process.env.GROQ_API_KEY || ''
// Max bytes per chunk for API-based ASR (Groq/OpenAI both have 25MB limit)
const ASR_API_CHUNK_BYTES = envNumber(process.env.ASR_API_CHUNK_BYTES, 1024 * 1024 * 24, 1024 * 1024)

// Diarization runtime mode
// auto (default): use pyannote if HF token is available, else LLM guess
// pyannote: always use pyannote (fails if no token)
// llm: always use LLM speaker guess, skip pyannote
const DIARIZATION_MODE = String(process.env.DIARIZATION_MODE || 'auto').toLowerCase() // auto | llm | pyannote
const DIARIZATION_ASR_MODEL = String(process.env.DIARIZATION_ASR_MODEL || 'medium')
const DIARIZATION_ASR_DEVICE = String(process.env.DIARIZATION_ASR_DEVICE || 'cuda')
const DIARIZATION_COMPUTE_TYPE = String(process.env.DIARIZATION_COMPUTE_TYPE || 'float16')
const DIARIZATION_PYANNOTE_DEVICE = String(process.env.DIARIZATION_PYANNOTE_DEVICE || 'cuda')
let PYANNOTE_HF_TOKEN = String(process.env.PYANNOTE_HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '')
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://ollama.throne.middl.earth:11434'
const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com/v1'
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE || 'https://api.anthropic.com/v1'
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta'
let OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
let GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''

const ANTHROPIC_RETRY_MAX = Number(process.env.ANTHROPIC_RETRY_MAX || 4)
const ANTHROPIC_RETRY_BASE_MS = Number(process.env.ANTHROPIC_RETRY_BASE_MS || 1200)
const ANTHROPIC_MIN_GAP_MS = Number(process.env.ANTHROPIC_MIN_GAP_MS || 900)
let anthropicNextAllowedAt = 0

// Pipeline model selection settings
// Default is FLEXIBLE (uses currently selected LLM provider/model from Settings).
const PIPELINE_CHATGPT_ONLY = String(process.env.PIPELINE_CHATGPT_ONLY || 'false').toLowerCase() !== 'false'
const PIPELINE_OPENAI_MODEL = process.env.PIPELINE_OPENAI_MODEL || 'gpt-5.3-chat-latest'
const PIPELINE_OPENAI_FALLBACK_MODEL = process.env.PIPELINE_OPENAI_FALLBACK_MODEL || 'gpt-5-mini'

let LLM_PROVIDER = process.env.LLM_PROVIDER || 'ollama'
let LLM_MODEL = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:7b'

// Return a snapshot of the current LLM settings. Jobs should capture this at
// creation time so that a mid-flight settings change doesn't alter an in-progress run.
function snapshotLlmConfig() {
  return { provider: LLM_PROVIDER, model: LLM_MODEL }
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data')
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns')
const DIST_DIR = path.resolve('./dist')
const DIST_INDEX_FILE = path.join(DIST_DIR, 'index.html')
const MAX_UPLOAD_BYTES = envNumber(process.env.MAX_UPLOAD_BYTES, 1024 * 1024 * 200, 1)
const JOB_RETENTION_MS = envNumber(process.env.JOB_RETENTION_MS, 1000 * 60 * 30, 0)
const MAX_RETAINED_JOBS = envNumber(process.env.MAX_RETAINED_JOBS, 100, 1)
// Maximum number of concurrently running (non-terminal) transcription jobs.
// Override via MAX_CONCURRENT_JOBS env var. Default: 3.
const MAX_CONCURRENT_JOBS = envNumber(process.env.MAX_CONCURRENT_JOBS, 3, 1)
const SECRETS_DIR = path.join(DATA_DIR, 'secrets')
const OPENAI_KEY_FILE = path.join(SECRETS_DIR, 'openai-api-key.json')
const ANTHROPIC_KEY_FILE = path.join(SECRETS_DIR, 'anthropic-api-key.json')
const GEMINI_KEY_FILE = path.join(SECRETS_DIR, 'gemini-api-key.json')
const PYANNOTE_TOKEN_FILE = path.join(SECRETS_DIR, 'pyannote-hf-token.json')
const GROQ_KEY_FILE = path.join(SECRETS_DIR, 'groq-api-key.json')
const ASR_CONFIG_FILE = path.join(SECRETS_DIR, 'asr-config.json')

class InvalidCampaignIdError extends Error {
  constructor(campaignId) {
    super(`Invalid campaign id: ${campaignId}`)
    this.name = 'InvalidCampaignIdError'
    this.statusCode = 400
  }
}

class CampaignNotFoundError extends Error {
  constructor(campaignId) {
    super(`Campaign not found: ${campaignId}`)
    this.name = 'CampaignNotFoundError'
    this.statusCode = 404
  }
}

class DataIntegrityError extends Error {
  constructor(file, cause) {
    super(`Invalid JSON in ${file}`)
    this.name = 'DataIntegrityError'
    this.statusCode = 500
    this.cause = cause
  }
}

const jobs = new Map()
const jobCleanupTimers = new Map()

// Jobs SQLite persistence — survives API restarts so polling clients get terminal state
const JOBS_DB_PATH = path.join(DATA_DIR, 'jobs.sqlite')
let _jobsDb = null

function getJobsDb() {
  if (_jobsDb) return _jobsDb
  _jobsDb = new DatabaseSync(JOBS_DB_PATH)
  _jobsDb.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return _jobsDb
}

function persistJobToDb(job) {
  try {
    const db = getJobsDb()
    const safe = { ...job, rawSegments: undefined, localPath: undefined, remoteAudioPath: undefined, stdout: undefined, stderr: undefined }
    db.prepare('INSERT OR REPLACE INTO jobs (id, status, data_json, updated_at) VALUES (?, ?, ?, ?)').run(
      job.id, String(job.status || ''), JSON.stringify(safe), Date.now()
    )
  } catch { /* best-effort */ }
}

function loadJobsFromDb() {
  try {
    const db = getJobsDb()
    const rows = db.prepare('SELECT data_json FROM jobs WHERE status IN (\'done\', \'error\', \'cancelled\') ORDER BY updated_at DESC LIMIT 200').all()
    for (const row of rows) {
      try {
        const job = JSON.parse(row.data_json)
        if (job?.id && !jobs.has(job.id)) jobs.set(job.id, job)
      } catch { /* skip corrupt rows */ }
    }
  } catch { /* db may not exist yet */ }
}

function pruneJobsDb() {
  try {
    const db = getJobsDb()
    db.prepare('DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY updated_at DESC LIMIT 200)').run()
  } catch { /* best-effort */ }
}

// CORS: allow the configured front-end origins (override via CORS_ORIGINS env var, comma-separated).
// Defaults to the two known hostnames plus localhost for dev convenience.
const _corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['https://dnd.throne.middl.earth', 'https://dnd.middl.earth', 'http://localhost:5173', 'http://localhost:4173']
app.use(cors({ origin: _corsOrigins, credentials: true }))
app.use(express.json({ limit: '10mb' }))
const upload = multer({
  dest: path.join(os.tmpdir(), 'dnd-upload'),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
})

// Optional bearer-token auth. Set APP_TOKEN env var to enable.
const APP_TOKEN = (process.env.APP_TOKEN || '').trim()
if (APP_TOKEN) {
  const _appTokenBuf = Buffer.from(APP_TOKEN)
  app.use('/api', (req, res, next) => {
    const authHeader = String(req.headers['authorization'] || '')
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    let valid = false
    if (token) {
      try {
        const tokenBuf = Buffer.from(token)
        // Constant-time comparison to prevent timing attacks.
        valid = tokenBuf.length === _appTokenBuf.length &&
          crypto.timingSafeEqual(tokenBuf, _appTokenBuf)
      } catch { valid = false }
    }
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' })
    }
    next()
  })
}

async function run(cmd, args) {
  return execFileAsync(cmd, args, { maxBuffer: 1024 * 1024 * 80 })
}

function slugify(text = '') {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

function normalizeCampaignId(campaignId = '') {
  const normalized = String(campaignId || '').trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new InvalidCampaignIdError(campaignId)
  }
  return normalized
}

function resolveCampaignBase(campaignId) {
  const normalizedId = normalizeCampaignId(campaignId)
  const base = path.resolve(CAMPAIGNS_DIR, normalizedId)
  const relative = path.relative(CAMPAIGNS_DIR, base)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new InvalidCampaignIdError(campaignId)
  }
  return { campaignId: normalizedId, base }
}

function clearJobCleanup(jobId) {
  const timer = jobCleanupTimers.get(jobId)
  if (timer) clearTimeout(timer)
  jobCleanupTimers.delete(jobId)
}

function deleteJob(jobId) {
  clearJobCleanup(jobId)
  jobs.delete(jobId)
}

function compactJob(job) {
  job.rawSegments = []
  job.localPath = null
  job.remoteAudioPath = null
  job.stdout = null
  job.stderr = null
}

function pruneJobs() {
  if (jobs.size <= MAX_RETAINED_JOBS) return

  const terminalJobs = [...jobs.values()]
    .filter((job) => ['done', 'error', 'cancelled'].includes(String(job.status || '')))
    .sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0))

  while (jobs.size > MAX_RETAINED_JOBS && terminalJobs.length) {
    const oldest = terminalJobs.shift()
    deleteJob(oldest.id)
  }
}

function scheduleJobCleanup(job) {
  if (!job?.id) return

  clearJobCleanup(job.id)

  // Persist to DB before any cleanup so restart-then-poll returns terminal state
  if (['done', 'error', 'cancelled'].includes(String(job.status || ''))) {
    persistJobToDb(job)
    pruneJobsDb()
  }

  if (JOB_RETENTION_MS === 0) {
    deleteJob(job.id)
    return
  }

  job.expiresAt = Date.now() + JOB_RETENTION_MS
  const timer = setTimeout(() => {
    deleteJob(job.id)
  }, JOB_RETENTION_MS)

  if (typeof timer.unref === 'function') timer.unref()
  jobCleanupTimers.set(job.id, timer)
}

function trackJob(job) {
  clearJobCleanup(job.id)
  jobs.set(job.id, job)
  pruneJobs()
}

const writeLocks = new Map()

async function runExclusive(lockKey, fn) {
  const previous = writeLocks.get(lockKey) || Promise.resolve()
  let releaseCurrent
  const current = new Promise((resolve) => {
    releaseCurrent = resolve
  })
  writeLocks.set(lockKey, current)

  await previous
  try {
    return await fn()
  } finally {
    releaseCurrent()
    if (writeLocks.get(lockKey) === current) writeLocks.delete(lockKey)
  }
}

async function runWithCampaignWriteLock(campaignId, fn) {
  return runExclusive(`campaign:${normalizeCampaignId(campaignId)}`, fn)
}

function withStaticWriteLock(lockKey, handler) {
  return async (req, res, next) => {
    try {
      await runExclusive(lockKey, () => handler(req, res, next))
    } catch (error) {
      next(error)
    }
  }
}

function withCampaignParamWriteLock(handler) {
  return async (req, res, next) => {
    try {
      await runWithCampaignWriteLock(req.params.id, () => handler(req, res, next))
    } catch (error) {
      next(error)
    }
  }
}

function withCampaignBodyWriteLock(handler) {
  return async (req, res, next) => {
    try {
      await runWithCampaignWriteLock(req.body?.campaignId, () => handler(req, res, next))
    } catch (error) {
      next(error)
    }
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) throw new DataIntegrityError(file, error)
    throw error
  }
}

async function writeJson(file, value) {
  const tempFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(tempFile, JSON.stringify(value, null, 2))
  await fs.rename(tempFile, file)
}

// LRU cache for campaign SQLite connections (max CAMPAIGN_DB_CACHE_MAX env, default 10)
const CAMPAIGN_DB_CACHE_MAX = envNumber(process.env.CAMPAIGN_DB_CACHE_MAX, 10, 1)
const campaignDbCache = new Map() // key → { db, lruOrder }
let _lruSeq = 0

// Track which DB connections have already had ensureSqlSchema applied so it
// runs exactly once per connection rather than on every read/write.
const _schemaMigratedDbs = new WeakSet()

function dbForCampaignBase(base) {
  const dbPath = path.join(base, 'campaign.sqlite')
  if (campaignDbCache.has(dbPath)) {
    campaignDbCache.get(dbPath).lruOrder = ++_lruSeq
    return campaignDbCache.get(dbPath).db
  }
  // Evict least-recently-used if at capacity
  if (campaignDbCache.size >= CAMPAIGN_DB_CACHE_MAX) {
    let oldest = null
    for (const [k, v] of campaignDbCache) {
      if (!oldest || v.lruOrder < campaignDbCache.get(oldest).lruOrder) oldest = k
    }
    if (oldest) {
      try { campaignDbCache.get(oldest).db.close() } catch { /* ignore */ }
      campaignDbCache.delete(oldest)
    }
  }
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  campaignDbCache.set(dbPath, { db, lruOrder: ++_lruSeq })
  // Run schema migrations once immediately on first open.
  ensureSqlSchema(db)
  return db
}

function ensureSqlSchema(db) {
  // Guard: only run migrations once per connection instance.
  if (_schemaMigratedDbs.has(db)) return
  _schemaMigratedDbs.add(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS lexicon_entities (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      canonical_term TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      resolution_state TEXT NOT NULL DEFAULT 'resolved',
      resolved_to_lexicon_id TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      ownership_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT 'import',
      last_updated_by TEXT NOT NULL DEFAULT 'import',
      last_source_type TEXT NOT NULL DEFAULT '',
      last_source_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(campaign_id, entity_type, canonical_term)
    );

    CREATE TABLE IF NOT EXISTS entity_aliases (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'import',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(entity_id) REFERENCES lexicon_entities(id) ON DELETE CASCADE,
      UNIQUE(entity_id, alias)
    );

    CREATE TABLE IF NOT EXISTS tracker_rows (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      tracker_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      link_method TEXT NOT NULL DEFAULT 'manual',
      link_confidence REAL NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(entity_id) REFERENCES lexicon_entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bard_tales (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      journal_entry_id TEXT,
      title TEXT NOT NULL,
      bard_name TEXT,
      persona_id TEXT,
      faithfulness TEXT,
      prompt_version TEXT,
      source_hash TEXT,
      source_length INTEGER,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_documents (
      campaign_id TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      content_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (campaign_id, doc_key)
    );

    CREATE INDEX IF NOT EXISTS idx_lexicon_entities_campaign_type ON lexicon_entities(campaign_id, entity_type);
    CREATE INDEX IF NOT EXISTS idx_lexicon_entities_campaign_term ON lexicon_entities(campaign_id, canonical_term);
    CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_campaign_type ON tracker_rows(campaign_id, tracker_type);
    CREATE INDEX IF NOT EXISTS idx_campaign_documents_campaign ON campaign_documents(campaign_id, doc_key);
  `)

  try {
    db.exec('ALTER TABLE bard_tales ADD COLUMN campaign_id TEXT')
  } catch {
    // column already exists or table shape already updated
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_bard_tales_campaign ON bard_tales(campaign_id, created_at)')
  } catch {
    // ignore
  }

  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN resolved_to_lexicon_id TEXT") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN data_json TEXT NOT NULL DEFAULT '{}'") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN ownership_json TEXT NOT NULL DEFAULT '{}'") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'") } catch {}
}

function runInTx(db, fn) {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

function sqlUpsertCanonicalFromMemory(db, campaignId, canon) {
  ensureSqlSchema(db)
  const entities = Array.isArray(canon?.entities) ? canon.entities : []
  const aliases = Array.isArray(canon?.aliases) ? canon.aliases : []
  const trackerRows = Array.isArray(canon?.trackerRows) ? canon.trackerRows : []

  const deleteEntities = db.prepare('DELETE FROM lexicon_entities WHERE campaign_id = ?')

  const upsertEntity = db.prepare(`
    INSERT INTO lexicon_entities (
      id, campaign_id, entity_type, canonical_term, notes, resolution_state,
      resolved_to_lexicon_id, data_json, ownership_json, evidence_json,
      created_by, last_updated_by, last_source_type, last_source_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      entity_type=excluded.entity_type,
      canonical_term=excluded.canonical_term,
      notes=excluded.notes,
      resolution_state=excluded.resolution_state,
      resolved_to_lexicon_id=excluded.resolved_to_lexicon_id,
      data_json=excluded.data_json,
      ownership_json=excluded.ownership_json,
      evidence_json=excluded.evidence_json,
      last_updated_by=excluded.last_updated_by,
      last_source_type=excluded.last_source_type,
      last_source_id=excluded.last_source_id,
      updated_at=excluded.updated_at
  `)

  const upsertAlias = db.prepare(`
    INSERT INTO entity_aliases (id, entity_id, alias, confidence, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id, alias) DO UPDATE SET
      confidence=excluded.confidence,
      source=excluded.source
  `)

  const upsertTracker = db.prepare(`
    INSERT INTO tracker_rows (id, campaign_id, tracker_type, entity_id, snapshot_json, link_method, link_confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tracker_type=excluded.tracker_type,
      entity_id=excluded.entity_id,
      snapshot_json=excluded.snapshot_json,
      link_method=excluded.link_method,
      link_confidence=excluded.link_confidence,
      updated_at=excluded.updated_at
  `)

  runInTx(db, () => {
    deleteEntities.run(campaignId)

    for (const e of entities) {
      upsertEntity.run(
        String(e?.id || crypto.randomUUID()),
        campaignId,
        normalizeEntityType(e?.entityType || 'term'),
        String(e?.canonicalTerm || '').trim(),
        String(e?.notes || '').trim(),
        String(e?.resolution?.state || 'resolved').trim() || 'resolved',
        e?.resolution?.resolvedToLexiconId ? String(e.resolution.resolvedToLexiconId) : null,
        JSON.stringify(e?.data || {}),
        JSON.stringify(e?.ownership || {}),
        JSON.stringify(Array.isArray(e?.evidence) ? e.evidence : []),
        String(e?.createdBy || 'import').trim(),
        String(e?.lastUpdatedBy || 'import').trim(),
        String(e?.lastSourceType || '').trim(),
        e?.lastSourceId ? String(e.lastSourceId) : null,
        Number(e?.createdAt || Date.now()),
        Number(e?.updatedAt || Date.now()),
      )
    }

    for (const a of aliases) {
      const alias = String(a?.alias || '').trim()
      const entityId = String(a?.entityId || '').trim()
      if (!alias || !entityId) continue
      upsertAlias.run(
        String(a?.id || crypto.randomUUID()),
        entityId,
        alias,
        Number(a?.confidence ?? 1),
        String(a?.source || 'import').trim(),
        Number(a?.createdAt || Date.now()),
      )
    }

    for (const row of trackerRows) {
      const entityId = String(row?.entityId || '').trim()
      if (!entityId) continue
      upsertTracker.run(
        String(row?.id || crypto.randomUUID()),
        campaignId,
        String(row?.trackerType || '').trim(),
        entityId,
        JSON.stringify(row?.snapshot || {}),
        String(row?.linkMethod || 'manual').trim(),
        Number(row?.linkConfidence ?? 1),
        Number(row?.updatedAt || Date.now()),
      )
    }
  })
}

function sqlLoadCanonicalStores(db, campaignId) {
  ensureSqlSchema(db)

  const entityRows = db.prepare(`
    SELECT
      id, campaign_id, entity_type, canonical_term, notes, resolution_state,
      resolved_to_lexicon_id, data_json, ownership_json, evidence_json,
      created_by, last_updated_by, last_source_type, last_source_id, created_at, updated_at
    FROM lexicon_entities
    WHERE campaign_id = ?
    ORDER BY created_at ASC, canonical_term ASC
  `).all(campaignId)

  const entities = entityRows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    entityType: row.entity_type,
    canonicalTerm: row.canonical_term,
    notes: row.notes || '',
    data: (() => { try { return JSON.parse(String(row.data_json || '{}')) } catch { return {} } })(),
    resolution: {
      state: row.resolution_state || 'resolved',
      resolvedToLexiconId: row.resolved_to_lexicon_id || null,
    },
    ownership: (() => { try { return JSON.parse(String(row.ownership_json || '{}')) } catch { return {} } })(),
    evidence: (() => { try { return JSON.parse(String(row.evidence_json || '[]')) } catch { return [] } })(),
    aliases: [],
    createdBy: row.created_by || 'import',
    lastUpdatedBy: row.last_updated_by || 'import',
    lastSourceType: row.last_source_type || '',
    lastSourceId: row.last_source_id || null,
    createdAt: Number(row.created_at || Date.now()),
    updatedAt: Number(row.updated_at || row.created_at || Date.now()),
  }))

  const aliases = db.prepare(`
    SELECT ea.id, ea.entity_id, ea.alias, ea.confidence, ea.source, ea.created_at, le.entity_type
    FROM entity_aliases ea
    JOIN lexicon_entities le ON le.id = ea.entity_id
    WHERE le.campaign_id = ?
    ORDER BY ea.created_at ASC, ea.alias ASC
  `).all(campaignId).map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    alias: row.alias,
    confidence: Number(row.confidence ?? 1),
    source: row.source || 'import',
    createdAt: Number(row.created_at || Date.now()),
  }))

  const aliasesByEntityId = new Map()
  for (const alias of aliases) {
    if (!aliasesByEntityId.has(alias.entityId)) aliasesByEntityId.set(alias.entityId, [])
    aliasesByEntityId.get(alias.entityId).push(alias.alias)
  }
  for (const entity of entities) {
    entity.aliases = Array.from(new Set(aliasesByEntityId.get(entity.id) || []))
  }

  const trackerRows = db.prepare(`
    SELECT id, campaign_id, tracker_type, entity_id, snapshot_json, link_method, link_confidence, updated_at
    FROM tracker_rows
    WHERE campaign_id = ?
    ORDER BY updated_at DESC, id ASC
  `).all(campaignId).map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    trackerType: row.tracker_type,
    entityId: row.entity_id,
    snapshot: (() => { try { return JSON.parse(String(row.snapshot_json || '{}')) } catch { return {} } })(),
    linkMethod: row.link_method || 'manual',
    linkConfidence: Number(row.link_confidence ?? 1),
    updatedAt: Number(row.updated_at || Date.now()),
  }))

  return { entities, aliases, trackerRows }
}

const CAMPAIGN_DOCUMENT_DEFS = {
  npcs: { fileKey: 'npcs', defaultValue: [] },
  quests: { fileKey: 'quests', defaultValue: [] },
  quotes: { fileKey: 'quotes', defaultValue: [] },
  storyJournal: { fileKey: 'storyJournal', defaultValue: { entries: [] } },
  pcs: { fileKey: 'pcs', defaultValue: [] },
  gameSessions: { fileKey: 'gameSessions', defaultValue: [] },
  approvals: { fileKey: 'approvals', defaultValue: [] },
  lexicon: { fileKey: 'lexicon', defaultValue: [] },
  places: { fileKey: 'places', defaultValue: [] },
  dmNotes: { fileKey: 'dmNotes', defaultValue: { text: '' } },
  dmSneakPeek: { fileKey: 'dmSneakPeek', defaultValue: [] },
}

function cloneCampaignDocumentDefault(docKey) {
  const def = CAMPAIGN_DOCUMENT_DEFS[docKey]
  if (!def) throw new Error(`Unsupported campaign document: ${docKey}`)
  return JSON.parse(JSON.stringify(def.defaultValue))
}

function sqlLoadCampaignDocument(db, campaignId, docKey) {
  ensureSqlSchema(db)
  const row = db.prepare(`
    SELECT content_json
    FROM campaign_documents
    WHERE campaign_id = ? AND doc_key = ?
  `).get(campaignId, docKey)
  if (!row) return cloneCampaignDocumentDefault(docKey)
  try {
    return JSON.parse(String(row.content_json || 'null'))
  } catch (error) {
    throw new DataIntegrityError(`campaign_documents:${campaignId}:${docKey}`, error)
  }
}

function sqlUpsertCampaignDocument(db, campaignId, docKey, value) {
  ensureSqlSchema(db)
  db.prepare(`
    INSERT INTO campaign_documents (campaign_id, doc_key, content_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(campaign_id, doc_key) DO UPDATE SET
      content_json = excluded.content_json,
      updated_at = excluded.updated_at
  `).run(campaignId, docKey, JSON.stringify(value), Date.now())
}

function sqlTrackerRowsByType(db, campaignId, type) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    SELECT
      tr.id, tr.campaign_id, tr.tracker_type, tr.entity_id, tr.snapshot_json, tr.link_method, tr.link_confidence, tr.updated_at,
      le.id AS le_id, le.entity_type, le.canonical_term, le.notes, le.resolution_state, le.resolved_to_lexicon_id,
      le.data_json, le.ownership_json, le.evidence_json, le.created_at AS le_created_at, le.updated_at AS le_updated_at
    FROM tracker_rows tr
    JOIN lexicon_entities le ON le.id = tr.entity_id
    WHERE tr.campaign_id = ? AND tr.tracker_type = ?
    ORDER BY tr.updated_at DESC
  `)
  return stmt.all(campaignId, type).map((r) => ({
    id: r.id,
    campaignId: r.campaign_id,
    trackerType: r.tracker_type,
    entityId: r.entity_id,
    snapshot: (() => { try { return JSON.parse(String(r.snapshot_json || '{}')) } catch { return {} } })(),
    linkMethod: r.link_method,
    linkConfidence: r.link_confidence,
    updatedAt: r.updated_at,
    entity: {
      id: r.le_id,
      entityType: r.entity_type,
      canonicalTerm: r.canonical_term,
      notes: r.notes,
      data: (() => { try { return JSON.parse(String(r.data_json || '{}')) } catch { return {} } })(),
      resolution: { state: r.resolution_state, resolvedToLexiconId: r.resolved_to_lexicon_id || null },
      ownership: (() => { try { return JSON.parse(String(r.ownership_json || '{}')) } catch { return {} } })(),
      evidence: (() => { try { return JSON.parse(String(r.evidence_json || '[]')) } catch { return [] } })(),
      createdAt: r.le_created_at,
      updatedAt: r.le_updated_at,
    },
  }))
}

function sqlUpsertJournalEntries(db, campaignId, entries = []) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    INSERT INTO journal_entries (id, campaign_id, session_id, title, body, source_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      body=excluded.body,
      source_hash=excluded.source_hash,
      updated_at=excluded.updated_at
  `)
  runInTx(db, () => {
    for (const e of (Array.isArray(entries) ? entries : [])) {
      const body = String(e?.markdown || e?.body || '')
      stmt.run(
        String(e?.id || crypto.randomUUID()),
        campaignId,
        e?.gameSessionId ? String(e.gameSessionId) : null,
        String(e?.title || '').trim() || 'Journal Entry',
        body,
        sourceHashForText(body),
        Number(e?.createdAt || Date.now()),
        Number(e?.updatedAt || e?.createdAt || Date.now()),
      )
    }
  })
}

function sqlLoadJournalEntries(db, campaignId) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    SELECT id, campaign_id, session_id, title, body, source_hash, created_at, updated_at
    FROM journal_entries
    WHERE campaign_id = ?
    ORDER BY created_at ASC
  `)
  return stmt.all(campaignId).map((r) => ({
    id: r.id,
    title: r.title,
    markdown: r.body,
    gameSessionId: r.session_id || null,
    createdAt: Number(r.created_at || Date.now()),
    updatedAt: Number(r.updated_at || r.created_at || Date.now()),
  }))
}

function sqlUpsertBardTales(db, campaignId, tales = []) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    INSERT INTO bard_tales (
      id, campaign_id, journal_entry_id, title, bard_name, persona_id, faithfulness,
      prompt_version, source_hash, source_length, text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      campaign_id=excluded.campaign_id,
      title=excluded.title,
      bard_name=excluded.bard_name,
      persona_id=excluded.persona_id,
      faithfulness=excluded.faithfulness,
      prompt_version=excluded.prompt_version,
      source_hash=excluded.source_hash,
      source_length=excluded.source_length,
      text=excluded.text
  `)
  runInTx(db, () => {
    for (const t of (Array.isArray(tales) ? tales : [])) {
      stmt.run(
        String(t?.id || crypto.randomUUID()),
        campaignId,
        t?.journalEntryId ? String(t.journalEntryId) : null,
        String(t?.title || t?.journalEntryTitle || 'The Tale').trim(),
        String(t?.bardName || '').trim() || null,
        String(t?.personaId || '').trim() || null,
        String(t?.faithfulness || '').trim() || null,
        String(t?.promptVersion || '').trim() || null,
        String(t?.sourceHash || '').trim() || null,
        Number(t?.sourceLength || 0),
        String(t?.text || t?.tale || ''),
        Number(t?.createdAt || Date.now()),
      )
    }
  })
}

function sqlLoadBardTales(db, campaignId) {
  ensureSqlSchema(db)
  const stmt = db.prepare(`
    SELECT bt.id, bt.journal_entry_id, bt.title, bt.bard_name, bt.persona_id, bt.faithfulness,
           bt.prompt_version, bt.source_hash, bt.source_length, bt.text, bt.created_at,
           je.title AS journal_title
    FROM bard_tales bt
    LEFT JOIN journal_entries je ON je.id = bt.journal_entry_id
    WHERE bt.campaign_id = ?
    ORDER BY bt.created_at DESC
  `)
  return stmt.all(campaignId).map((r) => ({
    id: r.id,
    journalEntryId: r.journal_entry_id,
    journalEntryTitle: r.journal_title || 'The Tale',
    title: r.title,
    bardTitle: `${r.title || 'The Tale'} Bard's Tale`,
    bardName: r.bard_name || '',
    personaId: r.persona_id || 'grandiose',
    faithfulness: r.faithfulness || 'dramatic',
    promptVersion: r.prompt_version || BARD_PROMPT_VERSION,
    sourceHash: r.source_hash || '',
    sourceLength: Number(r.source_length || 0),
    text: r.text || '',
    tale: r.text || '',
    createdAt: Number(r.created_at || Date.now()),
    updatedAt: Number(r.created_at || Date.now()),
  }))
}

function sqlReplaceJournalEntries(db, campaignId, entries = []) {
  ensureSqlSchema(db)
  const deleteStmt = db.prepare('DELETE FROM journal_entries WHERE campaign_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO journal_entries (id, campaign_id, session_id, title, body, source_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      body=excluded.body,
      source_hash=excluded.source_hash,
      updated_at=excluded.updated_at
  `)
  runInTx(db, () => {
    deleteStmt.run(campaignId)
    for (const e of (Array.isArray(entries) ? entries : [])) {
      const body = String(e?.markdown || e?.body || '')
      insertStmt.run(
        String(e?.id || crypto.randomUUID()),
        campaignId,
        e?.gameSessionId ? String(e.gameSessionId) : null,
        String(e?.title || '').trim() || 'Journal Entry',
        body,
        sourceHashForText(body),
        Number(e?.createdAt || Date.now()),
        Number(e?.updatedAt || e?.createdAt || Date.now()),
      )
    }
  })
}

function sqlReplaceBardTales(db, campaignId, tales = []) {
  ensureSqlSchema(db)
  const deleteStmt = db.prepare('DELETE FROM bard_tales WHERE campaign_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO bard_tales (
      id, campaign_id, journal_entry_id, title, bard_name, persona_id, faithfulness,
      prompt_version, source_hash, source_length, text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      campaign_id=excluded.campaign_id,
      title=excluded.title,
      bard_name=excluded.bard_name,
      persona_id=excluded.persona_id,
      faithfulness=excluded.faithfulness,
      prompt_version=excluded.prompt_version,
      source_hash=excluded.source_hash,
      source_length=excluded.source_length,
      text=excluded.text
  `)
  runInTx(db, () => {
    deleteStmt.run(campaignId)
    for (const t of (Array.isArray(tales) ? tales : [])) {
      insertStmt.run(
        String(t?.id || crypto.randomUUID()),
        campaignId,
        t?.journalEntryId ? String(t.journalEntryId) : null,
        String(t?.title || t?.journalEntryTitle || 'The Tale').trim(),
        String(t?.bardName || '').trim() || null,
        String(t?.personaId || '').trim() || null,
        String(t?.faithfulness || '').trim() || null,
        String(t?.promptVersion || '').trim() || null,
        String(t?.sourceHash || '').trim() || null,
        Number(t?.sourceLength || 0),
        String(t?.text || t?.tale || ''),
        Number(t?.createdAt || Date.now()),
      )
    }
  })
}

async function loadCampaignDocument(campaignId, base, docKey) {
  const db = dbForCampaignBase(base)
  return sqlLoadCampaignDocument(db, campaignId, docKey)
}

async function persistCampaignDocument(campaignId, base, docKey, value) {
  const db = dbForCampaignBase(base)
  sqlUpsertCampaignDocument(db, campaignId, docKey, value)
  return sqlLoadCampaignDocument(db, campaignId, docKey)
}

async function loadCanonicalStoresSqlPrimary(campaignId, base) {
  const db = dbForCampaignBase(base)
  return sqlLoadCanonicalStores(db, campaignId)
}

async function persistCanonicalStoresSqlPrimary(campaignId, base, canon = {}) {
  const db = dbForCampaignBase(base)
  sqlUpsertCanonicalFromMemory(db, campaignId, canon)
  return sqlLoadCanonicalStores(db, campaignId)
}

async function loadJournalEntriesSqlPrimary(campaignId, base) {
  const db = dbForCampaignBase(base)
  return sqlLoadJournalEntries(db, campaignId)
}

async function persistJournalEntriesSqlPrimary(campaignId, base, entries = []) {
  const allEntries = Array.isArray(entries) ? entries : []
  const MAX_JOURNAL_ENTRIES = 300
  if (allEntries.length > MAX_JOURNAL_ENTRIES) {
    console.warn(`[journal] campaign ${campaignId}: capping ${allEntries.length} entries to ${MAX_JOURNAL_ENTRIES} (oldest removed)`)
  }
  const nextEntries = allEntries.slice(-MAX_JOURNAL_ENTRIES)
  const db = dbForCampaignBase(base)
  sqlReplaceJournalEntries(db, campaignId, nextEntries)
  return sqlLoadJournalEntries(db, campaignId)
}

async function loadBardTalesSqlPrimary(campaignId, base) {
  const db = dbForCampaignBase(base)
  return sqlLoadBardTales(db, campaignId)
}

async function persistBardTalesSqlPrimary(campaignId, base, tales = []) {
  const db = dbForCampaignBase(base)
  sqlReplaceBardTales(db, campaignId, Array.isArray(tales) ? tales : [])
  return sqlLoadBardTales(db, campaignId)
}

async function loadPersistedOpenAiKey() {
  // Env var wins; persisted file is fallback for prototype convenience.
  if (OPENAI_API_KEY) return OPENAI_API_KEY
  try {
    const saved = await readJson(OPENAI_KEY_FILE, { openaiApiKey: '' })
    const key = String(saved?.openaiApiKey || '').trim()
    if (key) {
      OPENAI_API_KEY = key
      return key
    }
  } catch {
    // ignore, keep empty
  }
  return ''
}

async function persistOpenAiKey(key) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(OPENAI_KEY_FILE, { openaiApiKey: String(key || '').trim(), updatedAt: Date.now() })
}

async function loadPersistedAnthropicKey() {
  if (ANTHROPIC_API_KEY) return ANTHROPIC_API_KEY
  try {
    const saved = await readJson(ANTHROPIC_KEY_FILE, { anthropicApiKey: '' })
    const key = String(saved?.anthropicApiKey || '').trim()
    if (key) {
      ANTHROPIC_API_KEY = key
      return key
    }
  } catch {
    // ignore
  }
  return ''
}

async function persistAnthropicKey(key) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(ANTHROPIC_KEY_FILE, { anthropicApiKey: String(key || '').trim(), updatedAt: Date.now() })
}

async function loadPersistedGeminiKey() {
  if (GEMINI_API_KEY) return GEMINI_API_KEY
  try {
    const saved = await readJson(GEMINI_KEY_FILE, { geminiApiKey: '' })
    const key = String(saved?.geminiApiKey || '').trim()
    if (key) {
      GEMINI_API_KEY = key
      return key
    }
  } catch {
    // ignore
  }
  return ''
}

async function persistGeminiKey(key) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(GEMINI_KEY_FILE, { geminiApiKey: String(key || '').trim(), updatedAt: Date.now() })
}

async function loadPersistedPyannoteToken() {
  if (PYANNOTE_HF_TOKEN) return PYANNOTE_HF_TOKEN
  try {
    const saved = await readJson(PYANNOTE_TOKEN_FILE, { pyannoteToken: '' })
    const tok = String(saved?.pyannoteToken || '').trim()
    if (tok) {
      PYANNOTE_HF_TOKEN = tok
      return tok
    }
  } catch {
    // ignore
  }
  return ''
}

async function persistPyannoteToken(token) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(PYANNOTE_TOKEN_FILE, { pyannoteToken: String(token || '').trim(), updatedAt: Date.now() })
}

async function loadPersistedGroqKey() {
  if (GROQ_API_KEY) return GROQ_API_KEY
  try {
    const saved = await readJson(GROQ_KEY_FILE, { groqApiKey: '' })
    const key = String(saved?.groqApiKey || '').trim()
    if (key) { GROQ_API_KEY = key; return key }
  } catch { /* ignore */ }
  return ''
}

async function persistGroqKey(key) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(GROQ_KEY_FILE, { groqApiKey: String(key || '').trim(), updatedAt: Date.now() })
}

async function loadPersistedAsrConfig() {
  try {
    const saved = await readJson(ASR_CONFIG_FILE, {})
    const p = String(saved?.asrProvider || '').trim().toLowerCase()
    if (['remote', 'local', 'groq', 'openai'].includes(p)) ASR_PROVIDER = p
  } catch { /* ignore */ }
}

async function persistAsrConfig() {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(ASR_CONFIG_FILE, { asrProvider: ASR_PROVIDER, updatedAt: Date.now() })
}

function normalizeLexTerm(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function upsertLexiconEntry(lexMap, { term = '', kind = '', role = '', relation = '', aliases = [], notes = '' } = {}) {
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

function normalizeEntityType(value = '') {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return 'term'
  if (['npc', 'quest', 'place', 'event', 'item', 'faction', 'term'].includes(raw)) return raw
  if (['city', 'town', 'region', 'dungeon', 'landmark', 'location'].includes(raw)) return 'place'
  return 'term'
}

function trackerTypeForEntityType(entityType = '') {
  const t = normalizeEntityType(entityType)
  if (t === 'quest' || t === 'npc' || t === 'place') return t
  return null
}

function parseQuestDataFromLegacy(legacy = {}) {
  const status = String(legacy?.status || '').trim()
  const objective = String(legacy?.objective || '').trim()
  const reward = String(legacy?.reward || '').trim()
  const latestUpdate = String(legacy?.update || legacy?.latestUpdate || '').trim()
  return { status, objective, reward, latestUpdate }
}

function makeCanonicalEntity({ campaignId, term = '', entityType = 'term', legacy = {}, source = {} }) {
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

async function ensureCanonicalStores(campaignId, state = null) {
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

async function ensureCampaignDirs(campaignId, options = {}) {
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

async function persistPreAiArtifact(job, { transcript = '', rawSegments = [], inputType = '', extra = {} } = {}) {
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

async function persistPipelineCheckpoint(job, stage, data = {}) {
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

function filesForCampaign(base) {
  return {
    rawSessionsDir: path.join(base, 'sessions'),
    importsDir: path.join(base, 'imports'),
    exportsDir: path.join(base, 'exports'),
    backupsDir: path.join(base, 'backups'),
  }
}

function timestampForFilename(value = Date.now()) {
  return new Date(value).toISOString().replace(/[:.]/g, '-')
}

function escapeSqlString(value = '') {
  return String(value).replace(/'/g, "''")
}

async function buildCampaignExportPayload(campaignId, options = {}) {
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

async function writeCampaignExportFile(campaignId, options = {}) {
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

async function createCampaignSqliteBackup(campaignId) {
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

async function listCampaigns() {
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

async function getCampaignState(campaignId) {
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

async function listCampaignSessions(campaignId) {
  const state = await getCampaignState(campaignId)
  return (state.gameSessions || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

async function upsertGameSession(campaignId, { gameSessionId, newGameSessionTitle, newGameSessionNumber, newGameSessionLabel }) {
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

async function addSourceToGameSession(campaignId, gameSessionId, sourceInfo) {
  const { base } = await ensureCampaignDirs(campaignId)
  const sessions = await loadCampaignDocument(campaignId, base, 'gameSessions')
  const idx = sessions.findIndex((s) => s.id === gameSessionId)
  if (idx === -1) return
  sessions[idx].sourceCount = (sessions[idx].sourceCount || 0) + 1
  sessions[idx].updatedAt = Date.now()
  sessions[idx].lastSource = sourceInfo
  await persistCampaignDocument(campaignId, base, 'gameSessions', sessions)
}

function normalizeNpcName(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\b(count|lord|lady|sir|ser|mr|mrs|ms|dr)\b/g, '')
    .replace(/\b(von|van|de|du|the)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function npcNameVariants(name = '') {
  const base = String(name || '').trim()
  const n = normalizeNpcName(base)
  const variants = new Set([n])
  return Array.from(variants).filter(Boolean)
}

function resolveCanonicalName(inputName = '', canonicalNames = []) {
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

function normalizeSourceForHash(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function sourceHashForText(text = '') {
  return crypto.createHash('sha256').update(normalizeSourceForHash(text), 'utf8').digest('hex')
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))))
}

function parityHashRows(rows = [], keyFn = (x) => x) {
  const payload = (Array.isArray(rows) ? rows : []).map(keyFn).sort()
  return sourceHashForText(JSON.stringify(payload))
}

function extractJson(text, fallback) {
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

function buildFallbackJournal(cleanedTranscript = '', timeline = []) {
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

async function ollamaGenerate(prompt) {
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

async function openaiGenerate(prompt, modelOverride = null) {
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

async function anthropicGenerate(prompt) {
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

async function geminiGenerate(prompt) {
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
function parseGroqRetryAfter(headers, body) {
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
async function transcribeViaGroq(filePath, { onRateLimit, checkCancelled } = {}) {
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
async function transcribeViaOpenAi(filePath) {
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
async function transcribeAudioApiChunked(localPath, totalSecs, onChunkProgress, transcribeFn, { checkCancelled } = {}) {
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

async function llmGenerate(prompt, cfg = null) {
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

async function llmGeneratePipeline(prompt, cfg = null) {
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

async function llmGeneratePipelineWithFallback(prompt, job, stage = 'pipeline') {
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

function pipelineReviewerMeta(job = null) {
  const provider = job?.llmConfig?.provider || LLM_PROVIDER
  const model = job?.llmConfig?.model || LLM_MODEL
  if (PIPELINE_CHATGPT_ONLY) {
    return { reviewerProvider: 'openai', reviewerModel: PIPELINE_OPENAI_MODEL }
  }
  return { reviewerProvider: provider, reviewerModel: model }
}

function estimateEtaSec(job) {
  if (!job.totalChunks || !job.startedAt || !job.doneChunks) return null
  const elapsedSec = Math.max(1, Math.floor((Date.now() - job.startedAt) / 1000))
  const avgPerChunk = elapsedSec / Math.max(1, job.doneChunks)
  const remaining = Math.max(0, job.totalChunks - job.doneChunks)
  return Math.ceil(avgPerChunk * remaining)
}

function assertNotCancelled(job) {
  if (job?.cancelRequested) {
    const err = new Error('Job cancelled by user')
    err.code = 'JOB_CANCELLED'
    throw err
  }
}

function fmtClock(sec = 0) {
  const s = Math.max(0, Math.floor(Number(sec || 0)))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function speakerTranscriptFromMergedLines(lines = []) {
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

async function diarizeSegmentsGuess(segments = []) {
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

async function canonContext(campaignId) {
  const s = await getCampaignState(campaignId)
  const lex = (s.lexicon || []).slice(0, 200).map((x) => `- ${x.term}${x.kind ? ` (${x.kind})` : ''}${x.aliases?.length ? ` aliases: ${x.aliases.join(', ')}` : ''}`)
  const places = (s.places || []).slice(0, 200).map((p) => `- ${p.name}${p.type ? ` (${p.type})` : ''}${p.notes ? `: ${p.notes}` : ''}`)
  const pcs = (s.pcs || []).slice(0, 100).map((p) => `- ${p.characterName || p.name}${p.playerName ? ` [player: ${p.playerName}]` : ''} (${p.race || 'race?'}, ${p.class || 'class?'}, lvl ${p.level || 1})`)
  const dm = s.dmNotes ? `DM Notes:\n${s.dmNotes}\n` : ''
  return `Canon Terms:\n${lex.join('\n') || '- none'}\n\nPlaces:\n${places.join('\n') || '- none'}\n\nPlayer Characters:\n${pcs.join('\n') || '- none'}\n\n${dm}`
}

async function canonLists(campaignId) {
  const s = await getCampaignState(campaignId)
  return {
    npcNames: (s.npcs || []).map((n) => String(n.name || '').trim()).filter(Boolean),
    placeNames: (s.places || []).map((p) => String(p.name || '').trim()).filter(Boolean),
    questNames: (s.quests || []).map((q) => String(q.name || '').trim()).filter(Boolean),
    pcNames: (s.pcs || []).map((p) => String(p.characterName || p.name || '').trim()).filter(Boolean),
    lexTerms: (s.lexicon || []).map((l) => String(l.term || '').trim()).filter(Boolean),
  }
}

function buildNumberedTranscript(raw = '') {
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

function normalizeEvidenceList(value) {
  if (!Array.isArray(value)) return []
  return value.map((x) => String(x || '').trim()).filter(Boolean)
}

function quoteAppearsInRaw(quote = '', raw = '') {
  const q = String(quote || '').trim()
  if (!q) return false
  const hay = String(raw || '')
  if (hay.includes(q)) return true
  const normalize = (s) => String(s || '').toLowerCase().replace(/[“”"'`]/g, '').replace(/\s+/g, ' ').trim()
  return normalize(hay).includes(normalize(q))
}

function dedupeBySummary(items = [], keyFn = (x) => x) {
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

async function queueApproval(campaignId, proposal) {
  const { base } = await ensureCampaignDirs(campaignId)
  const approvals = await loadCampaignDocument(campaignId, base, 'approvals')
  approvals.push(proposal)
  await persistCampaignDocument(campaignId, base, 'approvals', approvals)
}

async function applyApprovedProposal(campaignId, proposalId) {
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

async function rejectProposal(campaignId, proposalId) {
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

async function runLLMStages(job) {
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

async function processAudioJob(jobId) {
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

async function processTranscriptJob(job) {
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
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    asrProvider: ASR_PROVIDER,
    host: `${SSH_USER}@${SSH_HOST}`,
    whisperModel: WHISPER_MODEL,
    whisperDevice: WHISPER_DEVICE,
    chunkSeconds: CHUNK_SECONDS,
    groqModel: GROQ_WHISPER_MODEL,
    hasGroqKey: !!GROQ_API_KEY,
    diarizationMode: DIARIZATION_MODE,
    effectiveDiarizationMode: (DIARIZATION_MODE === 'pyannote' || (DIARIZATION_MODE === 'auto' && !!PYANNOTE_HF_TOKEN)) ? 'pyannote' : 'llm',
    hasPyannoteToken: !!PYANNOTE_HF_TOKEN,
    hasGeminiKey: !!GEMINI_API_KEY,
    llmProvider: LLM_PROVIDER,
    llmModel: LLM_MODEL,
    pipelineChatgptOnly: PIPELINE_CHATGPT_ONLY,
    pipelineOpenaiModel: PIPELINE_OPENAI_MODEL,
    pipelineOpenaiFallbackModel: PIPELINE_OPENAI_FALLBACK_MODEL,
    anthropicRetryMax: ANTHROPIC_RETRY_MAX,
    anthropicRetryBaseMs: ANTHROPIC_RETRY_BASE_MS,
    anthropicMinGapMs: ANTHROPIC_MIN_GAP_MS,
    ollamaBase: OLLAMA_BASE,
  })
})

app.get('/api/llm/config', (_req, res) => {
  res.json({
    ok: true,
    provider: LLM_PROVIDER,
    model: LLM_MODEL,
    providers: ['ollama', 'openai', 'anthropic', 'gemini'],
    pipelineChatgptOnly: PIPELINE_CHATGPT_ONLY,
    pipelineOpenaiModel: PIPELINE_OPENAI_MODEL,
    pipelineOpenaiFallbackModel: PIPELINE_OPENAI_FALLBACK_MODEL,
  })
})

app.get('/api/llm/models', async (_req, res) => {
  const byProvider = {
    ollama: ['qwen2.5:7b', 'llama3.1:8b', 'phi3:mini'],
    openai: [
      'gpt-5.3-chat-latest',
      'gpt-5.3',
      'gpt-5.1',
      'gpt-5-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'o4-mini',
    ],
    anthropic: [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-3-7-sonnet-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
    ],
    gemini: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ],
  }

  // Ollama dynamic list
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) })
    if (r.ok) {
      const j = await r.json()
      const names = (j?.models || []).map((m) => String(m?.name || '').trim()).filter(Boolean)
      if (names.length) byProvider.ollama = names
    }
  } catch {
    // keep fallback static list
  }

  // OpenAI dynamic list (requires key)
  try {
    if (OPENAI_API_KEY) {
      const r = await fetch(`${OPENAI_BASE}/models`, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (r.ok) {
        const j = await r.json()
        const ids = (j?.data || [])
          .map((m) => String(m?.id || '').trim())
          .filter(Boolean)
          .filter((id) => /^(gpt|o\d|o\d-mini|chatgpt)/i.test(id))
        if (ids.length) byProvider.openai = Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
      }
    }
  } catch {
    // keep fallback static list
  }

  // Anthropic dynamic list (requires key)
  try {
    if (ANTHROPIC_API_KEY) {
      const r = await fetch(`${ANTHROPIC_BASE}/models`, {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (r.ok) {
        const j = await r.json()
        const ids = (j?.data || [])
          .map((m) => String(m?.id || '').trim())
          .filter(Boolean)
          .filter((id) => id.startsWith('claude-'))
        if (ids.length) byProvider.anthropic = Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
      }
    }
  } catch {
    // keep fallback static list
  }

  res.json({ ok: true, byProvider })
})

app.put('/api/llm/config', (req, res) => {
  const provider = String(req.body?.provider || '').trim().toLowerCase()
  const model = String(req.body?.model || '').trim()
  if (!['ollama', 'openai', 'anthropic', 'gemini'].includes(provider)) {
    return res.status(400).json({ ok: false, error: 'provider must be ollama|openai|anthropic|gemini' })
  }
  if (!model) return res.status(400).json({ ok: false, error: 'model required' })
  if (provider === 'openai' && !OPENAI_API_KEY) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY missing on server' })
  if (provider === 'anthropic' && !ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY missing on server' })
  if (provider === 'gemini' && !GEMINI_API_KEY) return res.status(400).json({ ok: false, error: 'GEMINI_API_KEY missing on server' })

  LLM_PROVIDER = provider
  LLM_MODEL = model
  res.json({
    ok: true,
    provider: LLM_PROVIDER,
    model: LLM_MODEL,
    note: PIPELINE_CHATGPT_ONLY
      ? `Legacy lock enabled: transcription pipeline is forced to openai/${PIPELINE_OPENAI_MODEL}.`
      : 'Applies to all LLM features including transcription pipeline.',
  })
})

app.get('/api/pipeline/key', async (_req, res) => {
  await loadPersistedOpenAiKey()
  res.json({ ok: true, hasOpenaiKey: !!OPENAI_API_KEY })
})

app.put('/api/pipeline/key', async (req, res) => {
  const key = String(req.body?.openaiApiKey || '').trim()
  if (!key) return res.status(400).json({ ok: false, error: 'openaiApiKey required' })
  if (!key.startsWith('sk-')) return res.status(400).json({ ok: false, error: 'openaiApiKey must look like an OpenAI key (sk-...)' })
  OPENAI_API_KEY = key
  await persistOpenAiKey(key)
  res.json({ ok: true, hasOpenaiKey: true, persisted: true })
})

app.get('/api/anthropic/key', async (_req, res) => {
  await loadPersistedAnthropicKey()
  res.json({ ok: true, hasAnthropicKey: !!ANTHROPIC_API_KEY })
})

app.put('/api/anthropic/key', async (req, res) => {
  const key = String(req.body?.anthropicApiKey || '').trim()
  if (!key) return res.status(400).json({ ok: false, error: 'anthropicApiKey required' })
  if (!key.startsWith('sk-ant-')) return res.status(400).json({ ok: false, error: 'anthropicApiKey must look like an Anthropic key (sk-ant-...)' })
  ANTHROPIC_API_KEY = key
  await persistAnthropicKey(key)
  res.json({ ok: true, hasAnthropicKey: true, persisted: true })
})

app.get('/api/gemini/key', async (_req, res) => {
  await loadPersistedGeminiKey()
  res.json({ ok: true, hasGeminiKey: !!GEMINI_API_KEY })
})

app.put('/api/gemini/key', async (req, res) => {
  const key = String(req.body?.geminiApiKey || '').trim()
  if (!key) return res.status(400).json({ ok: false, error: 'geminiApiKey required' })
  if (!key.startsWith('AIza')) return res.status(400).json({ ok: false, error: 'geminiApiKey must look like a Google API key (AIza...)' })
  GEMINI_API_KEY = key
  await persistGeminiKey(key)
  res.json({ ok: true, hasGeminiKey: true, persisted: true })
})

app.get('/api/pyannote/key', async (_req, res) => {
  await loadPersistedPyannoteToken()
  res.json({ ok: true, hasPyannoteToken: !!PYANNOTE_HF_TOKEN })
})

app.put('/api/pyannote/key', async (req, res) => {
  const key = String(req.body?.pyannoteToken || '').trim()
  if (!key) return res.status(400).json({ ok: false, error: 'pyannoteToken required' })
  if (!key.startsWith('hf_')) return res.status(400).json({ ok: false, error: 'pyannoteToken must look like a Hugging Face token (hf_...)' })
  PYANNOTE_HF_TOKEN = key
  await persistPyannoteToken(key)
  res.json({ ok: true, hasPyannoteToken: true, persisted: true })
})

app.get('/api/groq/key', async (_req, res) => {
  await loadPersistedGroqKey()
  res.json({ ok: true, hasGroqKey: !!GROQ_API_KEY })
})

app.put('/api/groq/key', async (req, res) => {
  const key = String(req.body?.groqApiKey || '').trim()
  if (!key) return res.status(400).json({ ok: false, error: 'groqApiKey required' })
  if (!key.startsWith('gsk_')) return res.status(400).json({ ok: false, error: 'groqApiKey must look like a Groq key (gsk_...)' })
  GROQ_API_KEY = key
  await persistGroqKey(key)
  res.json({ ok: true, hasGroqKey: true, persisted: true })
})

app.get('/api/asr/config', (_req, res) => {
  res.json({
    ok: true,
    asrProvider: ASR_PROVIDER,
    providers: ['remote', 'local', 'groq', 'openai'],
    hasGroqKey: !!GROQ_API_KEY,
    hasOpenaiKey: !!OPENAI_API_KEY,
    whisperModel: WHISPER_MODEL,
    whisperDevice: WHISPER_DEVICE,
    groqModel: GROQ_WHISPER_MODEL,
    remoteHost: `${SSH_USER}@${SSH_HOST}`,
  })
})

app.put('/api/asr/config', async (req, res) => {
  const provider = String(req.body?.asrProvider || '').trim().toLowerCase()
  if (!['remote', 'local', 'groq', 'openai'].includes(provider)) {
    return res.status(400).json({ ok: false, error: 'asrProvider must be remote|local|groq|openai' })
  }
  if (provider === 'groq' && !GROQ_API_KEY) return res.status(400).json({ ok: false, error: 'Groq API key not set — save it first' })
  if (provider === 'openai' && !OPENAI_API_KEY) return res.status(400).json({ ok: false, error: 'OpenAI API key not set — save it first' })
  ASR_PROVIDER = provider
  await persistAsrConfig()
  res.json({ ok: true, asrProvider: ASR_PROVIDER })
})

app.get('/api/campaigns', async (_req, res) => res.json({ ok: true, campaigns: await listCampaigns() }))

app.post('/api/campaigns', withStaticWriteLock('campaigns-root', async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ ok: false, error: 'Campaign name required' })
  const id = `${slugify(name) || 'campaign'}-${crypto.randomUUID().slice(0, 6)}`
  const meta = { id, name, createdAt: Date.now() }
  const { base } = await ensureCampaignDirs(id, { create: true })
  await writeJson(path.join(base, 'meta.json'), meta)
  const db = dbForCampaignBase(base)
  ensureSqlSchema(db)
  res.json({ ok: true, campaign: meta })
}))

app.get('/api/campaigns/:id/state', async (req, res) => {
  const state = await getCampaignState(req.params.id)
  const canon = await ensureCanonicalStores(req.params.id, state)
  res.json({ ok: true, ...state, lexiconEntities: canon.entities, entityAliases: canon.aliases, trackerRows: canon.trackerRows })
})

app.get('/api/campaigns/:id/sql-parity', async (req, res) => {
  const campaignId = req.params.id
  const state = await getCampaignState(campaignId)
  const canon = await ensureCanonicalStores(campaignId, state)
  const { base } = await ensureCampaignDirs(campaignId)
  const db = dbForCampaignBase(base)

  const sqlQuest = sqlTrackerRowsByType(db, campaignId, 'quest')
  const sqlNpc = sqlTrackerRowsByType(db, campaignId, 'npc')
  const sqlPlace = sqlTrackerRowsByType(db, campaignId, 'place')
  const sqlJournal = sqlLoadJournalEntries(db, campaignId)
  const sqlTales = sqlLoadBardTales(db, campaignId)

  const summary = {
    mode: 'sqlite-primary',
    ok: true,
    canonical: {
      entityCount: (canon.entities || []).length,
      aliasCount: (canon.aliases || []).length,
      trackerCount: (canon.trackerRows || []).length,
      entityHash: parityHashRows(canon.entities || [], (e) => `${e.id}|${e.entityType}|${e.canonicalTerm}|${sourceHashForText(JSON.stringify(e.data || {}))}`),
      aliasHash: parityHashRows(canon.aliases || [], (a) => `${a.entityId}|${normalizeLexTerm(a.alias || '')}|${a.source || ''}`),
      trackerHash: parityHashRows(canon.trackerRows || [], (r) => `${r.id}|${r.trackerType}|${r.entityId}|${sourceHashForText(JSON.stringify(r.snapshot || {}))}`),
    },
    trackers: {
      quest: {
        count: sqlQuest.length,
        hash: parityHashRows(sqlQuest, (r) => `${r.entityId}|${r.snapshot?.status || ''}|${r.snapshot?.subtitle || ''}`),
      },
      npc: {
        count: sqlNpc.length,
        hash: parityHashRows(sqlNpc, (r) => `${r.entityId}|${r.snapshot?.subtitle || ''}`),
      },
      place: {
        count: sqlPlace.length,
        hash: parityHashRows(sqlPlace, (r) => `${r.entityId}|${r.snapshot?.subtitle || ''}`),
      },
    },
    journal: {
      count: sqlJournal.length,
      hash: parityHashRows(sqlJournal, (j) => `${j.id}|${sourceHashForText(j.markdown || '')}`),
    },
    bardTales: {
      count: sqlTales.length,
      hash: parityHashRows(sqlTales, (t) => `${t.id}|${sourceHashForText(t.text || t.tale || '')}`),
    },
  }

  res.json({ ok: true, parity: summary })
})

app.get('/api/campaigns/:id/export', withCampaignParamWriteLock(async (req, res) => {
  const includeArtifactIndex = String(req.query?.includeArtifactIndex ?? 'true').toLowerCase() !== 'false'
  const payload = await buildCampaignExportPayload(req.params.id, { includeArtifactIndex })
  res.json({ ok: true, export: payload })
}))

app.post('/api/campaigns/:id/export', withCampaignParamWriteLock(async (req, res) => {
  const includeArtifactIndex = req.body?.includeArtifactIndex !== false
  const exportFile = await writeCampaignExportFile(req.params.id, { includeArtifactIndex })
  res.json({ ok: true, exportFile })
}))

app.post('/api/campaigns/:id/backup', withCampaignParamWriteLock(async (req, res) => {
  const backup = await createCampaignSqliteBackup(req.params.id)
  res.json({ ok: true, backup })
}))

app.post('/api/campaigns/:id/bards-tale', withCampaignParamWriteLock(async (req, res) => {
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

app.post('/api/campaigns/:id/bards-tales', withCampaignParamWriteLock(async (req, res) => {
  const campaignId = req.params.id
  const journalEntryId = String(req.body?.journalEntryId || '').trim()
  const journalEntryTitle = String(req.body?.journalEntryTitle || req.body?.title || 'The Tale').trim()
  const title = String(req.body?.title || journalEntryTitle || 'The Tale').trim()
  const bardTitle = String(req.body?.bardTitle || '').trim()
  const bardName = String(req.body?.bardName || '').trim()
  const personaIdRaw = String(req.body?.personaId || 'grandiose').trim()
  const faithfulnessRaw = String(req.body?.faithfulness || 'dramatic').trim()
  const promptVersion = String(req.body?.promptVersion || BARD_PROMPT_VERSION).trim() || BARD_PROMPT_VERSION
  const tale = String(req.body?.tale || '').trim()
  if (!tale) return res.status(400).json({ ok: false, error: 'tale is required' })

  const persona = BARD_PERSONAS[personaIdRaw] || BARD_PERSONAS.grandiose
  const faithfulness = FAITHFULNESS_RULES[faithfulnessRaw] ? faithfulnessRaw : 'dramatic'

  const sourceText = String(req.body?.journal || '')
  const sourceHash = String(req.body?.sourceHash || sourceHashForText(sourceText)).trim()
  const sourceLength = Number(req.body?.sourceLength || 0) || normalizeSourceForHash(sourceText).length || 0

  const { base } = await ensureCampaignDirs(campaignId)

  const entry = {
    id: crypto.randomUUID(),
    journalEntryId: journalEntryId || null,
    journalEntryTitle,
    title,
    bardTitle: bardTitle || `${title} Bard's Tale`,
    bardName: bardName || persona.bardName,
    personaId: persona.id,
    faithfulness,
    promptVersion,
    sourceHash,
    sourceLength,
    text: tale,
    tale,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  const tales = await loadBardTalesSqlPrimary(campaignId, base)
  tales.unshift(entry)
  await persistBardTalesSqlPrimary(campaignId, base, tales)
  res.json({ ok: true, entry })
}))

app.delete('/api/campaigns/:id/bards-tales/:taleId', withCampaignParamWriteLock(async (req, res) => {
  const campaignId = req.params.id
  const taleId = String(req.params.taleId || '').trim()
  if (!taleId) return res.status(400).json({ ok: false, error: 'taleId required' })

  const { base } = await ensureCampaignDirs(campaignId)
  const tales = await loadBardTalesSqlPrimary(campaignId, base)
  const next = tales.filter((t) => String(t?.id || '') !== taleId)
  if (next.length === tales.length) return res.status(404).json({ ok: false, error: 'tale not found' })

  await persistBardTalesSqlPrimary(campaignId, base, next)
  res.json({ ok: true, deleted: true, taleId })
}))

app.post('/api/campaigns/:id/dm-sneak-peek', withCampaignParamWriteLock(async (req, res) => {
  const campaignId = req.params.id
  const text = String(req.body?.text || '').trim()
  const dueTag = String(req.body?.dueTag || '').trim()
  if (!text) return res.status(400).json({ ok: false, error: 'text required' })

  const { base } = await ensureCampaignDirs(campaignId)
  const items = await loadCampaignDocument(campaignId, base, 'dmSneakPeek')
  const entry = {
    id: crypto.randomUUID(),
    text,
    dueTag,
    done: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  items.push(entry)
  await persistCampaignDocument(campaignId, base, 'dmSneakPeek', items)
  res.json({ ok: true, item: entry })
}))

app.put('/api/campaigns/:id/dm-sneak-peek/:itemId', withCampaignParamWriteLock(async (req, res) => {
  const campaignId = req.params.id
  const itemId = String(req.params.itemId || '').trim()
  if (!itemId) return res.status(400).json({ ok: false, error: 'itemId required' })

  const { base } = await ensureCampaignDirs(campaignId)
  const items = await loadCampaignDocument(campaignId, base, 'dmSneakPeek')
  const idx = items.findIndex((x) => String(x.id || '') === itemId)
  if (idx === -1) return res.status(404).json({ ok: false, error: 'item not found' })

  const current = items[idx]
  const next = {
    ...current,
    text: req.body?.text !== undefined ? String(req.body.text || '').trim() : current.text,
    dueTag: req.body?.dueTag !== undefined ? String(req.body.dueTag || '').trim() : current.dueTag,
    done: req.body?.done !== undefined ? !!req.body.done : !!current.done,
    updatedAt: Date.now(),
  }
  items[idx] = next
  await persistCampaignDocument(campaignId, base, 'dmSneakPeek', items)
  res.json({ ok: true, item: next })
}))

app.delete('/api/campaigns/:id/dm-sneak-peek/:itemId', withCampaignParamWriteLock(async (req, res) => {
  const campaignId = req.params.id
  const itemId = String(req.params.itemId || '').trim()
  if (!itemId) return res.status(400).json({ ok: false, error: 'itemId required' })

  const { base } = await ensureCampaignDirs(campaignId)
  const items = await loadCampaignDocument(campaignId, base, 'dmSneakPeek')
  const next = items.filter((x) => String(x.id || '') !== itemId)
  if (next.length === items.length) return res.status(404).json({ ok: false, error: 'item not found' })
  await persistCampaignDocument(campaignId, base, 'dmSneakPeek', next)
  res.json({ ok: true, deleted: true, itemId })
}))

app.put('/api/campaigns/:id/journal/:entryId', withCampaignParamWriteLock(async (req, res) => {
  const campaignId = req.params.id
  const entryId = String(req.params.entryId || '').trim()
  const markdown = String(req.body?.markdown || '')
  if (!entryId) return res.status(400).json({ ok: false, error: 'entryId required' })

  const { base } = await ensureCampaignDirs(campaignId)
  const journalEntries = await loadJournalEntriesSqlPrimary(campaignId, base)
  const storyDoc = await loadCampaignDocument(campaignId, base, 'storyJournal')

  let updated = false
  const nextJournalEntries = journalEntries.map((e) => {
    if (String(e?.id || '') !== entryId) return e
    updated = true
    return { ...e, markdown, updatedAt: Date.now() }
  })
  storyDoc.entries = (storyDoc.entries || []).map((e) => {
    if (String(e?.id || '') !== entryId) return e
    return { ...e, markdown, updatedAt: Date.now() }
  })

  if (!updated) return res.status(404).json({ ok: false, error: 'Journal entry not found' })

  await persistJournalEntriesSqlPrimary(campaignId, base, nextJournalEntries)
  await persistCampaignDocument(campaignId, base, 'storyJournal', storyDoc)
  res.json({ ok: true })
}))

app.delete('/api/campaigns/:id/journal/:entryId', withCampaignParamWriteLock(async (req, res) => {
  const campaignId = req.params.id
  const entryId = String(req.params.entryId || '').trim()
  if (!entryId) return res.status(400).json({ ok: false, error: 'entryId required' })

  const { base } = await ensureCampaignDirs(campaignId)
  const journalEntries = await loadJournalEntriesSqlPrimary(campaignId, base)
  const storyDoc = await loadCampaignDocument(campaignId, base, 'storyJournal')

  const before = journalEntries.length
  const nextJournalEntries = journalEntries.filter((e) => String(e?.id || '') !== entryId)
  storyDoc.entries = (storyDoc.entries || []).filter((e) => String(e?.id || '') !== entryId)

  if (nextJournalEntries.length === before) return res.status(404).json({ ok: false, error: 'Journal entry not found' })

  await persistJournalEntriesSqlPrimary(campaignId, base, nextJournalEntries)
  await persistCampaignDocument(campaignId, base, 'storyJournal', storyDoc)
  res.json({ ok: true, deleted: true, entryId })
}))

app.get('/api/campaigns/:id/sessions', async (req, res) => res.json({ ok: true, sessions: await listCampaignSessions(req.params.id) }))

app.post('/api/campaigns/:id/sessions', withCampaignParamWriteLock(async (req, res) => {
  try {
    const s = await upsertGameSession(req.params.id, {
      newGameSessionNumber: req.body?.number,
      newGameSessionLabel: req.body?.label,
      newGameSessionTitle: req.body?.title,
    })
    res.json({ ok: true, session: s })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message })
  }
}))

app.delete('/api/campaigns/:id/sessions/:sessionId', withCampaignParamWriteLock(async (req, res) => {
  const { base } = await ensureCampaignDirs(req.params.id)
  const sessions = await loadCampaignDocument(req.params.id, base, 'gameSessions')
  const next = sessions.filter((s) => s.id !== req.params.sessionId)
  if (next.length === sessions.length) return res.status(404).json({ ok: false, error: 'Session not found' })
  await persistCampaignDocument(req.params.id, base, 'gameSessions', next)
  res.json({ ok: true })
}))

app.get('/api/campaigns/:id/pcs', async (req, res) => {
  const state = await getCampaignState(req.params.id)
  res.json({ ok: true, pcs: state.pcs })
})

app.post('/api/campaigns/:id/pcs', withCampaignParamWriteLock(async (req, res) => {
  const { base } = await ensureCampaignDirs(req.params.id)
  const pcs = await loadCampaignDocument(req.params.id, base, 'pcs')
  const pc = {
    id: crypto.randomUUID(),
    playerName: String(req.body?.playerName || '').trim(),
    ddbUsername: String(req.body?.ddbUsername || '').trim(),
    characterName: String(req.body?.characterName || req.body?.name || '').trim(),
    class: String(req.body?.class || '').trim(),
    race: String(req.body?.race || '').trim(),
    level: Number(req.body?.level || 1),
    notes: String(req.body?.notes || '').trim(),
    updatedAt: Date.now(),
  }
  if (!pc.characterName) return res.status(400).json({ ok: false, error: 'Character name required' })
  pcs.push(pc)
  await persistCampaignDocument(req.params.id, base, 'pcs', pcs)
  res.json({ ok: true, pc })
}))

app.put('/api/campaigns/:id/pcs/:pcId', withCampaignParamWriteLock(async (req, res) => {
  const { base } = await ensureCampaignDirs(req.params.id)
  const pcs = await loadCampaignDocument(req.params.id, base, 'pcs')
  const idx = pcs.findIndex((p) => p.id === req.params.pcId)
  if (idx === -1) return res.status(404).json({ ok: false, error: 'PC not found' })

  const updated = {
    ...pcs[idx],
    playerName: String(req.body?.playerName ?? pcs[idx].playerName ?? '').trim(),
    ddbUsername: String(req.body?.ddbUsername ?? pcs[idx].ddbUsername ?? '').trim(),
    characterName: String(req.body?.characterName ?? pcs[idx].characterName ?? '').trim(),
    class: String(req.body?.class ?? pcs[idx].class ?? '').trim(),
    race: String(req.body?.race ?? pcs[idx].race ?? '').trim(),
    level: Number(req.body?.level ?? pcs[idx].level ?? 1),
    notes: String(req.body?.notes ?? pcs[idx].notes ?? '').trim(),
    sourceType: String(req.body?.sourceType ?? pcs[idx].sourceType ?? '').trim(),
    sourceUrl: String(req.body?.sourceUrl ?? pcs[idx].sourceUrl ?? '').trim(),
    avatarUrl: String(req.body?.avatarUrl ?? pcs[idx].avatarUrl ?? '').trim(),
    lastSyncedAt: req.body?.lastSyncedAt ?? pcs[idx].lastSyncedAt ?? null,
    updatedAt: Date.now(),
  }
  if (!updated.characterName) return res.status(400).json({ ok: false, error: 'Character name required' })

  pcs[idx] = updated
  await persistCampaignDocument(req.params.id, base, 'pcs', pcs)
  res.json({ ok: true, pc: updated })
}))

app.delete('/api/campaigns/:id/pcs/:pcId', withCampaignParamWriteLock(async (req, res) => {
  const { base } = await ensureCampaignDirs(req.params.id)
  const pcs = await loadCampaignDocument(req.params.id, base, 'pcs')
  const next = pcs.filter((p) => p.id !== req.params.pcId)
  if (next.length === pcs.length) return res.status(404).json({ ok: false, error: 'PC not found' })
  await persistCampaignDocument(req.params.id, base, 'pcs', next)
  res.json({ ok: true })
}))

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
  const { base } = await ensureCampaignDirs(req.params.id)
  const pcs = await loadCampaignDocument(req.params.id, base, 'pcs')

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

    await persistCampaignDocument(req.params.id, base, 'pcs', pcs)
    res.json({ ok: true, pc })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message })
  }
}))

app.post('/api/campaigns/:id/pcs/:pcId/link-dndbeyond', withCampaignParamWriteLock(async (req, res) => {
  const { base } = await ensureCampaignDirs(req.params.id)
  const pcs = await loadCampaignDocument(req.params.id, base, 'pcs')
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
  await persistCampaignDocument(req.params.id, base, 'pcs', pcs)
  res.json({ ok: true, pc: pcs[idx] })
}))

app.post('/api/campaigns/:id/pcs/:pcId/sync-dndbeyond', withCampaignParamWriteLock(async (req, res) => {
  const { base } = await ensureCampaignDirs(req.params.id)
  const pcs = await loadCampaignDocument(req.params.id, base, 'pcs')
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
    await persistCampaignDocument(req.params.id, base, 'pcs', pcs)
    res.json({ ok: true, pc: pcs[idx] })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message })
  }
}))

app.put('/api/campaigns/:id/npcs/update', withCampaignParamWriteLock(async (req, res) => {
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

app.post('/api/campaigns/:id/lexicon', withCampaignParamWriteLock(async (req, res) => {
  const { base } = await ensureCampaignDirs(req.params.id)
  const lexicon = await loadCampaignDocument(req.params.id, base, 'lexicon')

  const term = String(req.body?.term || '').trim()
  const kind = String(req.body?.kind || '').trim()
  const role = String(req.body?.role || '').trim()
  const relation = String(req.body?.relation || '').trim()
  const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases.map((x) => String(x).trim()).filter(Boolean) : []
  const notes = String(req.body?.notes || '').trim()

  if (!term) return res.status(400).json({ ok: false, error: 'term required' })

  const lexMap = new Map((lexicon || []).map((l) => [normalizeLexTerm(l.term || ''), l]))
  const merged = upsertLexiconEntry(lexMap, { term, kind, role, relation, aliases, notes })

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
  const { base } = await ensureCampaignDirs(req.params.id)
  const f = filesForCampaign(base)
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
  const { base } = await ensureCampaignDirs(req.params.id)
  const f = filesForCampaign(base)
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

app.get('/api/campaigns/:id/trackers/:type', async (req, res) => {
  const type = String(req.params.type || '').trim().toLowerCase()
  const allowed = new Set(['quest', 'npc', 'place', 'event'])
  if (!allowed.has(type)) return res.status(400).json({ ok: false, error: 'Unsupported tracker type' })

  const canon = await ensureCanonicalStores(req.params.id)
  const rows = (canon.trackerRows || []).filter((r) => String(r?.trackerType || '') === type)
  const entitiesById = new Map((canon.entities || []).map((e) => [String(e?.id || ''), e]))
  const linked = rows.map((row) => ({ ...row, entity: entitiesById.get(String(row?.entityId || '')) || null }))
  return res.json({ ok: true, rows: linked, source: 'sql' })
})

app.post('/api/campaigns/:id/rebuild-trackers-from-lexicon', withCampaignParamWriteLock(async (req, res) => {
  const { base } = await ensureCampaignDirs(req.params.id)
  const f = filesForCampaign(base)
  const canon = await ensureCanonicalStores(req.params.id)
  const trackerRows = []

  for (const entity of (canon.entities || [])) {
    const entityType = String(entity?.entityType || '').trim()
    if (!['quest', 'npc', 'place'].includes(entityType)) continue
    trackerRows.push({
      id: crypto.randomUUID(),
      campaignId: req.params.id,
      trackerType: entityType,
      entityId: entity.id,
      snapshot: entityType === 'quest'
        ? {
            status: String(entity?.data?.status || '').trim() || 'Unknown',
            subtitle: String(entity?.data?.objective || entity?.data?.latestUpdate || '').trim(),
          }
        : {
            subtitle: String(entity?.notes || '').trim(),
          },
      linkMethod: 'rebuild',
      linkConfidence: 1,
      updatedAt: Date.now(),
    })
  }

  await persistCanonicalStoresSqlPrimary(req.params.id, base, { entities: canon.entities || [], aliases: canon.aliases || [], trackerRows })
  res.json({ ok: true, rebuilt: trackerRows.length })
}))

app.delete('/api/campaigns/:id/lexicon/:termId', withCampaignParamWriteLock(async (req, res) => {
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

// Reset (clear) all lexicon entries for a campaign.
// Takes a backup of the lexicon doc + entities snapshot first, then wipes both stores.
app.delete('/api/campaigns/:id/lexicon', withCampaignParamWriteLock(async (req, res) => {
  const campaignId = req.params.id
  try {
    const { base } = await ensureCampaignDirs(campaignId)

    // --- snapshot before wipe ---
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

    // --- wipe ---
    const db = dbForCampaignBase(base)
    db.prepare('DELETE FROM lexicon_entities WHERE campaign_id = ?').run(campaignId)
    // entity_aliases cascades via ON DELETE CASCADE from lexicon_entities
    await persistCampaignDocument(campaignId, base, 'lexicon', [])
    // Prevent ensureCanonicalStores from immediately re-backfilling from npcs/places/quests docs
    await persistCampaignDocument(campaignId, base, 'lexiconMeta', { skipLegacyBackfill: true, resetAt: stamp })

    const removedEntities = (canon.entities || []).length
    const removedAliases = (canon.aliases || []).length

    res.json({ ok: true, removed: { entities: removedEntities, aliases: removedAliases }, backupPath })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to reset lexicon' })
  }
}))

app.post('/api/campaigns/:id/places', withCampaignParamWriteLock(async (req, res) => {
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

app.put('/api/campaigns/:id/dm-notes', withCampaignParamWriteLock(async (req, res) => {
  const { base } = await ensureCampaignDirs(req.params.id)
  const text = String(req.body?.text || '')
  await persistCampaignDocument(req.params.id, base, 'dmNotes', { text, updatedAt: Date.now() })
  res.json({ ok: true })
}))

app.post('/api/campaigns/:id/module-pdf', upload.single('module'), withCampaignParamWriteLock(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No PDF uploaded. Use form field name: module' })
  const campaignId = req.params.id

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
      reviewerProvider: LLM_PROVIDER,
      reviewerModel: LLM_MODEL,
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

app.post('/api/campaigns/:id/data-browser/import', withCampaignParamWriteLock(async (req, res) => {
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
          // Build a compact properties header from the properties object
          const props = r?.properties && typeof r.properties === 'object' ? r.properties : {}
          const propParts = Object.entries(props)
            .filter(([k]) => !['Category', 'Expansion'].includes(k))
            .map(([k, v]) => `${k}: ${v}`)
          const propsHeader = propParts.length ? propParts.join(' · ') : ''
          // Strip the item name from the front of the description (dnd-data prepends it)
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

app.get('/api/campaigns/:id/approvals', async (req, res) => {
  const state = await getCampaignState(req.params.id)
  res.json({ ok: true, approvals: state.approvals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) })
})

app.post('/api/campaigns/:id/approvals/:proposalId/approve', withCampaignParamWriteLock(async (req, res) => {
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
  await rejectProposal(req.params.id, req.params.proposalId)
  res.json({ ok: true })
}))

app.post('/api/campaigns/:id/approvals/:proposalId/approve-selected', withCampaignParamWriteLock(async (req, res) => {
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

app.post('/api/campaigns/:id/player-submissions', withCampaignParamWriteLock(async (req, res) => {
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
    .filter((x) => /^".*"$/.test(x) || /^“.*”$/.test(x))
    .map((x) => x.replace(/^"|"$/g, '').replace(/^“|”$/g, ''))
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
  const campaignId = req.params.id
  const text = String(req.body?.text || '').trim()
  const speaker = String(req.body?.speaker || '').trim()
  const playerName = String(req.body?.playerName || '').trim()
  const gameSessionId = String(req.body?.gameSessionId || '').trim() || null
  const tag = String(req.body?.tag || '').trim()

  if (!text) return res.status(400).json({ ok: false, error: 'text required' })

  const { base } = await ensureCampaignDirs(campaignId)
  const f = filesForCampaign(base)
  const state = await getCampaignState(campaignId)

  const normalized = text.replace(/^"|"$/g, '').replace(/^“|”$/g, '').trim()
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

app.post('/api/transcribe', upload.single('audio'), withCampaignBodyWriteLock(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No audio file uploaded. Use form field name: audio' })

  // Enforce per-server concurrent job limit before accepting the upload.
  const activeJobCount = [...jobs.values()].filter((j) => !['done', 'error', 'cancelled'].includes(String(j.status || ''))).length
  if (activeJobCount >= MAX_CONCURRENT_JOBS) {
    await fs.unlink(req.file.path).catch(() => {})
    return res.status(429).json({ ok: false, error: `Too many active jobs (${activeJobCount}/${MAX_CONCURRENT_JOBS}). Wait for a running job to finish before submitting another.` })
  }

  const campaignId = String(req.body?.campaignId || '').trim()
  if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required' })

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
  })

  processAudioJob(jobId)
  res.json({ ok: true, jobId, status: 'queued', stage: 'queued' })
}))

app.post('/api/transcribe-text', upload.single('transcript'), withCampaignBodyWriteLock(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No transcript file uploaded. Use form field name: transcript' })

  // Enforce per-server concurrent job limit.
  const activeJobCountTxt = [...jobs.values()].filter((j) => !['done', 'error', 'cancelled'].includes(String(j.status || ''))).length
  if (activeJobCountTxt >= MAX_CONCURRENT_JOBS) {
    await fs.unlink(req.file.path).catch(() => {})
    return res.status(429).json({ ok: false, error: `Too many active jobs (${activeJobCountTxt}/${MAX_CONCURRENT_JOBS}). Wait for a running job to finish before submitting another.` })
  }

  const campaignId = String(req.body?.campaignId || '').trim()
  if (!campaignId) return res.status(400).json({ ok: false, error: 'campaignId is required' })

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

app.get('/api/transcribe/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' })
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
    diarizationMode: DIARIZATION_MODE,
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

app.post('/api/transcribe/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' })

  if (['done', 'error', 'cancelled'].includes(String(job.status || ''))) {
    return res.json({ ok: true, id: job.id, status: job.status, stage: job.stage, message: 'Job already terminal' })
  }

  job.cancelRequested = true
  job.updatedAt = Date.now()
  job.stage = 'cancelling'
  job.status = 'running'

  return res.json({ ok: true, id: job.id, cancelRequested: true, status: job.status, stage: job.stage })
})

if (existsSync(DIST_INDEX_FILE)) {
  app.use(express.static(DIST_DIR, { index: false }))
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(DIST_INDEX_FILE)
  })
}

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      ok: false,
      error: `Uploaded file exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit`,
    })
  }

  const statusCode = Number(error?.statusCode) || 500
  if (statusCode >= 500) console.error(error)

  const message = error instanceof DataIntegrityError
    ? 'Stored campaign data is corrupted. Fix or remove the invalid JSON file before retrying.'
    : statusCode >= 500
      ? 'Internal server error'
      : (error?.message || 'Request failed')

  res.status(statusCode).json({
    ok: false,
    error: message,
  })
})

app.listen(PORT, async () => {
  await fs.mkdir(CAMPAIGNS_DIR, { recursive: true })
  await loadPersistedOpenAiKey()
  await loadPersistedAnthropicKey()
  await loadPersistedGeminiKey()
  await loadPersistedPyannoteToken()
  await loadPersistedGroqKey()
  await loadPersistedAsrConfig()
  loadJobsFromDb()
  console.log(`DND API listening on http://localhost:${PORT}`)
})
