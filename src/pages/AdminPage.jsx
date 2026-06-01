import { Fragment, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api.js'

const TABS = ['Users', 'Invites', 'Campaigns', 'Diagnostics', 'Settings']

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

      <div className="mx-auto max-w-6xl px-6 py-6">
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
        {tab === 'Diagnostics' && <DiagnosticsTab />}
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

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatDuration(sec) {
  const value = Number(sec || 0)
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = value % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

function HealthBadge({ check }) {
  if (!check) return <span className="text-xs text-slate-500">unknown</span>
  if (check.writable === true || check.reachable === true) return <span className="text-xs text-emerald-300">ok</span>
  if (check.reachable === null) return <span className="text-xs text-slate-400">not probed</span>
  return <span className="text-xs text-rose-300">needs attention</span>
}

function HealthRow({ label, value, status }) {
  const dot = status === 'ok'
    ? 'bg-emerald-400'
    : status === 'error'
      ? 'bg-rose-400'
      : 'bg-slate-500'
  const text = status === 'ok'
    ? 'text-emerald-300'
    : status === 'error'
      ? 'text-rose-300'
      : 'text-slate-300'

  return (
    <div className="flex items-baseline gap-3">
      <span className="w-40 shrink-0 text-slate-500 text-xs">{label}</span>
      <span className={`flex items-center gap-1.5 break-all ${status ? text : 'text-slate-200'}`}>
        {status && <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${dot}`} />}
        {value}
      </span>
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
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')

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

  const roleCounts = users.reduce((acc, user) => {
    const role = user.role || 'player'
    acc[role] = (acc[role] || 0) + 1
    return acc
  }, {})
  const filteredUsers = users.filter((user) => {
    const q = query.trim().toLowerCase()
    const matchesQuery = !q ||
      String(user.displayName || '').toLowerCase().includes(q) ||
      String(user.username || '').toLowerCase().includes(q)
    const matchesRole = roleFilter === 'all' || user.role === roleFilter
    return matchesQuery && matchesRole
  })

  return (
    <div>
      <ErrorBanner msg={error} />
      <StatusBanner msg={status} />
      <div className="rounded-lg border border-slate-800 bg-slate-900">
        <div className="flex flex-col gap-3 border-b border-slate-800 p-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-slate-700 bg-slate-950 px-2.5 py-1 text-slate-300">{users.length} users</span>
            <span className="rounded-full border border-amber-900/60 bg-amber-950/30 px-2.5 py-1 text-amber-300">{roleCounts.admin || 0} admin</span>
            <span className="rounded-full border border-blue-900/60 bg-blue-950/30 px-2.5 py-1 text-blue-300">{roleCounts.dm || 0} DM</span>
            <span className="rounded-full border border-slate-700 bg-slate-950 px-2.5 py-1 text-slate-400">{roleCounts.player || 0} player</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search users..."
              className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-amber-600"
            />
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-300"
            >
              <option value="all">All roles</option>
              <option value="admin">Admins</option>
              <option value="dm">DMs</option>
              <option value="player">Players</option>
            </select>
          </div>
        </div>

        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-800 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2 font-semibold">User</th>
                <th className="px-4 py-2 font-semibold">Role</th>
                <th className="px-4 py-2 font-semibold">Joined</th>
                <th className="px-4 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => (
                <Fragment key={user.id}>
                  <tr key={user.id} className="border-b border-slate-800/70 last:border-b-0">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-100">{user.displayName}</div>
                      <div className="text-xs text-slate-500">@{user.username}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      {user.role === 'admin' ? (
                        <RoleBadge role={user.role} />
                      ) : (
                        <select
                          value={user.role}
                          onChange={(e) => changeRole(user.id, e.target.value)}
                          className="h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-300"
                        >
                          <option value="dm">DM</option>
                          <option value="player">Player</option>
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{new Date(user.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-2.5">
                      {user.role !== 'admin' && (
                        <div className="flex justify-end gap-2">
                          <button onClick={() => { setResetFor(resetFor === user.id ? null : user.id); setNewPassword('') }} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-amber-700 hover:text-amber-300">Reset</button>
                          <button onClick={() => revokeSessions(user.id)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-amber-700 hover:text-amber-300">Revoke</button>
                          <button onClick={() => deleteUser(user.id, user.displayName)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-rose-400 hover:border-rose-700">Delete</button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {resetFor === user.id && (
                    <tr key={`${user.id}-reset`} className="border-b border-slate-800/70 bg-slate-950/40">
                      <td colSpan="4" className="px-4 py-3">
                        <div className="ml-auto flex max-w-xl gap-2">
                          <input
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="New password (8+ chars)"
                            className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-amber-600"
                          />
                          <button onClick={() => doResetPassword(user.id)} className="rounded-md border border-amber-700 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/20">Save</button>
                          <button onClick={() => { setResetFor(null); setNewPassword('') }} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-400">Cancel</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-slate-800 md:hidden">
          {filteredUsers.map((user) => (
            <div key={user.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-100">{user.displayName}</div>
                  <div className="text-xs text-slate-500">@{user.username} · joined {new Date(user.createdAt).toLocaleDateString()}</div>
                </div>
                <RoleBadge role={user.role} />
              </div>
              {user.role !== 'admin' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <select value={user.role} onChange={(e) => changeRole(user.id, e.target.value)} className="h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-300">
                    <option value="dm">DM</option>
                    <option value="player">Player</option>
                  </select>
                  <button onClick={() => { setResetFor(resetFor === user.id ? null : user.id); setNewPassword('') }} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300">Reset</button>
                  <button onClick={() => revokeSessions(user.id)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300">Revoke</button>
                  <button onClick={() => deleteUser(user.id, user.displayName)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-rose-400">Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {filteredUsers.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-500">
            No users match the current filters.
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
  const [checking, setChecking] = useState(null)
  const [writingExport, setWritingExport] = useState(null)
  const [reports, setReports] = useState({})

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

  async function checkStorage(id) {
    setChecking(id)
    setError('')
    try {
      const r = await apiFetch(`/api/campaigns/${id}/sql-parity`)
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setReports((prev) => ({ ...prev, [id]: { type: 'storage', data: j.parity } }))
      setStatus(`Storage check loaded for ${id}`)
    } catch (err) { setError(err.message) }
    setChecking(null)
  }

  async function downloadExport(campaign) {
    setError('')
    try {
      const r = await apiFetch(`/api/campaigns/${campaign.id}/export`)
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)

      const payload = j.export || {}
      const stamp = new Date(payload.exportedAt || Date.now()).toISOString().replace(/[:.]/g, '-')
      const fileName = `${stamp}-${campaign.id}-export.json`
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setReports((prev) => ({ ...prev, [campaign.id]: { type: 'export', data: { fileName, bytes: blob.size, mode: 'download' } } }))
      setStatus(`Export downloaded for ${campaign.name}`)
    } catch (err) { setError(err.message) }
  }

  async function writeExportFile(campaign) {
    setWritingExport(campaign.id)
    setError('')
    try {
      const r = await apiFetch(`/api/campaigns/${campaign.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeArtifactIndex: true }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setReports((prev) => ({ ...prev, [campaign.id]: { type: 'export', data: { ...(j.exportFile || {}), mode: 'server-file' } } }))
      setStatus(`Export file written for ${campaign.name}`)
    } catch (err) { setError(err.message) }
    setWritingExport(null)
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
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                <button
                  onClick={() => checkStorage(c.id)}
                  disabled={checking === c.id}
                  className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-sky-700 hover:text-sky-300 disabled:opacity-50"
                >
                  {checking === c.id ? 'Checking...' : 'Storage Check'}
                </button>
                <button
                  onClick={() => downloadExport(c)}
                  className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-emerald-700 hover:text-emerald-300"
                >
                  Download Export
                </button>
                <button
                  onClick={() => writeExportFile(c)}
                  disabled={writingExport === c.id}
                  className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-cyan-700 hover:text-cyan-300 disabled:opacity-50"
                >
                  {writingExport === c.id ? 'Writing...' : 'Write Export'}
                </button>
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
            {reports[c.id] && (
              <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
                {reports[c.id].type === 'storage' ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div><span className="text-slate-600">Mode</span><br />{reports[c.id].data?.mode || 'unknown'}</div>
                    <div><span className="text-slate-600">Entities</span><br />{reports[c.id].data?.canonical?.entityCount ?? 0}</div>
                    <div><span className="text-slate-600">Journal</span><br />{reports[c.id].data?.journal?.count ?? 0}</div>
                    <div><span className="text-slate-600">Tales</span><br />{reports[c.id].data?.bardTales?.count ?? 0}</div>
                  </div>
                ) : (
                  <div>
                    <div className="text-slate-300">{reports[c.id].data?.mode === 'server-file' ? 'Server export written' : 'Export downloaded'}</div>
                    <div className="mt-1 break-all">{reports[c.id].data?.fileName || reports[c.id].data?.path || 'export complete'}</div>
                    {reports[c.id].data?.bytes != null && <div className="mt-1">{reports[c.id].data.bytes} bytes</div>}
                  </div>
                )}
              </div>
            )}
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

// ── Diagnostics tab ──────────────────────────────────────────────────────────

function DiagnosticsTab() {
  const [diagnostics, setDiagnostics] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadDiagnostics() }, [])

  async function loadDiagnostics() {
    setLoading(true)
    setError('')
    try {
      const r = await apiFetch('/api/admin/diagnostics')
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error || 'Failed to load diagnostics')
      setDiagnostics(j)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const runtime = diagnostics?.runtime || {}
  const config = diagnostics?.config || {}
  const counts = diagnostics?.counts || {}
  const health = diagnostics?.health || {}

  return (
    <div className="space-y-4">
      <ErrorBanner msg={error} />

      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-200">Server Diagnostics</div>
          <div className="text-xs text-slate-500">Live process state, pipeline health, recent jobs, and request logs.</div>
        </div>
        <button
          onClick={loadDiagnostics}
          disabled={loading}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-amber-700 hover:text-amber-300 disabled:opacity-50"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {diagnostics && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-xs text-slate-500">Uptime</div>
              <div className="mt-1 text-lg font-semibold">{formatDuration(runtime.uptimeSec)}</div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-xs text-slate-500">Memory</div>
              <div className="mt-1 text-lg font-semibold">{formatBytes(runtime.memory?.rss)}</div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-xs text-slate-500">Campaigns</div>
              <div className="mt-1 text-lg font-semibold">{counts.campaigns ?? 0}</div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-xs text-slate-500">Active Jobs</div>
              <div className="mt-1 text-lg font-semibold">{counts.activeJobs ?? 0}</div>
            </div>
          </div>

          <Section title="Health Checks" desc="Fast probes only. They confirm reachability, not transcription quality.">
            <div className="grid gap-2 text-sm">
              <div className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
                <div>
                  <div className="text-slate-200">Data directory</div>
                  <div className="text-xs text-slate-500 break-all">{diagnostics.paths?.dataDir}</div>
                </div>
                <HealthBadge check={health.dataDir} />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
                <div>
                  <div className="text-slate-200">Ollama</div>
                  <div className="text-xs text-slate-500 break-all">{health.ollama?.endpoint}</div>
                </div>
                <HealthBadge check={health.ollama} />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
                <div>
                  <div className="text-slate-200">Whisper local API</div>
                  <div className="text-xs text-slate-500 break-all">{health.whisperLocal?.endpoint}{config.whisperLocalPath}</div>
                </div>
                <HealthBadge check={health.whisperLocal} />
              </div>
            </div>
          </Section>

          <Section title="Current AI Runtime" desc="What the server will use for new pipeline jobs.">
            <div className="grid md:grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-slate-800 bg-slate-950/60 p-3">
                <div className="text-xs text-slate-500">LLM</div>
                <div className="mt-1 text-slate-200">{config.llmProvider} / {config.llmModel}</div>
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-950/60 p-3">
                <div className="text-xs text-slate-500">ASR</div>
                <div className="mt-1 text-slate-200">{config.asrProvider} / {config.whisperLocalModel || config.whisperModel}</div>
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-950/60 p-3">
                <div className="text-xs text-slate-500">Diarization</div>
                <div className="mt-1 text-slate-200">{config.diarizationMode}</div>
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-950/60 p-3">
                <div className="text-xs text-slate-500">Job limit</div>
                <div className="mt-1 text-slate-200">{counts.activeJobs ?? 0} / {config.maxConcurrentJobs} active</div>
              </div>
            </div>
          </Section>

          <Section title="Recent Jobs" desc="Latest transcript/import jobs retained by the API process.">
            <div className="space-y-2 max-h-72 overflow-auto">
              {(diagnostics.jobs || []).map((job) => (
                <div key={job.id} className="rounded-md border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-200">{job.sourceLabel || job.id}</div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {job.campaignId || 'campaign'} · {job.gameSessionTitle || 'session'} · {job.stage || 'stage unknown'}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">{job.status || 'unknown'}</span>
                  </div>
                  {job.error && <div className="mt-2 text-xs text-rose-300">{job.error}</div>}
                </div>
              ))}
              {(!diagnostics.jobs || diagnostics.jobs.length === 0) && (
                <div className="rounded-md border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">No retained jobs.</div>
              )}
            </div>
          </Section>

          <Section title="Recent Server Log" desc="Request warnings/errors and captured console warnings/errors since this API process started.">
            <div className="max-h-96 overflow-auto rounded-md border border-slate-800 bg-slate-950">
              {(diagnostics.logs || []).map((log) => (
                <div key={log.id} className="border-b border-slate-900 px-3 py-2 font-mono text-[11px] last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={log.level === 'error' ? 'text-rose-300' : log.level === 'warn' ? 'text-amber-300' : 'text-slate-400'}>{log.level}</span>
                    <span className="text-slate-600">{log.type}</span>
                    <span className="text-slate-600">{new Date(log.ts).toLocaleTimeString()}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-slate-300">{log.message}</div>
                </div>
              ))}
              {(!diagnostics.logs || diagnostics.logs.length === 0) && (
                <div className="p-4 text-sm text-slate-500">No log entries yet.</div>
              )}
            </div>
          </Section>
        </>
      )}
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
  const [whisperLocalBase, setWhisperLocalBase] = useState('http://ollama.middl.earth.arda:8765')
  const [whisperLocalPath, setWhisperLocalPath] = useState('/transcribe')
  const [whisperLocalModel, setWhisperLocalModel] = useState('large-v3')
  const [whisperLocalApiKey, setWhisperLocalApiKey] = useState('')
  const [whisperLocalApiKeyHeader, setWhisperLocalApiKeyHeader] = useState('X-API-Key')
  const [health, setHealth] = useState(null)
  const [healthLoading, setHealthLoading] = useState(false)

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
        if (asr.ok) {
          setAsrProvider(asr.asrProvider)
          setAsrInfo(asr)
          if (asr.whisperLocalBase) setWhisperLocalBase(asr.whisperLocalBase)
          if (asr.whisperLocalPath) setWhisperLocalPath(asr.whisperLocalPath)
          if (asr.whisperLocalModel) setWhisperLocalModel(asr.whisperLocalModel)
          if (asr.whisperLocalApiKeyHeader) setWhisperLocalApiKeyHeader(asr.whisperLocalApiKeyHeader)
        }
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
        body: JSON.stringify({
          asrProvider: provider,
          whisperLocalBase,
          whisperLocalPath,
          whisperLocalModel,
          whisperLocalApiKey,
          whisperLocalApiKeyHeader,
        }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error)
      setAsrProvider(j.asrProvider)
      setAsrInfo((prev) => ({ ...(prev || {}), ...j }))
      setWhisperLocalApiKey('')
      setAsrStatus(`Saved: ${j.asrProvider}`)
    } catch (err) { setAsrStatus(`Failed: ${err.message}`) }
  }

  async function saveWhisperLocalConfig() {
    await saveAsr('whisper-local')
  }

  async function runHealthCheck() {
    setHealthLoading(true)
    try {
      const r = await apiFetch('/api/health/pipeline')
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error || 'Health check failed')
      setHealth(j)
    } catch (err) {
      setHealth({ ok: false, error: err.message })
    } finally {
      setHealthLoading(false)
    }
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
      <Section title="Pipeline Health" desc="Quick connectivity check for the same ASR, LLM, and storage stack the DMs use.">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={runHealthCheck}
            disabled={healthLoading}
            className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-amber-700 hover:text-amber-300 disabled:opacity-50"
          >
            {healthLoading ? 'Checking...' : 'Run Check'}
          </button>
          {health?.error && <div className="text-xs text-rose-300">{health.error}</div>}
        </div>
        {health?.ok && (
          <div className="mt-4 space-y-2 font-mono text-sm">
            <HealthRow label="ASR provider" value={health.asr.provider} />
            {health.asr.endpoint && <HealthRow label="ASR endpoint" value={health.asr.endpoint} />}
            {health.asr.path && <HealthRow label="ASR path" value={health.asr.path} />}
            {health.asr.model && <HealthRow label="ASR model" value={health.asr.model} />}
            <HealthRow
              label="ASR status"
              value={health.asr.reachable === null ? health.asr.note : health.asr.reachable ? 'reachable' : `failed - ${health.asr.error || 'unreachable'}`}
              status={health.asr.reachable === null ? 'neutral' : health.asr.reachable ? 'ok' : 'error'}
            />
            <div className="border-t border-slate-800 my-1" />
            <HealthRow label="LLM provider" value={health.llm.provider} />
            {health.llm.endpoint && <HealthRow label="LLM endpoint" value={health.llm.endpoint} />}
            <HealthRow label="LLM model" value={health.llm.model} />
            <HealthRow
              label="LLM status"
              value={health.llm.reachable ? 'reachable' : `failed - ${health.llm.error || 'unreachable'}`}
              status={health.llm.reachable ? 'ok' : 'error'}
            />
            <div className="border-t border-slate-800 my-1" />
            <HealthRow label="Data dir" value={health.dataDir.path} />
            <HealthRow
              label="Data dir status"
              value={health.dataDir.writable ? 'writable' : `failed - ${health.dataDir.error}`}
              status={health.dataDir.writable ? 'ok' : 'error'}
            />
          </div>
        )}
      </Section>

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
            <option value="whisper-local">Whisper local API</option>
            <option value="groq">Groq Cloud</option>
            <option value="openai">OpenAI Cloud</option>
          </select>
          {asrInfo && asrProvider === 'remote' && asrInfo.remoteHost && (
            <span className="text-xs text-slate-500">Host: {asrInfo.remoteHost}</span>
          )}
          {asrInfo && asrProvider === 'whisper-local' && asrInfo.whisperLocalBase && (
            <span className="text-xs text-slate-500">Endpoint: {asrInfo.whisperLocalBase}{asrInfo.whisperLocalPath}</span>
          )}
          {asrInfo && asrProvider === 'local' && (
            <span className="text-xs text-slate-500">Model: {asrInfo.whisperModel} · Device: {asrInfo.whisperDevice}</span>
          )}
          {asrInfo && asrProvider === 'groq' && (
            <span className="text-xs text-slate-500">Model: {asrInfo.groqModel}</span>
          )}
        </div>
        {asrStatus && <div className="mt-2 text-xs text-amber-300">{asrStatus}</div>}
        {asrProvider === 'whisper-local' && (
          <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
            <div className="text-xs text-slate-500">Configure the local Whisper wrapper endpoint used by session imports.</div>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_160px] gap-2">
              <input
                value={whisperLocalBase}
                onChange={(e) => setWhisperLocalBase(e.target.value)}
                placeholder="http://ollama.middl.earth.arda:8765"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono"
              />
              <input
                value={whisperLocalPath}
                onChange={(e) => setWhisperLocalPath(e.target.value)}
                placeholder="/transcribe"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono"
              />
              <input
                value={whisperLocalModel}
                onChange={(e) => setWhisperLocalModel(e.target.value)}
                placeholder="large-v3"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-2">
              <input
                value={whisperLocalApiKeyHeader}
                onChange={(e) => setWhisperLocalApiKeyHeader(e.target.value)}
                placeholder="X-API-Key"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono"
              />
              <input
                type="password"
                value={whisperLocalApiKey}
                onChange={(e) => setWhisperLocalApiKey(e.target.value)}
                placeholder={asrInfo?.hasWhisperLocalApiKey ? 'API key saved' : 'API key'}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono"
              />
              <button
                onClick={saveWhisperLocalConfig}
                className="rounded-md border border-amber-700 text-amber-300 px-4 py-2 text-sm"
              >
                Save
              </button>
            </div>
          </div>
        )}
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
