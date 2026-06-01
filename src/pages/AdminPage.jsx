import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api.js'

const TABS = ['Users', 'Invites', 'Campaigns', 'Settings']

export default function AdminPage() {
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (localStorage.getItem('dnd_token_role') !== 'admin') {
      navigate('/login', { replace: true })
    } else {
      setReady(true)
    }
  }, [navigate])

  function signOut() {
    localStorage.removeItem('dnd_token')
    localStorage.removeItem('dnd_token_role')
    localStorage.removeItem('dnd_token_user')
    navigate('/login', { replace: true })
  }

  const [tab, setTab] = useState('Users')

  if (!ready) return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
      Loading...
    </div>
  )

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase text-amber-400/80">Campaign Manager</div>
          <h1 className="text-xl font-semibold">Admin Console</h1>
          <p className="text-xs text-slate-500 mt-0.5">Server owner. Keeps the house standing.</p>
        </div>
        <div className="flex items-center gap-5">
          <Link to="/" className="text-sm text-slate-400 hover:text-amber-300">← Campaigns</Link>
          <button onClick={signOut} className="text-sm text-slate-400 hover:text-rose-300">Sign Out</button>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-6">
        <div className="flex gap-0 border-b border-slate-800 mb-6">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                tab === t
                  ? 'border-amber-500 text-amber-300'
                  : 'border-transparent text-slate-400 hover:text-slate-100'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'Users' && <UsersTab />}
        {tab === 'Invites' && <InvitesTab />}
        {tab === 'Campaigns' && <CampaignsTab />}
        {tab === 'Settings' && <SettingsTab />}
      </div>
    </div>
  )
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function ErrorBanner({ msg }) {
  if (!msg) return null
  return <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300 mb-4">{msg}</div>
}

function StatusBanner({ msg }) {
  if (!msg) return null
  return <div className="rounded-md border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-300 mb-4">{msg}</div>
}

function RoleBadge({ role }) {
  const styles = {
    admin: 'bg-amber-900/60 text-amber-300',
    dm: 'bg-blue-900/60 text-blue-300',
    player: 'bg-slate-800 text-slate-400',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${styles[role] || styles.player}`}>
      {role}
    </span>
  )
}

function KeyBadge({ saved }) {
  return saved
    ? <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/60 border border-emerald-700 px-2.5 py-0.5 text-xs font-medium text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Key saved</span>
    : <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-2.5 py-0.5 text-xs text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-slate-600" />No key stored</span>
}

function Section({ title, desc, children }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="font-semibold text-slate-200 mb-1">{title}</div>
      {desc && <div className="text-xs text-slate-500 mb-3">{desc}</div>}
      {children}
    </div>
  )
}

// ── Users tab ─────────────────────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState([])
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [resetFor, setResetFor] = useState(null)
  const [newPassword, setNewPassword] = useState('')

  useEffect(() => { loadUsers() }, [])

  async function loadUsers() {
    try {
      const r = await apiFetch('/api/admin/users')
      const j = await r.json()
      if (j.ok) setUsers(j.users)
      else setError(j.error || 'Failed to load users')
    } catch { setError('Failed to load users') }
  }

  async function changeRole(userId, role) {
    setError('')
    try {
      const r = await apiFetch(`/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setStatus('Role updated')
      loadUsers()
    } catch (err) { setError(err.message) }
  }

  async function revokeSessions(userId) {
    setError('')
    try {
      const r = await apiFetch(`/api/admin/users/${userId}/sessions`, { method: 'DELETE' })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setStatus(`Sessions revoked (${j.revoked ?? 0} removed)`)
    } catch (err) { setError(err.message) }
  }

  async function deleteUser(userId, displayName) {
    if (!confirm(`Delete "${displayName}"? This cannot be undone.`)) return
    setError('')
    try {
      const r = await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setStatus('User deleted')
      loadUsers()
    } catch (err) { setError(err.message) }
  }

  async function doResetPassword(userId) {
    if (!newPassword || newPassword.length < 8) { setError('Password must be at least 8 characters'); return }
    setError('')
    try {
      const r = await apiFetch(`/api/admin/users/${userId}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setStatus('Password reset and sessions revoked')
      setResetFor(null)
      setNewPassword('')
    } catch (err) { setError(err.message) }
  }

  return (
    <div>
      <ErrorBanner msg={error} />
      <StatusBanner msg={status} />
      <div className="space-y-3">
        {users.map((user) => (
          <div key={user.id} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-semibold text-slate-100">{user.displayName}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  @{user.username} · joined {new Date(user.createdAt).toLocaleDateString()}
                </div>
              </div>
              <RoleBadge role={user.role} />
            </div>

            {user.role !== 'admin' && (
              <div className="mt-3 flex flex-wrap gap-2">
                <select
                  value={user.role}
                  onChange={(e) => changeRole(user.id, e.target.value)}
                  className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-300"
                >
                  <option value="dm">DM</option>
                  <option value="player">Player</option>
                </select>
                <button
                  onClick={() => { setResetFor(resetFor === user.id ? null : user.id); setNewPassword('') }}
                  className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-amber-700 hover:text-amber-300"
                >
                  Reset Password
                </button>
                <button
                  onClick={() => revokeSessions(user.id)}
                  className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-amber-700 hover:text-amber-300"
                >
                  Revoke Sessions
                </button>
                <button
                  onClick={() => deleteUser(user.id, user.displayName)}
                  className="rounded-md border border-slate-700 px-3 py-1 text-xs text-rose-400 hover:border-rose-700"
                >
                  Delete
                </button>
              </div>
            )}

            {resetFor === user.id && (
              <div className="mt-3 flex gap-2">
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password (8+ chars)"
                  className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-amber-600"
                />
                <button
                  onClick={() => doResetPassword(user.id)}
                  className="rounded-md border border-amber-700 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/20"
                >
                  Save
                </button>
                <button
                  onClick={() => { setResetFor(null); setNewPassword('') }}
                  className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-400"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}

        {users.length === 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-500">
            No users found.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Invites tab ───────────────────────────────────────────────────────────────

function InvitesTab() {
  const [invites, setInvites] = useState([])
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [newRole, setNewRole] = useState('dm')
  const [showAll, setShowAll] = useState(false)
  const [copiedToken, setCopiedToken] = useState('')

  useEffect(() => { loadInvites() }, [])

  async function loadInvites() {
    try {
      const r = await apiFetch('/api/admin/invites')
      const j = await r.json()
      if (j.ok) setInvites(j.invites)
      else setError(j.error || 'Failed to load invites')
    } catch { setError('Failed to load invites') }
  }

  async function createInvite() {
    setError('')
    try {
      const r = await apiFetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setStatus(`${j.invite.role.toUpperCase()} invite created`)
      loadInvites()
    } catch (err) { setError(err.message) }
  }

  async function revokeInvite(token) {
    setError('')
    try {
      const r = await apiFetch(`/api/admin/invites/${token}`, { method: 'DELETE' })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setStatus('Invite revoked')
      loadInvites()
    } catch (err) { setError(err.message) }
  }

  function copyLink(token) {
    const url = `${window.location.origin}/login?accountInvite=${token}`
    navigator.clipboard.writeText(url)
    setCopiedToken(token)
    setTimeout(() => setCopiedToken(''), 2000)
  }

  const now = Date.now()
  const visible = showAll
    ? invites
    : invites.filter((i) => !i.consumedAt && Number(i.expiresAt) > now)

  return (
    <div>
      <ErrorBanner msg={error} />
      <StatusBanner msg={status} />

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 mb-4">
        <div className="text-sm font-semibold text-slate-300 mb-3">Create Account Invite</div>
        <div className="flex gap-2">
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-300"
          >
            <option value="dm">DM</option>
            <option value="player">Player</option>
          </select>
          <button
            onClick={createInvite}
            className="rounded-md border border-amber-700 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-300 hover:bg-amber-500/20"
          >
            Create Invite
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">One-time link, valid for 7 days. Share it with the new user to let them create their account.</p>
      </div>

      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-slate-500">
          {visible.length} {showAll ? 'total' : 'active'} invite{visible.length !== 1 ? 's' : ''}
        </div>
        <button onClick={() => setShowAll(!showAll)} className="text-xs text-slate-500 hover:text-slate-300">
          {showAll ? 'Active only' : 'Show all'}
        </button>
      </div>

      <div className="space-y-2">
        {visible.map((invite) => {
          const expired = Number(invite.expiresAt) < now
          const consumed = !!invite.consumedAt
          const inactive = expired || consumed
          return (
            <div
              key={invite.token}
              className={`rounded-lg border p-3 ${inactive ? 'border-slate-800/50 bg-slate-900/30 opacity-50' : 'border-slate-800 bg-slate-900'}`}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <RoleBadge role={invite.role} />
                    {consumed
                      ? <span className="text-xs text-emerald-400">used</span>
                      : expired
                        ? <span className="text-xs text-rose-400">expired</span>
                        : <span className="text-xs text-slate-500">expires {new Date(invite.expiresAt).toLocaleDateString()}</span>
                    }
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-slate-600 truncate">{invite.token}</div>
                </div>
                {!inactive && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => copyLink(invite.token)}
                      className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-amber-700 hover:text-amber-300"
                    >
                      {copiedToken === invite.token ? 'Copied!' : 'Copy Link'}
                    </button>
                    <button
                      onClick={() => revokeInvite(invite.token)}
                      className="rounded-md border border-slate-700 px-3 py-1 text-xs text-rose-400 hover:border-rose-700"
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {visible.length === 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-500">
            No {showAll ? '' : 'active '}invites.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Campaigns tab ─────────────────────────────────────────────────────────────

function CampaignsTab() {
  const [campaigns, setCampaigns] = useState([])
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [backingUp, setBackingUp] = useState(null)

  useEffect(() => { loadCampaigns() }, [])

  async function loadCampaigns() {
    try {
      const r = await apiFetch('/api/campaigns')
      const j = await r.json()
      if (j.ok) setCampaigns(j.campaigns)
      else setError(j.error || 'Failed to load campaigns')
    } catch { setError('Failed to load campaigns') }
  }

  async function backup(id) {
    setBackingUp(id)
    setError('')
    try {
      const r = await apiFetch(`/api/campaigns/${id}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setStatus(`Backup created for ${id}`)
    } catch (err) { setError(err.message) }
    setBackingUp(null)
  }

  async function deleteCampaign(id, name) {
    if (!confirm(`Permanently delete campaign "${name}"?\n\nThis removes all sessions, lexicon, journal entries, and SQLite data. It cannot be undone.`)) return
    setError('')
    try {
      const r = await apiFetch(`/api/campaigns/${id}`, { method: 'DELETE' })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setStatus(`Campaign "${name}" deleted`)
      loadCampaigns()
    } catch (err) { setError(err.message) }
  }

  return (
    <div>
      <ErrorBanner msg={error} />
      <StatusBanner msg={status} />
      <div className="space-y-3">
        {campaigns.map((c) => (
          <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-semibold text-slate-100">{c.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {c.id} · DM: {c.ownerDisplayName || 'unknown'}
                  {c.createdAt ? ` · created ${new Date(c.createdAt).toLocaleDateString()}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => backup(c.id)}
                  disabled={backingUp === c.id}
                  className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-emerald-700 hover:text-emerald-300 disabled:opacity-50"
                >
                  {backingUp === c.id ? 'Backing up…' : 'Backup'}
                </button>
                <button
                  onClick={() => deleteCampaign(c.id, c.name)}
                  className="rounded-md border border-slate-700 px-3 py-1 text-xs text-rose-400 hover:border-rose-700"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {campaigns.length === 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-500">
            No campaigns found.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Settings tab ──────────────────────────────────────────────────────────────

const KEY_CONFIGS = [
  { key: 'openai',    label: 'OpenAI API Key',              placeholder: 'sk-...',     endpoint: '/api/pipeline/key',  bodyKey: 'openaiApiKey',    statusKey: 'hasKey'   },
  { key: 'anthropic', label: 'Anthropic API Key',           placeholder: 'sk-ant-...', endpoint: '/api/anthropic/key', bodyKey: 'anthropicApiKey', statusKey: 'hasKey'   },
  { key: 'gemini',    label: 'Google Gemini API Key',       placeholder: 'AIza...',    endpoint: '/api/gemini/key',    bodyKey: 'geminiApiKey',    statusKey: 'hasKey'   },
  { key: 'groq',      label: 'Groq API Key',                placeholder: 'gsk_...',    endpoint: '/api/groq/key',      bodyKey: 'groqApiKey',      statusKey: 'hasKey'   },
  { key: 'pyannote',  label: 'Pyannote / HuggingFace Token', placeholder: 'hf_...',    endpoint: '/api/pyannote/key',  bodyKey: 'pyannoteToken',   statusKey: 'hasToken' },
]

function SettingsTab() {
  const [llmProvider, setLlmProvider] = useState('ollama')
  const [llmModel, setLlmModel] = useState('')
  const [llmModels, setLlmModels] = useState({})
  const [llmStatus, setLlmStatus] = useState('')

  const [asrProvider, setAsrProvider] = useState('remote')
  const [asrInfo, setAsrInfo] = useState(null)
  const [asrStatus, setAsrStatus] = useState('')

  const [keys, setKeys] = useState({ openai: false, anthropic: false, gemini: false, groq: false, pyannote: false })
  const [keyInputs, setKeyInputs] = useState({ openai: '', anthropic: '', gemini: '', groq: '', pyannote: '' })
  const [keyStatus, setKeyStatus] = useState({})

  useEffect(() => {
    async function loadAll() {
      try {
        const [cfgRes, modelsRes, asrRes] = await Promise.all([
          apiFetch('/api/llm/config'),
          apiFetch('/api/llm/models'),
          apiFetch('/api/asr/config'),
        ])
        const cfg = await cfgRes.json()
        const models = await modelsRes.json()
        const asr = await asrRes.json()
        if (cfg.ok) { setLlmProvider(cfg.provider); setLlmModel(cfg.model) }
        if (models.ok && models.byProvider) setLlmModels(models.byProvider)
        if (asr.ok) { setAsrProvider(asr.asrProvider); setAsrInfo(asr) }
      } catch { /* ignore */ }

      try {
        const responses = await Promise.all(KEY_CONFIGS.map((c) => apiFetch(c.endpoint).then((r) => r.json())))
        const next = {}
        KEY_CONFIGS.forEach((c, i) => { next[c.key] = !!responses[i][c.statusKey] })
        setKeys(next)
      } catch { /* ignore */ }
    }
    loadAll()
  }, [])

  async function saveLlm() {
    setLlmStatus('Saving...')
    try {
      const r = await apiFetch('/api/llm/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: llmProvider, model: llmModel }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setLlmStatus(`Saved: ${j.provider} / ${j.model}`)
    } catch (err) { setLlmStatus(`Failed: ${err.message}`) }
  }

  async function saveAsr(provider) {
    setAsrStatus('Saving...')
    try {
      const r = await apiFetch('/api/asr/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asrProvider: provider }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setAsrProvider(j.asrProvider)
      setAsrStatus(`Saved: ${j.asrProvider}`)
    } catch (err) { setAsrStatus(`Failed: ${err.message}`) }
  }

  async function saveKey(cfg) {
    const val = keyInputs[cfg.key].trim()
    if (!val) { setKeyStatus((s) => ({ ...s, [cfg.key]: 'Enter a key first' })); return }
    setKeyStatus((s) => ({ ...s, [cfg.key]: 'Saving...' }))
    try {
      const r = await apiFetch(cfg.endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [cfg.bodyKey]: val }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setKeyInputs((s) => ({ ...s, [cfg.key]: '' }))
      setKeys((s) => ({ ...s, [cfg.key]: true }))
      setKeyStatus((s) => ({ ...s, [cfg.key]: 'Saved' }))
    } catch (err) { setKeyStatus((s) => ({ ...s, [cfg.key]: `Failed: ${err.message}` })) }
  }

  return (
    <div className="space-y-4">
      <Section title="AI Provider" desc="LLM used for transcript processing and campaign features.">
        <div className="flex flex-wrap gap-2">
          <select
            value={llmProvider}
            onChange={(e) => {
              const p = e.target.value
              setLlmProvider(p)
              const opts = llmModels[p] || []
              if (opts.length) setLlmModel(opts[0])
            }}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            {['ollama', 'openai', 'anthropic', 'gemini'].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            value={llmModel}
            onChange={(e) => setLlmModel(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            {(llmModels[llmProvider] || []).map((m) => <option key={m} value={m}>{m}</option>)}
            {!(llmModels[llmProvider] || []).length && <option value={llmModel}>{llmModel}</option>}
          </select>
          <button onClick={saveLlm} className="rounded-md border border-amber-700 text-amber-300 px-4 py-2 text-sm">
            Save
          </button>
        </div>
        {llmStatus && <div className="mt-2 text-xs text-amber-300">{llmStatus}</div>}
      </Section>

      <Section title="ASR Provider" desc="How session audio is transcribed to text.">
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={asrProvider}
            onChange={(e) => saveAsr(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            <option value="remote">Remote — SSH + Whisper GPU</option>
            <option value="local">Local — Whisper CPU/GPU</option>
            <option value="groq">Groq Cloud</option>
            <option value="openai">OpenAI Cloud</option>
          </select>
          {asrInfo && asrProvider === 'remote' && asrInfo.remoteHost && (
            <span className="text-xs text-slate-500">Host: {asrInfo.remoteHost}</span>
          )}
        </div>
        {asrStatus && <div className="mt-2 text-xs text-amber-300">{asrStatus}</div>}
      </Section>

      {KEY_CONFIGS.map((cfg) => (
        <Section key={cfg.key} title={cfg.label} desc="">
          <div className="mb-2"><KeyBadge saved={keys[cfg.key]} /></div>
          <div className="flex gap-2">
            <input
              type="password"
              value={keyInputs[cfg.key]}
              onChange={(e) => setKeyInputs((s) => ({ ...s, [cfg.key]: e.target.value }))}
              placeholder={cfg.placeholder}
              className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-600"
            />
            <button
              onClick={() => saveKey(cfg)}
              className="rounded-md border border-emerald-700 text-emerald-300 px-4 py-2 text-sm"
            >
              Save
            </button>
          </div>
          {keyStatus[cfg.key] && <div className="mt-2 text-xs text-amber-300">{keyStatus[cfg.key]}</div>}
        </Section>
      ))}
    </div>
  )
}
