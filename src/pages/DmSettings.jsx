import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../AuthContext.jsx'
import { apiFetch } from '../lib/api.js'

const USER_KEY_CONFIGS = [
  { key: 'anthropic', label: 'Anthropic API Key',        placeholder: 'sk-ant-...', secretKey: 'anthropic_api_key' },
  { key: 'openai',    label: 'OpenAI API Key',            placeholder: 'sk-...',     secretKey: 'openai_api_key'    },
  { key: 'gemini',    label: 'Google Gemini API Key',     placeholder: 'AIza...',    secretKey: 'gemini_api_key'    },
  { key: 'groq',      label: 'Groq API Key',              placeholder: 'gsk_...',    secretKey: 'groq_api_key'      },
]

export default function DmSettings() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()

  // Server defaults (read-only display)
  const [serverDefault, setServerDefault] = useState({ provider: 'ollama', model: '' })

  // User's LLM preference
  const [userProvider, setUserProvider] = useState('')
  const [userModel, setUserModel] = useState('')
  const [llmStatus, setLlmStatus] = useState('')
  const [modelsByProvider, setModelsByProvider] = useState({})

  // User's personal API keys
  const [keyExists, setKeyExists] = useState({})
  const [keyInputs, setKeyInputs] = useState({})
  const [keyStatus, setKeyStatus] = useState({})

  useEffect(() => {
    if (!user) return
    loadAll()
  }, [user])

  async function loadAll() {
    try {
      const [cfgRes, modelsRes, settingsRes] = await Promise.all([
        apiFetch('/api/llm/config'),
        apiFetch('/api/llm/models'),
        apiFetch('/api/user/settings'),
      ])
      const cfg = await cfgRes.json()
      const models = await modelsRes.json()
      const settings = await settingsRes.json()

      if (cfg.ok) setServerDefault({ provider: cfg.provider, model: cfg.model })
      if (models.ok) setModelsByProvider(models.byProvider || {})
      if (settings.ok) {
        const pref = settings.settings?.llm_preference
        if (pref?.provider) { setUserProvider(pref.provider); setUserModel(pref.model || '') }
      }
    } catch { /* ignore */ }

    // Check which user keys exist
    const exists = {}
    await Promise.all(USER_KEY_CONFIGS.map(async (cfg) => {
      try {
        const r = await apiFetch(`/api/user/secrets/${cfg.secretKey}/exists`)
        const j = await r.json()
        exists[cfg.key] = j.ok && j.exists
      } catch { exists[cfg.key] = false }
    }))
    setKeyExists(exists)
  }

  async function saveLlmPreference() {
    if (!userProvider) {
      // Clear preference — fall back to server default
      setLlmStatus('Clearing...')
      try {
        await apiFetch('/api/user/settings/llm_preference', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: null }),
        })
        setUserProvider('')
        setUserModel('')
        setLlmStatus('Cleared — using server default')
      } catch (err) { setLlmStatus(`Failed: ${err.message}`) }
      return
    }
    setLlmStatus('Saving...')
    try {
      const r = await apiFetch('/api/user/settings/llm_preference', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: { provider: userProvider, model: userModel } }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setLlmStatus(`Saved — your campaigns will use ${userProvider} / ${userModel}`)
    } catch (err) { setLlmStatus(`Failed: ${err.message}`) }
  }

  async function saveKey(cfg) {
    const val = (keyInputs[cfg.key] || '').trim()
    if (!val) { setKeyStatus((s) => ({ ...s, [cfg.key]: 'Enter a key first' })); return }
    setKeyStatus((s) => ({ ...s, [cfg.key]: 'Saving...' }))
    try {
      const r = await apiFetch(`/api/user/secrets/${cfg.secretKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: val }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setKeyInputs((s) => ({ ...s, [cfg.key]: '' }))
      setKeyExists((s) => ({ ...s, [cfg.key]: true }))
      setKeyStatus((s) => ({ ...s, [cfg.key]: 'Saved' }))
    } catch (err) { setKeyStatus((s) => ({ ...s, [cfg.key]: `Failed: ${err.message}` })) }
  }

  if (isLoading) return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
      Loading...
    </div>
  )

  const effectiveProvider = userProvider || serverDefault.provider
  const effectiveModel = userModel || serverDefault.model
  const hasOverride = !!userProvider

  return (
    <div
      className="relative min-h-screen text-slate-100"
      style={{
        backgroundImage: 'url(/campaign-manager-bg.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
      }}
    >
      <div className="absolute inset-0 bg-slate-950/88 pointer-events-none" aria-hidden="true" />

      <div className="relative z-10 mx-auto max-w-2xl px-5 py-8 space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-widest text-amber-400/80">DM Profile</div>
            <h1 className="mt-1 text-2xl font-bold text-slate-50">Your Settings</h1>
            <p className="mt-1 text-sm text-slate-400">
              Personal overrides — take priority over server defaults for your sessions.
            </p>
          </div>
          <button
            onClick={() => navigate('/dm')}
            className="shrink-0 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500 hover:text-slate-100"
          >
            ← Back
          </button>
        </div>

        {/* LLM preference */}
        <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-5 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">AI Provider Preference</h2>
            <p className="mt-1 text-sm text-slate-400">
              Override the server default for your campaigns. Leave blank to use the server setting.
            </p>
          </div>

          {/* Server default (read-only) */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-xs text-slate-500 flex items-center gap-2">
            <span className="shrink-0 text-slate-600">Server default:</span>
            <span className="text-slate-400 font-mono">{serverDefault.provider} / {serverDefault.model || '—'}</span>
          </div>

          {/* User override */}
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <select
                value={userProvider}
                onChange={(e) => {
                  const p = e.target.value
                  setUserProvider(p)
                  const opts = modelsByProvider[p] || []
                  if (opts.length) setUserModel(opts[0])
                }}
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              >
                <option value="">Use server default</option>
                <option value="ollama">ollama</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="gemini">gemini</option>
              </select>
              <select
                value={userModel}
                onChange={(e) => setUserModel(e.target.value)}
                disabled={!userProvider}
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm disabled:opacity-40"
              >
                {userProvider
                  ? (modelsByProvider[userProvider] || []).map((m) => <option key={m} value={m}>{m}</option>)
                  : <option value="">—</option>
                }
                {userProvider && !(modelsByProvider[userProvider] || []).includes(userModel) && userModel && (
                  <option value={userModel}>{userModel}</option>
                )}
              </select>
              <button
                onClick={saveLlmPreference}
                className="rounded-lg border border-amber-700 text-amber-300 px-4 py-2 text-sm hover:bg-amber-700/20"
              >
                Save
              </button>
            </div>

            {hasOverride && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-950/30 px-2 py-0.5 text-amber-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                  Your override active
                </span>
                <span className="text-slate-500">
                  Using {effectiveProvider} / {effectiveModel}
                </span>
              </div>
            )}
          </div>

          {llmStatus && <div className="text-xs text-amber-300">{llmStatus}</div>}
        </div>

        {/* Personal API keys */}
        <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-5 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Your API Keys</h2>
            <p className="mt-1 text-sm text-slate-400">
              Keys saved here are encrypted and take priority over server-level keys for your sessions.
            </p>
          </div>

          <div className="space-y-3">
            {USER_KEY_CONFIGS.map((cfg) => (
              <div key={cfg.key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase text-slate-500">{cfg.label}</label>
                  {keyExists[cfg.key]
                    ? <span className="inline-flex items-center gap-1 rounded-full border border-emerald-700 bg-emerald-900/40 px-2 py-0.5 text-[11px] text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Key saved</span>
                    : <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-slate-600" />Using server key</span>
                  }
                </div>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={keyInputs[cfg.key] || ''}
                    onChange={(e) => setKeyInputs((s) => ({ ...s, [cfg.key]: e.target.value }))}
                    placeholder={keyExists[cfg.key] ? `${cfg.placeholder} (replace existing)` : cfg.placeholder}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm placeholder:text-slate-600"
                  />
                  <button
                    onClick={() => saveKey(cfg)}
                    className="rounded-lg border border-emerald-700 text-emerald-300 px-4 py-2 text-sm hover:bg-emerald-700/20"
                  >
                    Save
                  </button>
                </div>
                {keyStatus[cfg.key] && (
                  <div className="text-xs text-amber-300">{keyStatus[cfg.key]}</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Info callout */}
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-xs text-slate-500 space-y-1">
          <div className="text-slate-400 font-medium">How overrides work</div>
          <div>Your personal settings are checked first. If not set, the server default is used.</div>
          <div>Keys are encrypted with AES-256-GCM before storage — the server never logs them in plaintext.</div>
        </div>

      </div>
    </div>
  )
}
