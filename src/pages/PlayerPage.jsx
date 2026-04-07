import { useState } from 'react'
import { useApp } from '../AppContext.jsx'

export default function PlayerPage() {
  const {
    state, activeCampaign,
    setShowAddPc, openEditPc,
    submitPlayerContribution, addPlayerQuoteDirect,
  } = useApp()

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
  const [playerSubmissionName, setPlayerSubmissionName] = useState('')
  const [playerSubmissionType, setPlayerSubmissionType] = useState('note')
  const [playerSubmissionText, setPlayerSubmissionText] = useState('')
  const [playerSubmissionStatus, setPlayerSubmissionStatus] = useState('')

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
    <div className="space-y-6">
      {/* PC List */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">Player Characters</h2>
          <button onClick={() => setShowAddPc(true)} className="rounded-lg border border-emerald-700 text-emerald-300 px-3 py-1 text-sm">Add PC</button>
        </div>
        <div className="mt-3 space-y-2">
          {(state.pcs || []).map((pc) => (
            <div key={pc.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-medium">{pc.characterName || pc.name}</div>
                  <div className="text-slate-400">{pc.playerName ? `Player: ${pc.playerName} • ` : ''}{pc.ddbUsername ? `@${pc.ddbUsername} • ` : ''}{pc.race || 'Race?'} {pc.class || 'Class?'} • Lv {pc.level || 1}</div>
                </div>
                <button onClick={() => openEditPc(pc)} className="rounded-lg border border-slate-600 px-2 py-1 text-xs">Edit</button>
              </div>
            </div>
          ))}
          {(state.pcs || []).length === 0 && <div className="text-sm text-slate-400">No PCs yet.</div>}
        </div>
      </div>

      {/* Player Contributions */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">Player Contributions</h2>
        <p className="mt-1 text-sm text-slate-400">Submit notes/quotes directly to the campaign.</p>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2">
          <select
            value={playerSubmissionName}
            onChange={(e) => setPlayerSubmissionName(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            <option value="">Select player…</option>
            {playerNameOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select
            value={playerSubmissionType}
            onChange={(e) => setPlayerSubmissionType(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
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
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            <option value="">No session link</option>
            {sortedSessions.map((s) => (
              <option key={s.id} value={s.id}>{s.label ? `${s.title} — ${s.label}` : s.title}</option>
            ))}
          </select>
          <button onClick={doSubmit} className="rounded-xl border border-emerald-700 text-emerald-300 px-4 py-2 text-sm">Submit</button>
        </div>
        <textarea
          value={playerSubmissionText}
          onChange={(e) => setPlayerSubmissionText(e.target.value)}
          placeholder="Session notes, memorable quotes, corrections..."
          className="mt-2 w-full min-h-28 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
        {playerSubmissionStatus && <div className="mt-2 text-xs text-amber-300">{playerSubmissionStatus}</div>}
      </div>

      {/* Direct Quote Add */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">Add Quote Directly</h2>
        <p className="mt-1 text-sm text-slate-400">Skip the approval queue — add a memorable quote straight to the vault.</p>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
          <input
            value={playerQuoteSpeaker}
            onChange={(e) => setPlayerQuoteSpeaker(e.target.value)}
            placeholder="Speaker name"
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <input
            value={playerQuoteTag}
            onChange={(e) => setPlayerQuoteTag(e.target.value)}
            placeholder="Tag (optional)"
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <button onClick={doAddQuote} className="rounded-xl border border-amber-700 text-amber-300 px-4 py-2 text-sm">Add to Vault</button>
        </div>
        <textarea
          value={playerQuoteText}
          onChange={(e) => setPlayerQuoteText(e.target.value)}
          placeholder={`"Something memorable someone said..."`}
          className="mt-2 w-full min-h-20 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
        {playerQuoteStatus && <div className="mt-2 text-xs text-amber-300">{playerQuoteStatus}</div>}
      </div>
    </div>
  )
}
