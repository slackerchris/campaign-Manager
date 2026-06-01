import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../AppContext.jsx'
import { apiFetch } from '../lib/api.js'

export default function Landing() {
  const { campaigns, loadCampaigns, isMobileView } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [checkingAdmin, setCheckingAdmin] = useState(true)
  const [users, setUsers] = useState([])
  const [invites, setInvites] = useState([])
  const [latestInvite, setLatestInvite] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const usersById = useMemo(() => {
    const map = new Map()
    users.forEach((user) => map.set(user.id, user))
    return map
  }, [users])

  async function loadUsers() {
    const res = await apiFetch('/api/admin/users')
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to load users')
    setUsers(data.users || [])
  }

  async function loadInvites() {
    const res = await apiFetch('/api/admin/invites')
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to load invites')
    setInvites(data.invites || [])
  }

  async function loadAdminData() {
    try {
      await Promise.all([loadUsers(), loadInvites(), loadCampaigns()])
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function checkAdmin() {
      try {
        const res = await apiFetch('/api/admin/status')
        const data = await res.json()
        if (!cancelled && data.ok && !data.hasAdmin) {
          navigate('/setup', { replace: true })
          return
        }
        const hasAdminSession = localStorage.getItem('dnd_token_role') === 'admin' && !!localStorage.getItem('dnd_token')
        if (!cancelled && data.ok && data.hasAdmin && !hasAdminSession) {
          navigate('/login', { replace: true })
          return
        }
        if (!cancelled && data.ok && data.hasAdmin && hasAdminSession && location.pathname === '/') {
          navigate('/admin', { replace: true })
          return
        }
      } catch {
        // Let the page render if status cannot be checked.
      }
      if (!cancelled) {
        setCheckingAdmin(false)
        loadAdminData()
      }
    }
    checkAdmin()
    return () => { cancelled = true }
  }, [location.pathname, navigate])

  function inviteLink(invite) {
    return `${window.location.origin}/login?accountInvite=${invite.token}`
  }

  async function copyInvite(invite) {
    if (!invite) return
    const text = `${inviteLink(invite)}\nInvite code: ${invite.token}`
    try {
      await navigator.clipboard.writeText(text)
      setStatus('DM invite copied.')
    } catch {
      setStatus('Copy failed. Select the invite manually.')
    }
  }

  async function createDmInvite(e) {
    e.preventDefault()
    setStatus('Creating DM invite...')
    setError('')
    try {
      const res = await apiFetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'dm' }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to create DM invite')
      setLatestInvite(data.invite)
      await loadInvites()
      setStatus('DM invite created.')
    } catch (err) {
      setError(err.message)
      setStatus('')
    }
  }

  async function updateUserRole(user, role) {
    setError('')
    setStatus(`Updating ${user.displayName || user.username}...`)
    try {
      const res = await apiFetch(`/api/admin/users/${user.id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to update role')
      await loadUsers()
      setStatus(`${data.user.displayName || data.user.username} is now ${data.user.role}.`)
    } catch (err) {
      setError(err.message)
      setStatus('')
    }
  }

  function signOutAdmin() {
    localStorage.removeItem('dnd_token')
    localStorage.removeItem('dnd_token_role')
    localStorage.removeItem('dnd_token_user')
    navigate('/login', { replace: true })
  }

  if (checkingAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
        Checking setup...
      </div>
    )
  }

  return (
    <div
      className={`relative min-h-screen text-slate-100 ${isMobileView ? 'p-3' : 'p-5'}`}
      style={{
        backgroundImage: 'url(/campaign-manager-bg.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
        backgroundAttachment: 'scroll',
      }}
    >
      <div className="absolute inset-0 bg-slate-950/88 pointer-events-none" aria-hidden="true" />

      <main className={`relative z-10 ${isMobileView ? 'max-w-none' : 'max-w-6xl'} mx-auto space-y-4`}>
        <header className="rounded-lg border border-slate-800/90 bg-slate-950/90 p-5 shadow-2xl shadow-black/20">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-[11px] font-semibold uppercase text-amber-400/80">Server Owner</div>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-50">Server Console</h1>
              <p className="mt-1 max-w-2xl text-sm text-slate-400">
                Manage accounts, roles, recovery, and operational campaign records.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => navigate('/login')}
                className="rounded-md border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-300 hover:border-amber-700 hover:text-amber-300"
              >
                Switch User
              </button>
              <button
                onClick={signOutAdmin}
                className="rounded-md border border-rose-900/70 px-3 py-2 text-sm font-semibold text-rose-300 hover:bg-rose-950/40"
              >
                Sign Out
              </button>
            </div>
          </div>
          {(status || error) && (
            <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${error ? 'border-rose-800 bg-rose-950/30 text-rose-300' : 'border-emerald-900 bg-emerald-950/25 text-emerald-300'}`}>
              {error || status}
            </div>
          )}
        </header>

        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="space-y-4">
            <section className="rounded-lg border border-slate-800/90 bg-slate-950/90 p-4">
              <div className="text-[11px] font-semibold uppercase text-amber-400/80">Invite DM</div>
              <form onSubmit={createDmInvite} className="mt-3 space-y-3">
                <button className="w-full rounded-md border border-amber-700 bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400">
                  Create DM Invite
                </button>
              </form>
              {latestInvite && (
                <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/70 p-3">
                  <div className="text-[11px] font-semibold uppercase text-slate-500">Latest Invite</div>
                  <div className="mt-2 break-all text-xs text-slate-400">{inviteLink(latestInvite)}</div>
                  <div className="mt-2 break-all font-mono text-sm text-amber-300">{latestInvite.token}</div>
                  <button
                    onClick={() => copyInvite(latestInvite)}
                    className="mt-3 w-full rounded-md border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-300 hover:border-amber-700 hover:text-amber-300"
                  >
                    Copy Invite
                  </button>
                </div>
              )}
            </section>

            <section className="rounded-lg border border-slate-800/90 bg-slate-950/90 p-4">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Pending Invites</div>
              <div className="mt-3 space-y-2">
                {invites.filter((invite) => !invite.consumedAt && Number(invite.expiresAt || 0) > Date.now()).slice(0, 5).map((invite) => (
                  <button
                    key={invite.token}
                    onClick={() => copyInvite(invite)}
                    className="w-full rounded-md border border-slate-800 bg-slate-950/70 p-2 text-left hover:border-amber-800"
                  >
                    <div className="text-xs font-semibold uppercase text-slate-500">{invite.role} invite</div>
                    <div className="mt-1 truncate font-mono text-xs text-amber-300">{invite.token}</div>
                  </button>
                ))}
                {invites.filter((invite) => !invite.consumedAt && Number(invite.expiresAt || 0) > Date.now()).length === 0 && (
                  <div className="rounded-md border border-dashed border-slate-800 p-3 text-sm text-slate-500">No pending invites.</div>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-slate-800/90 bg-slate-950/90 p-4">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Recovery</div>
              <div className="mt-3 rounded-md border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-300">
                npm run admin:reset
              </div>
            </section>
          </aside>

          <div className="space-y-4">
            <section className="rounded-lg border border-slate-800/90 bg-slate-950/90 p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-100">Users</h2>
                <div className="text-xs text-slate-500">{users.length} accounts</div>
              </div>
              <div className="mt-3 overflow-hidden rounded-lg border border-slate-800">
                <div className="grid grid-cols-[1fr_120px_140px_120px] bg-slate-900/70 px-3 py-2 text-[11px] font-semibold uppercase text-slate-500">
                  <div>Account</div>
                  <div>Role</div>
                  <div>Created</div>
                  <div>Actions</div>
                </div>
                {users.map((user) => (
                  <div key={user.id} className="grid grid-cols-[1fr_120px_140px_120px] border-t border-slate-800 px-3 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="truncate text-slate-100">{user.displayName || user.username}</div>
                      <div className="truncate text-xs text-slate-500">{user.username}</div>
                    </div>
                    <div className="text-slate-300">{user.role}</div>
                    <div className="text-slate-500">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'Unknown'}</div>
                    <div>
                      {user.role === 'player' && (
                        <button
                          onClick={() => updateUserRole(user, 'dm')}
                          className="rounded-md border border-amber-800 px-2 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-950/30"
                        >
                          Promote
                        </button>
                      )}
                      {user.role === 'dm' && (
                        <button
                          onClick={() => updateUserRole(user, 'player')}
                          className="rounded-md border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-300 hover:border-slate-500"
                        >
                          Make Player
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-slate-800/90 bg-slate-950/90 p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-100">Campaign Records</h2>
                <div className="text-xs text-slate-500">{campaigns.length} total</div>
              </div>
              <div className="mt-3 grid gap-3">
                {campaigns.map((campaign) => {
                  const owner = usersById.get(campaign.ownerUserId)
                  return (
                    <div key={campaign.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="truncate text-lg font-medium text-slate-100">{campaign.name}</div>
                          <div className="mt-1 text-xs text-slate-500">{campaign.id}</div>
                        </div>
                        <div className="grid gap-1 text-sm md:min-w-56">
                          <div className="flex justify-between gap-3">
                            <span className="text-slate-500">DM</span>
                            <span className="text-slate-300">{owner?.displayName || campaign.ownerDisplayName || 'Unassigned'}</span>
                          </div>
                          <div className="flex justify-between gap-3">
                            <span className="text-slate-500">Created</span>
                            <span className="text-slate-300">{campaign.createdAt ? new Date(campaign.createdAt).toLocaleDateString() : 'Unknown'}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {campaigns.length === 0 && (
                  <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">
                    DM-created campaigns will appear here for operational visibility.
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
