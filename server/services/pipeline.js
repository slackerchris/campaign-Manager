/**
 * Pipeline service — in-memory job management, LLM generation, ASR transcription,
 * and the full audio/transcript processing pipeline.
 *
 * All mutable config vars are imported as live ESM bindings from config.js.
 * Assignments use the exported setters (e.g. setAnthropicNextAllowedAt).
 */
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import multer from 'multer'

// Config vars — live ESM bindings, read-only but always current
import {
  LLM_PROVIDER, LLM_MODEL, snapshotLlmConfig,
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY,
  PYANNOTE_HF_TOKEN, anthropicNextAllowedAt, setAnthropicNextAllowedAt,
  setOpenaiApiKey, setAnthropicApiKey, setGeminiApiKey, setGroqApiKey, setPyannoteHfToken,
  setAsrProvider,
  ASR_PROVIDER,
  WHISPER_LOCAL_BASE, WHISPER_LOCAL_PATH, WHISPER_LOCAL_MODEL,
  WHISPER_LOCAL_API_KEY, WHISPER_LOCAL_API_KEY_HEADER,
  setWhisperLocalBase, setWhisperLocalPath, setWhisperLocalModel,
  setWhisperLocalApiKey, setWhisperLocalApiKeyHeader,
  WHISPER_MODEL, WHISPER_DEVICE, CHUNK_SECONDS,
  GROQ_BASE, GROQ_WHISPER_MODEL,
  DIARIZATION_MODE, DIARIZATION_ASR_MODEL, DIARIZATION_ASR_DEVICE,
  DIARIZATION_COMPUTE_TYPE, DIARIZATION_PYANNOTE_DEVICE,
  OLLAMA_BASE, OPENAI_BASE, ANTHROPIC_BASE, GEMINI_BASE,
  PIPELINE_CHATGPT_ONLY, PIPELINE_OPENAI_MODEL, PIPELINE_OPENAI_FALLBACK_MODEL,
  ANTHROPIC_RETRY_MAX, ANTHROPIC_RETRY_BASE_MS, ANTHROPIC_MIN_GAP_MS,
  SSH_KEY_PATH, SSH_USER, SSH_HOST, REMOTE_AUDIO_DIR,
  MAX_UPLOAD_BYTES, JOB_RETENTION_MS, MAX_RETAINED_JOBS, MAX_CONCURRENT_JOBS,
  DATA_DIR, CAMPAIGNS_DIR, DIST_DIR,
  OPENAI_KEY_FILE, ANTHROPIC_KEY_FILE, GEMINI_KEY_FILE,
  PYANNOTE_TOKEN_FILE, GROQ_KEY_FILE, ASR_CONFIG_FILE, SECRETS_DIR,
  BARD_PROMPT_VERSION,
  envNumber,
} from '../config.js'

import * as jobsRepo from '../db/postgres/repositories/jobs.repo.js'
import * as artifactsRepo from '../db/postgres/repositories/artifacts.repo.js'
import { diagnosticRuntimeSnapshot, recentDiagnosticLogs } from './diagnostics.js'

// Imported for dual-write hooks and campaign state access
import {
  persistCampaignDocument,
  ensureCampaignDirs,
  addSourceToGameSession,
  queueApproval,
  persistCanonicalStoresSqlPrimary,
  persistJournalEntriesSqlPrimary,
  persistBardTalesSqlPrimary,
  getPgCampaignId,
  getCampaignState,
  loadCampaignDocument,
  filesForCampaign,
  normalizeLexTerm,
  upsertLexiconEntry,
  makeCanonicalEntity,
  parseQuestDataFromLegacy,
  ensureCanonicalStores,
  normalizeEntityType,
  trackerTypeForEntityType,
  normalizeLexTerm as _normalizeLexTerm,
} from './campaign.js'

import { readJson, writeJson, runWithCampaignWriteLock } from '../utils.js'

const execFileAsync = promisify(execFile)

// GROQ_RETRY_MAX not in config.js — define locally
const GROQ_RETRY_MAX = envNumber(process.env.GROQ_RETRY_MAX, 5, 0)

// ── In-memory job store ───────────────────────────────────────────────────────

export const jobs = new Map()
const jobCleanupTimers = new Map()

// ── Job Postgres persistence ──────────────────────────────────────────────────

export function persistJobToPg(job) {
  jobsRepo.finishJob(job.id, job).catch((err) =>
    console.error(`[pg-jobs] finishJob ${job.id}:`, err.message)
  )
}

export async function loadJobsFromPg() {
  try {
    const loaded = await jobsRepo.loadRecentJobs(200)
    for (const job of loaded) {
      if (job?.id && !jobs.has(job.id)) jobs.set(job.id, job)
    }
  } catch (err) {
    console.error('[pg-jobs] loadRecentJobs error:', err.message)
  }
}

function pruneJobsPg() {
  jobsRepo.pruneOldJobs(200).catch((err) =>
    console.error('[pg-jobs] pruneOldJobs error:', err.message)
  )
}

// ── Job lifecycle helpers ─────────────────────────────────────────────────────

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

export function scheduleJobCleanup(job) {
  if (!job?.id) return

  clearJobCleanup(job.id)

  // Persist to Postgres before any cleanup so restart-then-poll returns terminal state
  if (['done', 'error', 'cancelled'].includes(String(job.status || ''))) {
    persistJobToPg(job)
    pruneJobsPg()
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

export function trackJob(job) {
  clearJobCleanup(job.id)
  const isNew = !jobs.has(job.id)
  jobs.set(job.id, job)
  pruneJobs()
  if (isNew) {
    getPgCampaignId(job.campaignId).then((pgId) => {
      if (pgId) return jobsRepo.createJob(pgId, job)
    }).catch((err) => console.error(`[pg-jobs] createJob ${job.id}:`, err.message))
  }
}

// ── Key persistence ───────────────────────────────────────────────────────────

export async function loadPersistedOpenAiKey() {
  if (OPENAI_API_KEY) return OPENAI_API_KEY
  try {
    const saved = await readJson(OPENAI_KEY_FILE, { openaiApiKey: '' })
    const key = String(saved?.openaiApiKey || '').trim()
    if (key) {
      setOpenaiApiKey(key)
      return key
    }
  } catch {
    // ignore, keep empty
  }
  return ''
}

export async function persistOpenAiKey(key) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(OPENAI_KEY_FILE, { openaiApiKey: String(key || '').trim(), updatedAt: Date.now() })
}

export async function loadPersistedAnthropicKey() {
  if (ANTHROPIC_API_KEY) return ANTHROPIC_API_KEY
  try {
    const saved = await readJson(ANTHROPIC_KEY_FILE, { anthropicApiKey: '' })
    const key = String(saved?.anthropicApiKey || '').trim()
    if (key) {
      setAnthropicApiKey(key)
      return key
    }
  } catch {
    // ignore
  }
  return ''
}

export async function persistAnthropicKey(key) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(ANTHROPIC_KEY_FILE, { anthropicApiKey: String(key || '').trim(), updatedAt: Date.now() })
}

export async function loadPersistedGeminiKey() {
  if (GEMINI_API_KEY) return GEMINI_API_KEY
  try {
    const saved = await readJson(GEMINI_KEY_FILE, { geminiApiKey: '' })
    const key = String(saved?.geminiApiKey || '').trim()
    if (key) {
      setGeminiApiKey(key)
      return key
    }
  } catch {
    // ignore
  }
  return ''
}

export async function persistGeminiKey(key) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(GEMINI_KEY_FILE, { geminiApiKey: String(key || '').trim(), updatedAt: Date.now() })
}

export async function loadPersistedPyannoteToken() {
  if (PYANNOTE_HF_TOKEN) return PYANNOTE_HF_TOKEN
  try {
    const saved = await readJson(PYANNOTE_TOKEN_FILE, { pyannoteToken: '' })
    const tok = String(saved?.pyannoteToken || '').trim()
    if (tok) {
      setPyannoteHfToken(tok)
      return tok
    }
  } catch {
    // ignore
  }
  return ''
}

export async function persistPyannoteToken(token) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(PYANNOTE_TOKEN_FILE, { pyannoteToken: String(token || '').trim(), updatedAt: Date.now() })
}

export async function loadPersistedGroqKey() {
  if (GROQ_API_KEY) return GROQ_API_KEY
  try {
    const saved = await readJson(GROQ_KEY_FILE, { groqApiKey: '' })
    const key = String(saved?.groqApiKey || '').trim()
    if (key) { setGroqApiKey(key); return key }
  } catch { /* ignore */ }
  return ''
}

export async function persistGroqKey(key) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(GROQ_KEY_FILE, { groqApiKey: String(key || '').trim(), updatedAt: Date.now() })
}

export async function loadPersistedAsrConfig() {
  try {
    const saved = await readJson(ASR_CONFIG_FILE, {})
    const p = String(saved?.asrProvider || '').trim().toLowerCase()
    if (['remote', 'local', 'groq', 'openai', 'whisper-local'].includes(p)) setAsrProvider(p)
    if (saved?.whisperLocalBase) setWhisperLocalBase(String(saved.whisperLocalBase).trim())
    if (saved?.whisperLocalPath) setWhisperLocalPath(String(saved.whisperLocalPath).trim())
    if (saved?.whisperLocalModel) setWhisperLocalModel(String(saved.whisperLocalModel).trim())
    if (saved?.whisperLocalApiKey) setWhisperLocalApiKey(String(saved.whisperLocalApiKey).trim())
    if (saved?.whisperLocalApiKeyHeader) setWhisperLocalApiKeyHeader(String(saved.whisperLocalApiKeyHeader).trim())
  } catch { /* ignore */ }
}

export async function persistAsrConfig() {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(ASR_CONFIG_FILE, {
    asrProvider: ASR_PROVIDER,
    whisperLocalBase: WHISPER_LOCAL_BASE,
    whisperLocalPath: WHISPER_LOCAL_PATH,
    whisperLocalModel: WHISPER_LOCAL_MODEL,
    whisperLocalApiKey: WHISPER_LOCAL_API_KEY,
    whisperLocalApiKeyHeader: WHISPER_LOCAL_API_KEY_HEADER,
    updatedAt: Date.now(),
  })
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export async function run(cmd, args) {
  return execFileAsync(cmd, args, { maxBuffer: 1024 * 1024 * 80 })
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

export function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))))
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

// ── LLM config snapshot ───────────────────────────────────────────────────────

export { snapshotLlmConfig }

export async function loadDmJobConfig(userId) {
  if (!userId) return snapshotLlmConfig()
  try {
    const [settingsModule, secretsModule] = await Promise.all([
      import('../db/postgres/repositories/settings.repo.js'),
      import('../db/postgres/repositories/secrets.repo.js'),
    ])
    const pref = await settingsModule.getUserSetting(userId, 'llm_preference').catch(() => null)
    const provider = pref?.provider || LLM_PROVIDER
    const model = pref?.model || LLM_MODEL
    const secretKeyMap = { openai: 'openai_api_key', anthropic: 'anthropic_api_key', gemini: 'gemini_api_key', groq: 'groq_api_key' }
    const secretKey = secretKeyMap[provider]
    const apiKey = secretKey
      ? await secretsModule.getUserSecret(userId, secretKey).catch(() => null) || null
      : null
    return { provider, model, apiKey }
  } catch {
    return snapshotLlmConfig()
  }
}

// ── LLM generation ────────────────────────────────────────────────────────────

async function ollamaGenerate(prompt) {
  const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, prompt, stream: false }),
    signal: AbortSignal.timeout(180000),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Ollama HTTP ${r.status}${body ? `: ${body.slice(0, 240)}` : ''}`)
  }
  const j = await r.json()
  return j.response || ''
}

async function openaiGenerate(prompt, modelOverride = null, apiKey = null) {
  const key = apiKey || OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not configured')
  const model = modelOverride || LLM_MODEL
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
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

async function anthropicGenerate(prompt, model = null, apiKey = null) {
  const key = apiKey || ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured')
  const resolvedModel = model || LLM_MODEL

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
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: 4096,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(180000),
    })

    if (r.ok) {
      setAnthropicNextAllowedAt(Date.now() + ANTHROPIC_MIN_GAP_MS)
      const j = await r.json()
      const txt = (j?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
      return txt || ''
    }

    if (r.status === 429 && attempt <= ANTHROPIC_RETRY_MAX) {
      const retryAfterHeader = Number(r.headers.get('retry-after') || 0)
      const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : (ANTHROPIC_RETRY_BASE_MS * (2 ** (attempt - 1))) + Math.floor(Math.random() * 400)
      setAnthropicNextAllowedAt(Date.now() + Math.max(retryAfterMs, ANTHROPIC_MIN_GAP_MS))
      await sleep(Math.max(retryAfterMs, ANTHROPIC_MIN_GAP_MS))
      lastErr = new Error(`Anthropic HTTP 429 (retry ${attempt}/${ANTHROPIC_RETRY_MAX})`)
      continue
    }

    const body = await r.text().catch(() => '')
    throw new Error(`Anthropic HTTP ${r.status}${body ? `: ${body.slice(0, 240)}` : ''}`)
  }

  throw lastErr || new Error('Anthropic HTTP 429 after retries')
}

async function geminiGenerate(prompt, model = null, apiKey = null) {
  const key = apiKey || GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not configured')
  const resolvedModel = String(model || LLM_MODEL || 'gemini-2.5-flash').trim()
  const r = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(resolvedModel)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
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

export async function llmGenerate(prompt, cfg = null) {
  const provider = cfg?.provider || LLM_PROVIDER
  const model = cfg?.model || LLM_MODEL
  const apiKey = cfg?.apiKey || null
  try {
    if (provider === 'openai') return await openaiGenerate(prompt, model, apiKey)
    if (provider === 'anthropic') return await anthropicGenerate(prompt, model, apiKey)
    if (provider === 'gemini') return await geminiGenerate(prompt, model, apiKey)
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
      const out = await openaiGenerate(prompt, fallbackModel, job.llmConfig?.openaiApiKey || OPENAI_API_KEY)
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

// ── Bard constants ────────────────────────────────────────────────────────────

export const BARD_PERSONAS = {
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

export const FAITHFULNESS_RULES = {
  close: `- Stay close to the journal entry.\n- Preserve structure and order where possible.\n- Use light stylistic flair only.\n- Do not heighten emotions beyond what is already implied.`,
  dramatic: `- Preserve all core facts, but use moderate dramatic flourish.\n- You may compress or slightly reorder details for flow.\n- Emphasize emotional beats and tension.\n- Do not add new facts, characters, items, or events.`,
  performance: `- Preserve all core facts, but tell them with full theatrical energy.\n- You may strongly heighten tone, rhythm, and emotional emphasis.\n- You may compress and reorder for performance flow.\n- Do not add new facts, characters, items, or events.`,
}

// ── ASR helpers ───────────────────────────────────────────────────────────────

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

async function transcribeViaWhisperLocal(filePath) {
  const fileData = await fs.readFile(filePath)
  const formData = new FormData()
  formData.append('file', new Blob([fileData]), path.basename(filePath))
  formData.append('model', WHISPER_LOCAL_MODEL)
  formData.append('language', 'en')
  formData.append('response_format', 'verbose_json')
  const base = WHISPER_LOCAL_BASE.replace(/\/+$/, '')
  const apiPath = WHISPER_LOCAL_PATH.startsWith('/') ? WHISPER_LOCAL_PATH : `/${WHISPER_LOCAL_PATH}`
  const headers = {}
  if (WHISPER_LOCAL_API_KEY) headers[WHISPER_LOCAL_API_KEY_HEADER || 'X-API-Key'] = WHISPER_LOCAL_API_KEY
  const r = await fetch(`${base}${apiPath}`, {
    method: 'POST',
    headers,
    body: formData,
    signal: AbortSignal.timeout(300000),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Whisper local API HTTP ${r.status}${body ? `: ${body.slice(0, 240)}` : ''}`)
  }
  const j = await r.json()
  return { text: String(j?.text || '').trim(), segments: Array.isArray(j?.segments) ? j.segments : [] }
}

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

// ── Artifact persistence ──────────────────────────────────────────────────────

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
  getPgCampaignId(job.campaignId).then((pgId) => {
    if (pgId) return artifactsRepo.recordArtifact(pgId, job.id, {
      artifactType: `pre-ai-${inputType || job.type}`,
      storagePath: outPath,
      metadata: { sourceId: job.sourceId, sourceLabel: job.sourceLabel, gameSessionId: job.gameSessionId },
    })
  }).catch(() => {})
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
  getPgCampaignId(job.campaignId).then((pgId) => {
    if (pgId) return artifactsRepo.recordArtifact(pgId, job.id, {
      artifactType: `checkpoint-${stage}`,
      storagePath: outPath,
      metadata: { sourceId: job.sourceId, stage },
    })
  }).catch(() => {})
  return outPath
}

// ── Pipeline stage helpers ────────────────────────────────────────────────────

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
  const normalize = (s) => String(s || '').toLowerCase().replace(/["""'`]/g, '').replace(/\s+/g, ' ').trim()
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

function normalizeNpcName(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/['']/g, '')
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

// ── Main LLM pipeline stages ──────────────────────────────────────────────────

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

// ── Main job processors ───────────────────────────────────────────────────────

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
      await run('ssh', ['-i', SSH_KEY_PATH, `${SSH_USER}@${SSH_HOST}`, `mkdir -p ${REMOTE_AUDIO_DIR} ${REMOTE_AUDIO_DIR.replace('audio-in', 'audio-out')}`])
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
      const REMOTE_OUT_DIR = REMOTE_AUDIO_DIR.replace('audio-in', 'audio-out')
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
      // groq, openai, or whisper-local — API-based chunked upload
      const providerLabel = asrProvider === 'groq'
        ? `Groq (${GROQ_WHISPER_MODEL})`
        : asrProvider === 'whisper-local'
          ? `Whisper Local (${WHISPER_LOCAL_MODEL})`
          : 'OpenAI (whisper-1)'
      const checkCancelled = () => assertNotCancelled(job)
      const transcribeFn = asrProvider === 'groq'
        ? (fp) => transcribeViaGroq(fp, {
            onRateLimit: (waitSec, attempt, maxAttempts) => {
              job.stage = `Groq rate-limited — waiting ${waitSec}s (retry ${attempt}/${maxAttempts})…`
              job.updatedAt = Date.now()
            },
            checkCancelled,
          })
        : asrProvider === 'whisper-local'
          ? transcribeViaWhisperLocal
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

// ── Runtime config getters (used by health + settings routes) ─────────────────

export function getRuntimeConfig() {
  return {
    asrProvider: ASR_PROVIDER,
    whisperLocalBase: WHISPER_LOCAL_BASE,
    whisperLocalPath: WHISPER_LOCAL_PATH,
    whisperLocalModel: WHISPER_LOCAL_MODEL,
    whisperLocalApiKeyHeader: WHISPER_LOCAL_API_KEY_HEADER,
    hasWhisperLocalApiKey: !!WHISPER_LOCAL_API_KEY,
    groqBase: GROQ_BASE,
    groqWhisperModel: GROQ_WHISPER_MODEL,
    hasGroqKey: !!GROQ_API_KEY,
    hasOpenaiKey: !!OPENAI_API_KEY,
    hasAnthropicKey: !!ANTHROPIC_API_KEY,
    hasGeminiKey: !!GEMINI_API_KEY,
    hasPyannoteToken: !!PYANNOTE_HF_TOKEN,
    whisperModel: WHISPER_MODEL,
    whisperDevice: WHISPER_DEVICE,
    diarizationMode: DIARIZATION_MODE,
    ollamaBase: OLLAMA_BASE,
    openaiBase: OPENAI_BASE,
    anthropicBase: ANTHROPIC_BASE,
    geminiBase: GEMINI_BASE,
    llmProvider: LLM_PROVIDER,
    llmModel: LLM_MODEL,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    chunkSeconds: CHUNK_SECONDS,
    pipelineChatgptOnly: PIPELINE_CHATGPT_ONLY,
    pipelineOpenaiModel: PIPELINE_OPENAI_MODEL,
    pipelineOpenaiFallbackModel: PIPELINE_OPENAI_FALLBACK_MODEL,
    anthropicRetryMax: ANTHROPIC_RETRY_MAX,
    anthropicRetryBaseMs: ANTHROPIC_RETRY_BASE_MS,
    anthropicMinGapMs: ANTHROPIC_MIN_GAP_MS,
  }
}

export function getRuntimeApiKeys() {
  return {
    openaiApiKey: OPENAI_API_KEY || null,
    anthropicApiKey: ANTHROPIC_API_KEY || null,
    geminiApiKey: GEMINI_API_KEY || null,
    groqApiKey: GROQ_API_KEY || null,
  }
}

// ── File upload instance ──────────────────────────────────────────────────────

export const upload = multer({
  dest: path.join(os.tmpdir(), 'dnd-upload'),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
})
