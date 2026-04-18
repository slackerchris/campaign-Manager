import { promises as fs } from 'node:fs';
import {
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PYANNOTE_HF_TOKEN, GROQ_API_KEY, ASR_PROVIDER, APP_TOKEN,
  OPENAI_KEY_FILE, setOpenaiApiKey, setAnthropicApiKey, setGeminiApiKey, setGroqApiKey, setPyannoteHfToken, setAsrProvider, setAppToken, ANTHROPIC_KEY_FILE, GEMINI_KEY_FILE, PYANNOTE_TOKEN_FILE, GROQ_KEY_FILE,
  ASR_CONFIG_FILE, APP_TOKEN_FILE, SECRETS_DIR
} from '../config.js';
import { readJson, writeJson } from '../utils.js';
export async function loadPersistedOpenAiKey() {
  // Env var wins; persisted file is fallback for prototype convenience.
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
    if (['remote', 'local', 'groq', 'openai'].includes(p)) setAsrProvider(p)
  } catch { /* ignore */ }
}

export async function persistAsrConfig() {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(ASR_CONFIG_FILE, { asrProvider: ASR_PROVIDER, updatedAt: Date.now() })
}

export async function loadPersistedAppToken() {
  if (APP_TOKEN) return APP_TOKEN
  try {
    const saved = await readJson(APP_TOKEN_FILE, { appToken: '' })
    const tok = String(saved?.appToken || '').trim()
    if (tok) { setAppToken(tok); return tok }
  } catch { /* ignore */ }
  return ''
}

export async function persistAppToken(token) {
  if (APP_TOKEN) throw new Error('App token is already set permanently')
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(APP_TOKEN_FILE, { appToken: String(token || '').trim(), updatedAt: Date.now() })
  setAppToken(token)
}
