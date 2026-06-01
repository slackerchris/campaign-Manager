import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../AuthContext.jsx'
import { useApp } from '../AppContext.jsx'
import { apiFetch } from '../lib/api.js'

export default function PlayerHome() {
  const { user, isLoading, login } = useAuth()
  const { selectCampaign } = useApp()
  const navigate = useNavigate()

  const [campaigns, setCampaigns] = useState([])
  const [loadingCampaigns, setLoadingCampaigns] = useState(true)
  const [pendingInvites, setPendingInvites] = useState([])
  const [acceptingInvite, setAcceptingInvite] = useState(null)

  const [showJoin, setShowJoin] = useState(false)
  const [joinCampaignId, setJoinCampaignId] = useState('')
  const [joinToken, setJoinToken] = useState('')
  const [joinDisplayName, setJoinDisplayName] = useState('')
  const [joinStatus, setJoinStatus] = useState('')
  const [joinError, setJoinError] = useState('')

  useEffect(() => {
    if (user?.role === 'player') {
      loadCampaigns()
      loadInvites()
    }
  }, [user?.role])

  async function loadCampaigns() {
    setLoadingCampaigns(true)
    try {
      const r = await apiFetch('/api/player/campaigns')
      const j = await r.json()
      if (j.ok) setCampaigns(j.campaigns)
    } catch { /* ignore */ }
    setLoadingCampaigns(false)
  }

  async function loadInvites() {
    try {
      const r = await apiFetch('/api/player/invites')
      const j = await r.json()
      if (j.ok) setPendingInvites(j.invites)
    } catch { /* ignore */ }
  }

  async function acceptInvite(invite) {
    setAcceptingInvite(invite.inviteToken)
    try {
      const r = await apiFetch(`/api/campaigns/${invite.campaignId}/auth/accept-direct-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken: invite.inviteToken, displayName: user.displayName }),
      })
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error || 'Failed to accept invite')
      login(invite.campaignId, j.session)
      await Promise.all([loadCampaigns(), loadInvites()])
      navigate(`/campaigns/${invite.campaignId}/me`)
    } catch (err) {
      alert(err.message)
    }
    setAcceptingInvite(null)
  }

  async function declineInvite(invite) {
    // For now just remove from local state — a proper decline endpoint could be added later
    setPendingInvites((prev) => prev.filter((i) => i.inviteToken !== invite.inviteToken))
  }

  async function handleJoin(e) {
    e.preventDefault()
    const target = joinCampaignId.trim()
    if (!target || !joinToken.trim() || !joinDisplayName.trim()) return
    setJoinStatus('Joining...')
    setJoinError('')
    try {
      const r = await apiFetch(`/api/campaigns/${target}/auth/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken: joinToken.trim(), displayName: joinDisplayName.trim() }),
      })
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error || 'Join failed')
      login(target, j.session)
      setJoinStatus('')
      setShowJoin(false)
      setJoinCampaignId('')
      setJoinToken('')
      setJoinDisplayName('')
      await loadCampaigns()
      navigate(`/campaigns/${target}/me`)
    } catch (err) {
      setJoinError(err.message)
      setJoinStatus('')
    }
  }

  function enterCampaign(c) {
    selectCampaign(c)
  }

  function signOut() {
    localStorage.removeItem('dnd_token')
    localStorage.removeItem('dnd_token_role')
    localStorage.removeItem('dnd_token_user')
    localStorage.removeItem('dnd_token_display')
    navigate('/login', { replace: true })
  }

  if (isLoading) return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
      Loading...
    </div>
  )

  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'admin') return <Navigate to="/admin" replace />
  if (user.role === 'dm') return <Navigate to="/dm" replace />
  if (user.role !== 'player') return <Navigate to="/login" replace />

  const displayName = user.displayName || user.id

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

      <div className="relative z-10 mx-auto max-w-3xl px-5 py-8 space-y-5">

        {/* Header */}
        <header className="rounded-xl border border-slate-800/80 bg-slate-950/80 p-6 shadow-xl shadow-black/20">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-amber-400/80">Player</div>
              <h1 className="mt-1 text-2xl font-bold text-slate-50">{displayName}</h1>
              <p className="mt-1 text-sm text-slate-400">Your campaigns</p>
            </div>
            <div className="flex gap-3 shrink-0">
              <button
                onClick={() => { setShowJoin((s) => !s); setJoinError('') }}
                className="rounded-lg border border-amber-700 bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400"
              >
                {showJoin ? 'Cancel' : '+ Join Campaign'}
              </button>
              <button
                onClick={signOut}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:border-slate-500 hover:text-slate-100"
              >
                Sign Out
              </button>
            </div>
          </div>

          {showJoin && (
            <form onSubmit={handleJoin} className="mt-5 space-y-3 border-t border-slate-800 pt-5">
              {joinError && <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">{joinError}</div>}
              {joinStatus && <div className="rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-300">{joinStatus}</div>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold uppercase text-slate-500 mb-1">Campaign ID</label>
                  <input
                    value={joinCampaignId}
                    onChange={(e) => setJoinCampaignId(e.target.value)}
                    placeholder="campaign-id"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase text-slate-500 mb-1">Invite Code</label>
                  <input
                    value={joinToken}
                    onChange={(e) => setJoinToken(e.target.value)}
                    placeholder="Paste invite code"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase text-slate-500 mb-1">Your Name in This Campaign</label>
                <input
                  value={joinDisplayName}
                  onChange={(e) => setJoinDisplayName(e.target.value)}
                  placeholder="Display name"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600"
                />
              </div>
              <button
                type="submit"
                disabled={!joinCampaignId.trim() || !joinToken.trim() || !joinDisplayName.trim()}
                className="rounded-lg border border-amber-700 bg-amber-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                Join Campaign
              </button>
            </form>
          )}
        </header>

        {/* Pending invites */}
        {pendingInvites.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-400/80 mb-3">Campaign Invites</h2>
            <div className="space-y-2">
              {pendingInvites.map((invite) => (
                <div key={invite.inviteToken} className="rounded-xl border border-amber-800/50 bg-amber-950/20 p-4 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-semibold text-slate-100">{invite.campaignName}</div>
                    <div className="text-xs text-slate-400 mt-0.5">Invited by {invite.dmDisplayName}</div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => acceptInvite(invite)}
                      disabled={acceptingInvite === invite.inviteToken}
                      className="rounded-lg border border-amber-700 bg-amber-500 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
                    >
                      {acceptingInvite === invite.inviteToken ? 'Joining...' : 'Accept'}
                    </button>
                    <button
                      onClick={() => declineInvite(invite)}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Campaign list */}
        {loadingCampaigns ? (
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/80 p-8 text-center text-sm text-slate-500">
            Loading campaigns...
          </div>
        ) : campaigns.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {campaigns.map((c) => (
              <div key={c.id} className="rounded-xl border border-slate-800/80 bg-slate-950/80 p-5 shadow-lg shadow-black/10 flex flex-col">
                <div className="flex-1">
                  <div className="text-lg font-bold text-slate-50">{c.name}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    DM: {c.ownerDisplayName || 'unknown'}
                    {c.createdAt ? ` · ${new Date(c.createdAt).toLocaleDateString()}` : ''}
                  </div>
                  {c.displayName && (
                    <div className="mt-2 text-xs text-amber-400/70">Playing as {c.displayName}</div>
                  )}
                </div>
                <button
                  onClick={() => enterCampaign(c)}
                  className="mt-4 w-full rounded-lg border border-amber-700 bg-amber-500/10 py-2.5 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 transition-colors"
                >
                  Enter Campaign →
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/80 p-10 text-center shadow-xl shadow-black/20">
            <div className="text-3xl mb-3">🎲</div>
            <h2 className="text-xl font-bold text-slate-100">No Campaigns Yet</h2>
            <p className="mt-2 text-sm text-slate-400 max-w-sm mx-auto">
              Ask your DM for a Campaign ID and invite code, then click <strong className="text-slate-200">Join Campaign</strong> above.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
