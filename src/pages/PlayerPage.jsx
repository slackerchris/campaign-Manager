import { useState } from 'react'
import { useApp } from '../AppContext.jsx'
import { useAuth } from '../AuthContext.jsx'
import { apiFetch } from '../lib/api.js'

export default function PlayerPage() {
  const {
    state, activeCampaign,
    setShowAddPc, openEditPc,
    submitPlayerContribution, addPlayerQuoteDirect,
  } = useApp()
  const { user } = useAuth()
  const isDm = ['dm', 'admin'].includes(user?.role)

  const sortedSessions = (state.gameSessions || []).slice().sort((a, b) => {
    const na = Number(String(a?.title || '').match(/\d+/)?.[0] || 0)
    const nb = Number(String(b?.title || '').match(/\d+/)?.[0] || 0)
    return na - nb
  })

  const playerNameOptions = Array.from(
    new Set((state.pcs || []).map((pc) => String(pc.playerName || '').trim()).filter(Boolean))
  )

  // ── player submission state ───────────────────────────────────────────────
  const [playerSessionId, setPlayerSessionId] = useState('')
  const [playerSubmissionName, setPlayerSubmissionName] = useState(user?.displayName || '')
  const [playerSubmissionType, setPlayerSubmissionType] = useState('note')
  const [playerSubmissionText, setPlayerSubmissionText] = useState('')
  const [playerSubmissionStatus, setPlayerSubmissionStatus] = useState('')

  // ── invite player state ───────────────────────────────────────────────────
  const [serverUsers, setServerUsers] = useState([])
  const [userSearch, setUserSearch] = useState('')
  const [inviteStatus, setInviteStatus] = useState('')
  const [inviteError, setInviteError] = useState('')

  async function loadServerUsers() {
    if (serverUsers.length) return
    try {
      const r = await apiFetch('/api/server/users')
      const j = await r.json()
      if (j.ok) setServerUsers(j.users)
    } catch { /* ignore */ }
  }

  async function sendDirectInvite(user) {
    if (!activeCampaign) return
    setInviteStatus('Sending...')
    setInviteError('')
    try {
      const r = await apiFetch(`/api/campaigns/${activeCampaign.id}/auth/direct-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetServerUserId: user.id }),
      })
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error || 'Invite failed')
      setInviteStatus(`Invite sent to ${user.displayName}`)
      setUserSearch('')
    } catch (err) {
      setInviteError(err.message)
      setInviteStatus('')
    }
  }

  // ── quote state ───────────────────────────────────────────────────────────
  const [playerQuoteText, setPlayerQuoteText] = useState('')
  const [playerQuoteSpeaker, setPlayerQuoteSpeaker] = useState('')
  const [playerQuoteTag, setPlayerQuoteTag] = useState('')
  const [playerQuoteStatus, setPlayerQuoteStatus] = useState('')

  async function doSubmit() {
    if (!activeCampaign) return
    if (!playerSubmissionName.trim() || !playerSubmissionText.trim()) {
      setPlayerSubmissionStatus('Need player name + notes')
      return
    }
    const session = sortedSessions.find((s) => s.id === playerSessionId)
    const ok = await submitPlayerContribution({
      playerName: playerSubmissionName.trim(),
      type: playerSubmissionType,
      text: playerSubmissionText.trim(),
      gameSessionId: playerSessionId || undefined,
      gameSessionTitle: session?.title || 'Player Submission',
    }, setPlayerSubmissionStatus)
    if (ok) setPlayerSubmissionText('')
  }

  async function doAddQuote() {
    if (!activeCampaign) return
    if (!playerQuoteText.trim()) { setPlayerQuoteStatus('Quote text required'); return }
    const ok = await addPlayerQuoteDirect({
      text: playerQuoteText.trim(),
      speaker: playerQuoteSpeaker.trim(),
      playerName: playerSubmissionName.trim(),
      gameSessionId: playerSessionId || undefined,
      tag: playerQuoteTag.trim(),
    }, setPlayerQuoteStatus)
    if (ok) { setPlayerQuoteText(''); setPlayerQuoteSpeaker(''); setPlayerQuoteTag('') }
  }

  return (
    <div className="space-y-4">
      {/* PC List */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/80 p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[11px] font-semibold uppercase text-amber-400/80">Party</div>
            <h2 className="text-base font-semibold">Player Characters</h2>
          </div>
          {isDm && <button onClick={() => setShowAddPc(true)} className="rounded-md border border-emerald-700 text-emerald-300 px-3 py-1.5 text-sm">Add PC</button>}
        </div>
        <div className="mt-3 space-y-2">
          {(state.pcs || []).map((pc) => (
            <div key={pc.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-medium">{pc.characterName || pc.name}</div>
                  <div className="text-slate-400">{pc.playerName ? `Player: ${pc.playerName} • ` : ''}{pc.ddbUsername ? `@${pc.ddbUsername} • ` : ''}{pc.race || 'Race?'} {pc.class || 'Class?'} • Lv {pc.level || 1}</div>
                </div>
                <button onClick={() => openEditPc(pc)} className="rounded-md border border-slate-700 px-2 py-1 text-xs">Edit</button>
              </div>
            </div>
          ))}
          {(state.pcs || []).length === 0 && <div className="text-sm text-slate-400">No PCs yet.</div>}
        </div>
      </div>

      {/* Invite Player — DM only */}
      {isDm && <div className="rounded-lg border border-slate-800 bg-slate-950/80 p-4" onClick={loadServerUsers}>
        <div className="text-[11px] font-semibold uppercase text-amber-400/80">Party</div>
        <h2 className="text-base font-semibold">Invite Player</h2>
        <p className="mt-1 text-sm text-slate-400">Search for a registered account and send them a campaign invite. They'll see it on their player home.</p>
        <input
          value={userSearch}
          onChange={(e) => setUserSearch(e.target.value)}
          placeholder="Search by name or username..."
          className="mt-3 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-600"
        />
        {inviteError && <div className="mt-2 text-xs text-rose-400">{inviteError}</div>}
        {inviteStatus && <div className="mt-2 text-xs text-emerald-400">{inviteStatus}</div>}
        <div className="mt-2 space-y-1">
          {serverUsers
            .filter((u) => {
              if (!userSearch.trim()) return false
              const q = userSearch.toLowerCase()
              return u.username.includes(q) || u.displayName.toLowerCase().includes(q)
            })
            .slice(0, 6)
            .map((u) => (
              <div key={u.id} className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2">
                <div>
                  <div className="text-sm text-slate-100">{u.displayName}</div>
                  <div className="text-xs text-slate-500">@{u.username}</div>
                </div>
                <button
                  onClick={() => sendDirectInvite(u)}
                  className="rounded-md border border-amber-700 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-500/20"
                >
                  Invite
                </button>
              </div>
            ))}
          {userSearch.trim() && serverUsers.filter((u) => {
            const q = userSearch.toLowerCase()
            return u.username.includes(q) || u.displayName.toLowerCase().includes(q)
          }).length === 0 && (
            <div className="text-xs text-slate-500 mt-2">No users found.</div>
          )}
        </div>
      </div>}

      {/* Player Contributions */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/80 p-4">
        <div className="text-[11px] font-semibold uppercase text-amber-400/80">Player Desk</div>
        <h2 className="text-base font-semibold">Session Notes</h2>
        <p className="mt-1 text-sm text-slate-400">Send notes, corrections, and discoveries back to the campaign record.</p>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2">
          {isDm ? (
            <select
              value={playerSubmissionName}
              onChange={(e) => setPlayerSubmissionName(e.target.value)}
              className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
            >
              <option value="">Select player…</option>
              {playerNameOptions.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          ) : (
            <div className="rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-400">
              {user?.displayName || 'You'}
            </div>
          )}
          <select
            value={playerSubmissionType}
            onChange={(e) => setPlayerSubmissionType(e.target.value)}
            className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
          >
            <option value="note">Session Note</option>
            <option value="quote">Quote</option>
            <option value="npc">NPC Update</option>
            <option value="quest">Quest Update</option>
            <option value="correction">Correction</option>
          </select>
          <select
            value={playerSessionId}
            onChange={(e) => setPlayerSessionId(e.target.value)}
            className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
          >
            <option value="">No session link</option>
            {sortedSessions.map((s) => (
              <option key={s.id} value={s.id}>{s.label ? `${s.title} — ${s.label}` : s.title}</option>
            ))}
          </select>
          <button onClick={doSubmit} className="rounded-md border border-emerald-700 text-emerald-300 px-4 py-2 text-sm">Submit</button>
        </div>
        <textarea
          value={playerSubmissionText}
          onChange={(e) => setPlayerSubmissionText(e.target.value)}
          placeholder="Session notes, memorable quotes, corrections..."
          className="mt-2 w-full min-h-28 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
        />
        {playerSubmissionStatus && <div className="mt-2 text-xs text-amber-300">{playerSubmissionStatus}</div>}
      </div>

      {/* Direct Quote Add */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/80 p-4">
        <div className="text-[11px] font-semibold uppercase text-amber-400/80">Quote Vault</div>
        <h2 className="text-base font-semibold">Add Quote</h2>
        <p className="mt-1 text-sm text-slate-400">Capture a memorable line while it is still fresh.</p>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
          <input
            value={playerQuoteSpeaker}
            onChange={(e) => setPlayerQuoteSpeaker(e.target.value)}
            placeholder="Speaker name"
            className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
          />
          <input
            value={playerQuoteTag}
            onChange={(e) => setPlayerQuoteTag(e.target.value)}
            placeholder="Tag (optional)"
            className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
          />
          <button onClick={doAddQuote} className="rounded-md border border-amber-700 text-amber-300 px-4 py-2 text-sm">Add to Vault</button>
        </div>
        <textarea
          value={playerQuoteText}
          onChange={(e) => setPlayerQuoteText(e.target.value)}
          placeholder={`"Something memorable someone said..."`}
          className="mt-2 w-full min-h-20 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
        />
        {playerQuoteStatus && <div className="mt-2 text-xs text-amber-300">{playerQuoteStatus}</div>}
      </div>
    </div>
  )
}
