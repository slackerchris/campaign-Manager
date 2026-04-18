import path from 'node:path'
import os from 'node:os'

export function envNumber(value, fallback, minimum = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, parsed)
}

export const PORT = process.env.API_PORT || 8790
export const SSH_KEY_PATH = process.env.OLLAMA_SSH_KEY || `${os.homedir()}/.ssh/openclaw_homelab`
export const SSH_USER = process.env.OLLAMA_SSH_USER || 'root'
export const SSH_HOST = process.env.OLLAMA_SSH_HOST || '10.0.50.5'
export const REMOTE_AUDIO_DIR = process.env.REMOTE_AUDIO_DIR || '/tmp/dnd-audio-in'
export const REMOTE_OUT_DIR = process.env.REMOTE_OUT_DIR || '/tmp/dnd-audio-out'
export const WHISPER_MODEL = process.env.WHISPER_MODEL || 'tiny'
export const WHISPER_DEVICE = process.env.WHISPER_DEVICE || 'cuda'
export const CHUNK_SECONDS = Number(process.env.WHISPER_CHUNK_SECONDS || 600)

// ASR provider: remote (SSH+whisper) | local (whisper CLI) | groq | openai
export let ASR_PROVIDER = String(process.env.ASR_PROVIDER || 'remote').toLowerCase()

export function setAsrProvider(val) { ASR_PROVIDER = val }

// Groq settings
export const GROQ_BASE = process.env.GROQ_BASE || 'https://api.groq.com/openai/v1'
export const GROQ_WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3'
export let GROQ_API_KEY = process.env.GROQ_API_KEY || ''
export function setGroqApiKey(val) { GROQ_API_KEY = val }

export const ASR_API_CHUNK_BYTES = envNumber(process.env.ASR_API_CHUNK_BYTES, 1024 * 1024 * 24, 1024 * 1024)

// Diarization runtime mode
export const DIARIZATION_MODE = String(process.env.DIARIZATION_MODE || 'auto').toLowerCase()
export const DIARIZATION_ASR_MODEL = String(process.env.DIARIZATION_ASR_MODEL || 'medium')
export const DIARIZATION_ASR_DEVICE = String(process.env.DIARIZATION_ASR_DEVICE || 'cuda')
export const DIARIZATION_COMPUTE_TYPE = String(process.env.DIARIZATION_COMPUTE_TYPE || 'float16')
export const DIARIZATION_PYANNOTE_DEVICE = String(process.env.DIARIZATION_PYANNOTE_DEVICE || 'cuda')
export let PYANNOTE_HF_TOKEN = String(process.env.PYANNOTE_HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '')
export function setPyannoteHfToken(val) { PYANNOTE_HF_TOKEN = val }

export const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://ollama.throne.middl.earth:11434'
export const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com/v1'
export const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE || 'https://api.anthropic.com/v1'
export const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta'

export let OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
export function setOpenaiApiKey(val) { OPENAI_API_KEY = val }

export let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
export function setAnthropicApiKey(val) { ANTHROPIC_API_KEY = val }

export let GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
export function setGeminiApiKey(val) { GEMINI_API_KEY = val }

export const ANTHROPIC_RETRY_MAX = Number(process.env.ANTHROPIC_RETRY_MAX || 4)
export const ANTHROPIC_RETRY_BASE_MS = Number(process.env.ANTHROPIC_RETRY_BASE_MS || 1200)
export const ANTHROPIC_MIN_GAP_MS = Number(process.env.ANTHROPIC_MIN_GAP_MS || 900)
export let anthropicNextAllowedAt = 0
export function setAnthropicNextAllowedAt(val) { anthropicNextAllowedAt = val }

export const PIPELINE_CHATGPT_ONLY = String(process.env.PIPELINE_CHATGPT_ONLY || 'false').toLowerCase() !== 'false'
export const PIPELINE_OPENAI_MODEL = process.env.PIPELINE_OPENAI_MODEL || 'gpt-5.3-chat-latest'
export const PIPELINE_OPENAI_FALLBACK_MODEL = process.env.PIPELINE_OPENAI_FALLBACK_MODEL || 'gpt-5-mini'

export let LLM_PROVIDER = process.env.LLM_PROVIDER || 'ollama'
export function setLlmProvider(val) { LLM_PROVIDER = val }

export let LLM_MODEL = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:7b'
export function setLlmModel(val) { LLM_MODEL = val }

export function snapshotLlmConfig() {
  return { provider: LLM_PROVIDER, model: LLM_MODEL }
}

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data')
export const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns')
export const DIST_DIR = path.resolve('./dist')
export const DIST_INDEX_FILE = path.join(DIST_DIR, 'index.html')

export const MAX_UPLOAD_BYTES = envNumber(process.env.MAX_UPLOAD_BYTES, 1024 * 1024 * 200, 1)
export const JOB_RETENTION_MS = envNumber(process.env.JOB_RETENTION_MS, 1000 * 60 * 30, 0)
export const MAX_RETAINED_JOBS = envNumber(process.env.MAX_RETAINED_JOBS, 100, 1)
export const MAX_CONCURRENT_JOBS = envNumber(process.env.MAX_CONCURRENT_JOBS, 3, 1)

export const SECRETS_DIR = path.join(DATA_DIR, 'secrets')
export const OPENAI_KEY_FILE = path.join(SECRETS_DIR, 'openai-api-key.json')
export const ANTHROPIC_KEY_FILE = path.join(SECRETS_DIR, 'anthropic-api-key.json')
export const GEMINI_KEY_FILE = path.join(SECRETS_DIR, 'gemini-api-key.json')
export const PYANNOTE_TOKEN_FILE = path.join(SECRETS_DIR, 'pyannote-hf-token.json')
export const GROQ_KEY_FILE = path.join(SECRETS_DIR, 'groq-api-key.json')
export const ASR_CONFIG_FILE = path.join(SECRETS_DIR, 'asr-config.json')
export const APP_TOKEN_FILE = path.join(SECRETS_DIR, 'app-token.json')

export const CAMPAIGN_DB_CACHE_MAX = envNumber(process.env.CAMPAIGN_DB_CACHE_MAX, 10, 1)

export const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['https://dnd.throne.middl.earth', 'https://dnd.middl.earth', 'http://localhost:5173', 'http://localhost:4173']

export let APP_TOKEN = (process.env.APP_TOKEN || '').trim()
export function setAppToken(val) { APP_TOKEN = val }
