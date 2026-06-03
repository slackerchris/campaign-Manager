import * as settingsSvc from '../services/settings.js'
import * as secretsRepo from '../db/postgres/repositories/secrets.repo.js'
import * as settingsRepo from '../db/postgres/repositories/settings.repo.js'
import { getRuntimeConfig, getRuntimeApiKeys } from '../services/pipeline.js'

export function setupSettingsRoutes(app) {

  // ── LLM config ──────────────────────────────────────────────────────────────

  app.get('/api/llm/config', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    try {
      const { provider, model } = await settingsSvc.getLlmConfig()
      res.json({
        ok: true,
        provider,
        model,
        providers: ['ollama', 'openai', 'anthropic', 'gemini'],
      })
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  app.put('/api/llm/config', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' })
    try {
      const result = await settingsSvc.setLlmConfig(
        { provider: req.body?.provider, model: req.body?.model },
        req.user.id
      )
      res.json({ ok: true, ...result })
    } catch (err) {
      res.status(Number(err?.statusCode) || 500).json({ ok: false, error: err.message })
    }
  })

  // ── ASR config ───────────────────────────────────────────────────────────────

  app.get('/api/asr/config', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    try {
      const config = await settingsSvc.getAsrConfig()
      res.json({ ok: true, providers: ['remote', 'local', 'groq', 'openai', 'whisper-local'], ...config })
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  app.put('/api/asr/config', async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' })
    try {
      const result = await settingsSvc.setAsrConfig(req.body, req.user.id)
      res.json({ ok: true, ...result })
    } catch (err) {
      res.status(Number(err?.statusCode) || 500).json({ ok: false, error: err.message })
    }
  })

  // ── API keys ─────────────────────────────────────────────────────────────────
  // Legacy endpoints kept for UI compat. Each key has a dedicated GET (has?) + PUT (save).

  function keyRoutes(endpoint, name, statusKey) {
    app.get(endpoint, async (req, res) => {
      if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' })
      try {
        res.json({ ok: true, [statusKey]: await settingsSvc.hasApiKey(name) })
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message })
      }
    })
    app.put(endpoint, async (req, res) => {
      if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' })
      const value = Object.values(req.body || {})[0]  // any single-key body
      try {
        await settingsSvc.setApiKey(name, value, req.user.id)
        res.json({ ok: true, [statusKey]: true, persisted: true })
      } catch (err) {
        res.status(Number(err?.statusCode) || 500).json({ ok: false, error: err.message })
      }
    })
  }

  keyRoutes('/api/pipeline/key',   'openai',    'hasKey')
  keyRoutes('/api/anthropic/key',  'anthropic', 'hasKey')
  keyRoutes('/api/gemini/key',     'gemini',    'hasKey')
  keyRoutes('/api/groq/key',       'groq',      'hasKey')
  keyRoutes('/api/pyannote/key',   'pyannote',  'hasToken')

  // ── User settings (DM profile settings) ─────────────────────────────────────

  app.get('/api/user/settings', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    try {
      const settings = await settingsRepo.getAllUserSettings(req.user.id)
      res.json({ ok: true, settings })
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  app.put('/api/user/settings/:key', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    try {
      await settingsRepo.setUserSetting(req.user.id, req.params.key, req.body?.value ?? req.body)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  app.get('/api/user/secrets/:key/exists', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    try {
      const exists = await secretsRepo.hasUserSecret(req.user.id, req.params.key)
      res.json({ ok: true, exists })
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  app.put('/api/user/secrets/:key', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })
    const value = String(req.body?.value || Object.values(req.body || {})[0] || '').trim()
    if (!value) return res.status(400).json({ ok: false, error: 'value required' })
    try {
      await secretsRepo.setUserSecret(req.user.id, req.params.key, value)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  // ── LLM model list ───────────────────────────────────────────────────────────

  app.get('/api/llm/models', async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required' })

    const cfg = getRuntimeConfig()

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
      const r = await fetch(`${cfg.ollamaBase}/api/tags`, { signal: AbortSignal.timeout(5000) })
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
      const keys = getRuntimeApiKeys()
      if (keys.openaiApiKey) {
        const r = await fetch(`${cfg.openaiBase}/models`, {
          headers: {
            Authorization: `Bearer ${keys.openaiApiKey}`,
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

      // Anthropic dynamic list (requires key)
      if (keys.anthropicApiKey) {
        const r = await fetch(`${cfg.anthropicBase}/models`, {
          headers: {
            'x-api-key': keys.anthropicApiKey,
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
      // keep fallback static lists
    }

    res.json({ ok: true, byProvider })
  })

}
