/**
 * Settings service — reads/writes LLM config, ASR config, and API keys.
 *
 * Cascade for config (non-secret):
 *   Postgres server_settings → env var
 *
 * Cascade for secrets (API keys):
 *   Postgres server_secrets → env var (for initial bootstrap only)
 *
 * When values are saved here, the config.js mutable vars are also updated
 * so the pipeline picks them up without a restart.
 */
import * as settingsRepo from '../db/postgres/repositories/settings.repo.js'
import * as secretsRepo from '../db/postgres/repositories/secrets.repo.js'
import {
  setLlmProvider, setLlmModel, setAsrProvider,
  setWhisperLocalBase, setWhisperLocalPath, setWhisperLocalModel,
  setWhisperLocalApiKey, setWhisperLocalApiKeyHeader,
  setOpenaiApiKey, setAnthropicApiKey, setGeminiApiKey, setGroqApiKey, setPyannoteHfToken,
} from '../config.js'

// ── LLM config ────────────────────────────────────────────────────────────────

const VALID_LLM_PROVIDERS = ['ollama', 'openai', 'anthropic', 'gemini']

export async function getLlmConfig() {
  const stored = await settingsRepo.getServerSetting('llm_config').catch(() => null)
  return {
    provider: stored?.provider ?? process.env.LLM_PROVIDER ?? 'ollama',
    model:    stored?.model    ?? process.env.LLM_MODEL    ?? process.env.OLLAMA_MODEL ?? 'qwen2.5:7b',
  }
}

export async function setLlmConfig({ provider, model }, updatedByUserId = null) {
  if (!VALID_LLM_PROVIDERS.includes(provider)) throw Object.assign(new Error('provider must be ollama|openai|anthropic|gemini'), { statusCode: 400 })
  if (!model) throw Object.assign(new Error('model required'), { statusCode: 400 })
  await settingsRepo.setServerSetting('llm_config', { provider, model }, updatedByUserId)
  setLlmProvider(provider)
  setLlmModel(model)
  return { provider, model }
}

// ── ASR config ────────────────────────────────────────────────────────────────

const VALID_ASR_PROVIDERS = ['remote', 'local', 'groq', 'openai', 'whisper-local']

export async function getAsrConfig() {
  const stored = await settingsRepo.getServerSetting('asr_config').catch(() => null)
  return {
    asrProvider:             stored?.asrProvider             ?? process.env.ASR_PROVIDER ?? 'remote',
    whisperLocalBase:        stored?.whisperLocalBase        ?? process.env.WHISPER_LOCAL_BASE ?? 'http://localhost:8765',
    whisperLocalPath:        stored?.whisperLocalPath        ?? process.env.WHISPER_LOCAL_PATH ?? '/transcribe',
    whisperLocalModel:       stored?.whisperLocalModel       ?? process.env.WHISPER_LOCAL_MODEL ?? 'large-v3',
    whisperLocalApiKeyHeader:stored?.whisperLocalApiKeyHeader?? process.env.WHISPER_LOCAL_API_KEY_HEADER ?? 'X-API-Key',
    hasWhisperLocalApiKey:   await secretsRepo.hasServerSecret('whisper_local_api_key').catch(() => false),
  }
}

export async function setAsrConfig(body, updatedByUserId = null) {
  const provider = String(body?.asrProvider || '').trim().toLowerCase()
  if (!VALID_ASR_PROVIDERS.includes(provider)) throw Object.assign(new Error('asrProvider must be remote|local|groq|openai|whisper-local'), { statusCode: 400 })

  const current = await settingsRepo.getServerSetting('asr_config').catch(() => null) ?? {}
  const next = {
    asrProvider:             provider,
    whisperLocalBase:        String(body?.whisperLocalBase        ?? current.whisperLocalBase        ?? '').trim() || 'http://localhost:8765',
    whisperLocalPath:        String(body?.whisperLocalPath        ?? current.whisperLocalPath        ?? '').trim() || '/transcribe',
    whisperLocalModel:       String(body?.whisperLocalModel       ?? current.whisperLocalModel       ?? '').trim() || 'large-v3',
    whisperLocalApiKeyHeader:String(body?.whisperLocalApiKeyHeader?? current.whisperLocalApiKeyHeader?? '').trim() || 'X-API-Key',
  }
  if (body?.whisperLocalApiKey) {
    await secretsRepo.setServerSecret('whisper_local_api_key', String(body.whisperLocalApiKey).trim(), updatedByUserId)
  }
  await settingsRepo.setServerSetting('asr_config', next, updatedByUserId)
  setAsrProvider(next.asrProvider)
  setWhisperLocalBase(next.whisperLocalBase)
  setWhisperLocalPath(next.whisperLocalPath)
  setWhisperLocalModel(next.whisperLocalModel)
  setWhisperLocalApiKeyHeader(next.whisperLocalApiKeyHeader)
  if (body?.whisperLocalApiKey) setWhisperLocalApiKey(String(body.whisperLocalApiKey).trim())
  return { ...next, hasWhisperLocalApiKey: await secretsRepo.hasServerSecret('whisper_local_api_key').catch(() => false) }
}

// ── API keys ──────────────────────────────────────────────────────────────────

const KEY_DEFS = {
  openai:    { secretKey: 'openai_api_key',       envVar: 'OPENAI_API_KEY',     prefix: 'sk-' },
  anthropic: { secretKey: 'anthropic_api_key',    envVar: 'ANTHROPIC_API_KEY',  prefix: 'sk-ant-' },
  gemini:    { secretKey: 'gemini_api_key',        envVar: 'GEMINI_API_KEY',     prefix: 'AIza' },
  groq:      { secretKey: 'groq_api_key',          envVar: 'GROQ_API_KEY',       prefix: 'gsk_' },
  pyannote:  { secretKey: 'pyannote_hf_token',     envVar: 'PYANNOTE_HF_TOKEN',  prefix: 'hf_' },
}

export async function getApiKey(name) {
  const def = KEY_DEFS[name]
  if (!def) throw Object.assign(new Error(`Unknown key: ${name}`), { statusCode: 400 })
  const stored = await secretsRepo.getServerSecret(def.secretKey).catch(() => null)
  return stored ?? process.env[def.envVar] ?? null
}

export async function hasApiKey(name) {
  const def = KEY_DEFS[name]
  if (!def) return false
  if (await secretsRepo.hasServerSecret(def.secretKey).catch(() => false)) return true
  return !!(process.env[def.envVar])
}

export async function setApiKey(name, value, updatedByUserId = null) {
  const def = KEY_DEFS[name]
  if (!def) throw Object.assign(new Error(`Unknown key: ${name}`), { statusCode: 400 })
  const trimmed = String(value || '').trim()
  if (!trimmed) throw Object.assign(new Error('key value required'), { statusCode: 400 })
  if (!trimmed.startsWith(def.prefix)) throw Object.assign(new Error(`${name} key must start with "${def.prefix}"`), { statusCode: 400 })
  await secretsRepo.setServerSecret(def.secretKey, trimmed, updatedByUserId)
  if (name === 'openai')    setOpenaiApiKey(trimmed)
  if (name === 'anthropic') setAnthropicApiKey(trimmed)
  if (name === 'gemini')    setGeminiApiKey(trimmed)
  if (name === 'groq')      setGroqApiKey(trimmed)
  if (name === 'pyannote')  setPyannoteHfToken(trimmed)
  return true
}

// ── Startup: load all settings from Postgres into the legacy runtime ──────────

export async function loadRuntimeSettingsFromPg() {
  try {
    const [llm, asr] = await Promise.all([getLlmConfig(), getAsrConfig()])
    const keys = await Promise.all(
      Object.entries(KEY_DEFS).map(async ([name, def]) => {
        const val = await secretsRepo.getServerSecret(def.secretKey).catch(() => null)
        return [name, val]
      })
    )
    setLlmProvider(llm.provider)
    setLlmModel(llm.model)
    setAsrProvider(asr.asrProvider)
    setWhisperLocalBase(asr.whisperLocalBase)
    setWhisperLocalPath(asr.whisperLocalPath)
    setWhisperLocalModel(asr.whisperLocalModel)
    setWhisperLocalApiKeyHeader(asr.whisperLocalApiKeyHeader)
    for (const [name, val] of keys) {
      if (!val) continue
      if (name === 'openai')    setOpenaiApiKey(val)
      if (name === 'anthropic') setAnthropicApiKey(val)
      if (name === 'gemini')    setGeminiApiKey(val)
      if (name === 'groq')      setGroqApiKey(val)
      if (name === 'pyannote')  setPyannoteHfToken(val)
    }
  } catch (err) {
    console.error('[settings] loadRuntimeSettingsFromPg error:', err.message)
  }
}
