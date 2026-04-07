import { useRef, useState } from 'react'
import { useApp } from '../AppContext.jsx'
import { apiFetch } from '../lib/api.js'
import { fmtEta, formatJournalMarkdown, importSummaryFromApproval, speakerIdsFromTranscript, relabelSpeakerTranscript } from '../lib/utils.js'

const API_BASE = '/api'

export default function DmPage() {
  const {
    state, activeCampaign, campaigns, llmProvider, llmModel,
    managerSessionId, setManagerSessionId,
    pipelineSessionId, setPipelineSessionId,
    handleApproval, openApprovalReview,
    openEditNpc, openEditPc,
    setShowAddPc,
    dmNotesDraft, setDmNotesDraft, saveDmNotes,
    addDmSneakPeekItem, toggleDmSneakPeekItem, deleteDmSneakPeekItem,
    runDataBrowserImport,
    deletePc,
    importDndbCharacter, linkPcToDdb, syncPcFromDdb,
    importModulePdf,
    createGameSession, deleteSelectedSession,
    setError,
  } = useApp()

  const [dmTab, setDmTab] = useState('session')
  const fileRef = useRef(null)

  // ── sorted sessions ───────────────────────────────────────────────────────
  const sortedSessions = (state.gameSessions || []).slice().sort((a, b) => {
    const na = Number(String(a?.title || '').match(/\d+/)?.[0] || 0)
    const nb = Number(String(b?.title || '').match(/\d+/)?.[0] || 0)
    return na - nb
  })

  // ── session manager state ─────────────────────────────────────────────────
  const [newSessionNumber, setNewSessionNumber] = useState('')
  const [newSessionLabel, setNewSessionLabel] = useState('')

  // ── pipeline state ────────────────────────────────────────────────────────
  const [inputMode, setInputMode] = useState('audio')
  const [selectedFile, setSelectedFile] = useState(null)
  const [sourceLabel, setSourceLabel] = useState('')
  const [job, setJob] = useState({ status: 'idle', stage: '', progressPct: 0, etaSec: null, doneChunks: 0, totalChunks: 0 })
  const [lastTranscript, setLastTranscript] = useState('')
  const [speakerMap, setSpeakerMap] = useState({})

  // ── module pdf state ──────────────────────────────────────────────────────
  const [modulePdf, setModulePdf] = useState(null)
  const [isImportingModule, setIsImportingModule] = useState(false)

  // ── DnD Beyond state ──────────────────────────────────────────────────────
  const [ddbCharacterInput, setDdbCharacterInput] = useState('')
  const [ddbSyncStatus, setDdbSyncStatus] = useState('')

  // ── DM Sneak Peek state ───────────────────────────────────────────────────
  const [dmSneakPeekText, setDmSneakPeekText] = useState('')
  const [dmSneakPeekDueTag, setDmSneakPeekDueTag] = useState('')
  const [dmSneakPeekStatus, setDmSneakPeekStatus] = useState('')

  // ── Data Browser state ────────────────────────────────────────────────────
  const [dataBrowserSource, setDataBrowserSource] = useState('dnd-data')
  const [dataBrowserCampaignId, setDataBrowserCampaignId] = useState(() => activeCampaign?.id || '')
  const [dataBrowserBook, setDataBrowserBook] = useState('Curse of Strahd')
  const [dataBrowserMode, setDataBrowserMode] = useState('approval')
  const [dataBrowserSets, setDataBrowserSets] = useState({ npcs: true, monsters: true, spells: true, items: true, classes: true, species: true, backgrounds: true, places: true, lore: true })
  const [dataBrowserStatus, setDataBrowserStatus] = useState('Ready.')

  // ── derived ───────────────────────────────────────────────────────────────
  const latestApproval = (state.approvals || [])[0] || null
  const latestImportStats = latestApproval && latestApproval.sourceType === 'data-browser'
    ? {
        npcs: (latestApproval.npcUpdates || []).length,
        quests: (latestApproval.questUpdates || []).length,
        lexicon: (latestApproval.lexiconAdds || []).length,
        places: (latestApproval.placeAdds || []).length,
        quotes: (latestApproval.quotes || []).length,
      }
    : null
  const latestImportSummary = importSummaryFromApproval(latestApproval)
  const speakerIds = speakerIdsFromTranscript(lastTranscript)
  const speakerOptions = ['DM', ...((state.pcs || []).map((pc) => pc.characterName || pc.name).filter(Boolean))]
  const displayTranscript = relabelSpeakerTranscript(lastTranscript, speakerMap)

  // ── pipeline functions ────────────────────────────────────────────────────
  async function runPipeline() {
    if (!activeCampaign) return setError('Pick campaign first')
    if (!selectedFile) return setError('Pick file first')
    if (!pipelineSessionId) return setError('Pick a game session first')

    const sessionExists = (state.gameSessions || []).some((s) => String(s?.id || '') === String(pipelineSessionId))
    if (!sessionExists) {
      setPipelineSessionId('')
      return setError('Selected game session no longer exists. Re-select a session and try again.')
    }

    setError('')
    setLastTranscript('')
    setJob({ status: 'uploading', stage: 'uploading', progressPct: 0, etaSec: null, doneChunks: 0, totalChunks: 0 })

    const endpoint = inputMode === 'audio' ? '/transcribe' : '/transcribe-text'
    const field = inputMode === 'audio' ? 'audio' : 'transcript'
    const form = new FormData()
    form.append(field, selectedFile)
    form.append('campaignId', activeCampaign.id)
    form.append('gameSessionId', pipelineSessionId)
    form.append('sourceLabel', sourceLabel || selectedFile.name)

    const start = await apiFetch(`${API_BASE}${endpoint}`, { method: 'POST', body: form })
    const sj = await start.json()
    if (!start.ok || !sj.ok) return setError(sj.error || 'Start failed')

    while (true) {
      await new Promise((r) => setTimeout(r, 3000))
      const pr = await apiFetch(`${API_BASE}/transcribe/${sj.jobId}`)
      const pj = await pr.json()
      if (!pr.ok || !pj.ok) return setError(pj.error || 'Job poll failed')

      setJob(pj)

      if (pj.status === 'done') {
        setLastTranscript(pj.diarizedTranscript || pj.transcript || '')
        break
      }
      if (pj.status === 'cancelled') { setError('Pipeline cancelled'); break }
      if (pj.status === 'error') { setError(pj.error || 'Pipeline failed'); break }
    }
  }

  async function cancelPipeline() {
    const jobId = String(job?.id || '').trim()
    if (!jobId) return
    const r = await apiFetch(`${API_BASE}/transcribe/${jobId}/cancel`, { method: 'POST' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.ok) { setError(j.error || 'Cancel failed'); return }
    setJob((prev) => ({ ...prev, stage: 'cancelling' }))
  }

  function toggleDataSet(key) {
    setDataBrowserSets((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-2 flex gap-2 overflow-x-auto">
        {[
          { id: 'session', label: 'Session' },
          { id: 'review', label: 'Review' },
          { id: 'campaign', label: 'Campaign' },
          { id: 'tools', label: 'Tools' },
        ].map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setDmTab(id)}
            className={`rounded-xl px-4 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
              dmTab === id
                ? 'bg-amber-500 text-slate-950'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            {label}
          </button>
        ))}
        {/* Pending approval count badge on Review tab */}
        {dmTab !== 'review' && (state.approvals || []).filter((a) => a.status === 'pending').length > 0 && (
          <button
            onClick={() => setDmTab('review')}
            className="ml-auto rounded-full bg-rose-600 text-white text-xs px-2 py-0.5 font-semibold"
          >
            {(state.approvals || []).filter((a) => a.status === 'pending').length} pending
          </button>
        )}
      </div>

      {/* ── SESSION tab ─────────────────────────────────────────────────── */}
      {dmTab === 'session' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Session Manager */}
            <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5 space-y-3">
              <h2 className="text-xl font-semibold">Session Manager</h2>
              <div className="flex gap-2">
                <select
                  value={managerSessionId}
                  onChange={(e) => setManagerSessionId(e.target.value)}
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"
                >
                  <option value="">Select session…</option>
                  {sortedSessions.map((s) => (
                    <option key={s.id} value={s.id}>{s.label ? `${s.title} — ${s.label}` : s.title}</option>
                  ))}
                </select>
                <button
                  onClick={() => deleteSelectedSession(managerSessionId)}
                  disabled={!managerSessionId}
                  className="rounded-xl border border-rose-700 text-rose-300 px-3 disabled:opacity-40"
                >Delete</button>
              </div>
              <div className="space-y-2">
                <input
                  type="number" min="1"
                  value={newSessionNumber}
                  onChange={(e) => setNewSessionNumber(e.target.value)}
                  placeholder="Session number (e.g. 7)"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"
                />
                <input
                  value={newSessionLabel}
                  onChange={(e) => setNewSessionLabel(e.target.value)}
                  placeholder="Friendly label (optional)"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"
                />
                <button
                  onClick={async () => {
                    const s = await createGameSession(newSessionNumber, newSessionLabel)
                    if (s) { setNewSessionNumber(''); setNewSessionLabel('') }
                  }}
                  className="w-full rounded-xl border border-slate-700 px-3 py-2"
                >Add Session</button>
              </div>
            </div>

            {/* Pipeline */}
            <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5 space-y-3">
              <h2 className="text-xl font-semibold">Session Import</h2>
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
                Model in use: <span className="text-amber-300 font-medium">{llmProvider}/{llmModel}</span>
              </div>
              <select
                value={pipelineSessionId}
                onChange={(e) => setPipelineSessionId(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"
              >
                <option value="">Select session…</option>
                {sortedSessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.label ? `${s.title} — ${s.label}` : s.title}</option>
                ))}
              </select>
              <select
                value={inputMode}
                onChange={(e) => { setInputMode(e.target.value); setSelectedFile(null) }}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"
              >
                <option value="audio">Audio → Whisper</option>
                <option value="transcript">Transcript Upload</option>
              </select>
              <input
                value={sourceLabel}
                onChange={(e) => setSourceLabel(e.target.value)}
                placeholder="Source label (optional)"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"
              />
              <input
                ref={fileRef}
                type="file"
                accept={inputMode === 'audio' ? 'audio/*' : '.txt,.md,.json'}
                className="hidden"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
              />
              <button onClick={() => fileRef.current?.click()} className="w-full rounded-xl bg-amber-500 text-slate-950 px-4 py-2 font-semibold">
                {selectedFile ? selectedFile.name : 'Choose file'}
              </button>
              <button onClick={runPipeline} className="w-full rounded-xl border border-slate-700 px-4 py-2">Run Pipeline</button>
              {['running', 'queued', 'uploading'].includes(String(job.status || '')) && job.id && (
                <button onClick={cancelPipeline} className="w-full rounded-xl border border-rose-700 text-rose-300 px-4 py-2">Cancel</button>
              )}
              <div className="text-xs text-slate-300 space-y-1">
                <div>Status: {job.status || 'idle'}</div>
                <div>Stage: {job.stage || '—'}</div>
                <div>Progress: {job.progressPct || 0}% {job.totalChunks ? `(${job.doneChunks}/${job.totalChunks})` : ''}</div>
                <div>ETA: {fmtEta(job.etaSec)}</div>
              </div>
            </div>

            {/* Campaign Module PDF */}
            <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5 space-y-3">
              <h2 className="text-xl font-semibold">Campaign Module (PDF)</h2>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setModulePdf(e.target.files?.[0] || null)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
              <button
                onClick={() => importModulePdf(modulePdf, setIsImportingModule, setError)}
                disabled={!modulePdf || isImportingModule}
                className="w-full rounded-xl border border-slate-700 px-3 py-2 disabled:opacity-40"
              >
                {isImportingModule ? 'Importing module…' : 'Import Module → Approval Queue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── REVIEW tab ──────────────────────────────────────────────────── */}
      {dmTab === 'review' && (
        <div className="space-y-6">
          {/* Import Highlights */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-semibold">Import Highlights</h2>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <div className="text-slate-400 text-xs">Pending approvals</div>
                <div className="text-lg font-semibold">{(state.approvals || []).filter((a) => a.status === 'pending').length}</div>
              </div>
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <div className="text-slate-400 text-xs">Canon NPCs</div>
                <div className="text-lg font-semibold">{(state.npcs || []).length}</div>
              </div>
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <div className="text-slate-400 text-xs">Canon Places</div>
                <div className="text-lg font-semibold">{(state.places || []).length}</div>
              </div>
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <div className="text-slate-400 text-xs">Canon Terms</div>
                <div className="text-lg font-semibold">{(state.lexicon || []).length}</div>
              </div>
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <div className="text-slate-400 text-xs">Journal entries</div>
                <div className="text-lg font-semibold">{(state.journal || []).length}</div>
              </div>
            </div>
            {latestImportStats && (
              <div className="mt-3 rounded-xl border border-amber-700/40 bg-amber-950/20 p-3 text-xs text-amber-200 space-y-1">
                <div>Latest data import → NPCs: {latestImportStats.npcs}, Quests: {latestImportStats.quests}, Lexicon: {latestImportStats.lexicon}, Places: {latestImportStats.places}, Quotes: {latestImportStats.quotes}</div>
                {latestImportSummary.map((line, i) => <div key={i}>• {line}</div>)}
              </div>
            )}
          </div>

          {/* Approval Queue */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-semibold">Approval Queue</h2>
            <div className="mt-3 space-y-2 max-h-96 overflow-auto">
              {(state.approvals || []).map((a) => (
                <div key={a.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                  <div className="text-sm font-medium">{a.gameSessionTitle} • {a.sourceLabel}</div>
                  <div className="text-xs text-slate-400">{a.status} • {a.sourceType || 'source'} • {a.createdAt ? new Date(a.createdAt).toLocaleString() : ''}</div>
                  <div className="text-xs text-slate-500 mt-1">AI reviewer: {a.reviewerModel ? `${a.reviewerProvider || 'llm'} / ${a.reviewerModel}` : 'not recorded (older proposal)'}</div>
                  <button onClick={() => openApprovalReview(a)} className="mt-2 rounded-lg border border-slate-600 px-2 py-1 text-xs">Open Review</button>
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => handleApproval(a.id, 'approve')} disabled={a.status !== 'pending'} className="rounded-lg border border-emerald-600 px-2 py-1 text-xs disabled:opacity-40">Approve</button>
                    <button onClick={() => handleApproval(a.id, 'reject')} disabled={a.status !== 'pending'} className="rounded-lg border border-rose-600 px-2 py-1 text-xs disabled:opacity-40">Reject</button>
                  </div>
                </div>
              ))}
              {(!state.approvals || state.approvals.length === 0) && <div className="text-sm text-slate-400">No pending approvals.</div>}
            </div>
          </div>

          {/* Journal + Transcript */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-xl font-semibold">Session Journal</h2>
              <div className="mt-3 space-y-3 max-h-96 overflow-auto">
                {(state.journal || []).slice().reverse().map((j) => (
                  <div key={j.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                    <div className="font-medium">{j.title}</div>
                    <pre className="text-xs whitespace-pre-wrap text-slate-300 mt-2">{formatJournalMarkdown(j.markdown)}</pre>
                  </div>
                ))}
                {(!state.journal || state.journal.length === 0) && <div className="text-sm text-slate-400">No journal entries yet.</div>}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-xl font-semibold">Latest Transcript (cleaned)</h2>
              {!!speakerIds.length && (
                <div className="mt-3 rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                  <div className="text-xs text-slate-400 mb-2">Speaker mapping</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {speakerIds.map((sid) => (
                      <div key={sid} className="flex items-center gap-2">
                        <div className="text-xs text-slate-300 w-10">{sid}</div>
                        <select
                          value={speakerMap[sid] || sid}
                          onChange={(e) => setSpeakerMap((prev) => ({ ...prev, [sid]: e.target.value }))}
                          className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                        >
                          <option value={sid}>{sid}</option>
                          {speakerOptions.map((opt) => <option key={`${sid}-${opt}`} value={opt}>{opt}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <pre className="mt-3 rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-sm whitespace-pre-wrap max-h-96 overflow-auto">
                {displayTranscript || 'No completed pipeline run yet.'}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* ── CAMPAIGN tab ────────────────────────────────────────────────── */}
      {dmTab === 'campaign' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* PC List (DM) */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xl font-semibold">Player Characters</h2>
              <button onClick={() => setShowAddPc(true)} className="rounded-lg border border-emerald-700 text-emerald-300 px-3 py-1 text-sm">Add PC</button>
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={ddbCharacterInput}
                onChange={(e) => setDdbCharacterInput(e.target.value)}
                placeholder="D&D Beyond character URL or ID"
                className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
              <button
                onClick={() => importDndbCharacter(ddbCharacterInput, setDdbSyncStatus).then(() => setDdbCharacterInput(''))}
                className="rounded-lg border border-sky-700 text-sky-300 px-3 py-2 text-sm"
              >Sync</button>
            </div>
            {ddbSyncStatus && (
              <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-amber-800/60 bg-amber-950/20 px-2 py-1 text-xs text-amber-300">
                <span>{ddbSyncStatus}</span>
                <button onClick={() => setDdbSyncStatus('')} className="rounded border border-amber-700 px-1">×</button>
              </div>
            )}
            <div className="mt-3 space-y-2">
              {(state.pcs || []).map((pc) => (
                <div key={pc.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">{pc.characterName || pc.name}</div>
                      <div className="text-slate-400">{pc.playerName ? `Player: ${pc.playerName} • ` : ''}{pc.ddbUsername ? `@${pc.ddbUsername} • ` : ''}{pc.race || 'Race?'} {pc.class || 'Class?'} • Lv {pc.level || 1}</div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => linkPcToDdb(pc, setDdbSyncStatus)} className="rounded-lg border border-sky-700 text-sky-300 px-2 py-1 text-xs">Link DDB</button>
                      <button onClick={() => syncPcFromDdb(pc, setDdbSyncStatus)} disabled={!pc.ddbCharacterId} className="rounded-lg border border-indigo-700 text-indigo-300 px-2 py-1 text-xs disabled:opacity-40">Sync</button>
                      <button onClick={() => openEditPc(pc)} className="rounded-lg border border-slate-600 px-2 py-1 text-xs">Edit</button>
                      <button onClick={() => deletePc(pc)} className="rounded-lg border border-rose-700 text-rose-300 px-2 py-1 text-xs">Delete</button>
                    </div>
                  </div>
                </div>
              ))}
              {(state.pcs || []).length === 0 && <div className="text-sm text-slate-400">No PCs yet.</div>}
            </div>
          </div>

          {/* DM Notes */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-semibold">DM Area · Private Notes</h2>
            <textarea
              value={dmNotesDraft}
              onChange={(e) => setDmNotesDraft(e.target.value)}
              className="mt-3 w-full min-h-40 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"
              placeholder="DM-only canon, secret motives, true identities..."
            />
            <button onClick={saveDmNotes} className="mt-2 w-full rounded-xl border border-slate-700 px-3 py-2">Save DM Notes</button>
          </div>

          {/* DM Sneak Peek Editor */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xl font-semibold">DM Sneak Peek · Editor</h2>
              <div className="text-xs text-slate-400">Add and manage prep notes</div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2">
              <input
                value={dmSneakPeekText}
                onChange={(e) => setDmSneakPeekText(e.target.value)}
                placeholder="Add out-of-game prep note..."
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
              <div className="flex gap-2">
                <input
                  value={dmSneakPeekDueTag}
                  onChange={(e) => setDmSneakPeekDueTag(e.target.value)}
                  placeholder="Due tag (optional)"
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                />
                <button
                  onClick={() => addDmSneakPeekItem(dmSneakPeekText, dmSneakPeekDueTag, setDmSneakPeekStatus).then(() => { setDmSneakPeekText(''); setDmSneakPeekDueTag('') })}
                  className="rounded-xl border border-amber-700 text-amber-300 px-4 py-2 text-sm"
                >Add</button>
              </div>
            </div>
            {dmSneakPeekStatus && <div className="mt-2 text-xs text-amber-300">{dmSneakPeekStatus}</div>}
            <div className="mt-3 space-y-2 max-h-72 overflow-auto">
              {(state.dmSneakPeek || []).slice().reverse().map((item) => (
                <div key={item.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={!!item.done} onChange={() => toggleDmSneakPeekItem(item, setDmSneakPeekStatus)} />
                    <div className={item.done ? 'line-through text-slate-500' : ''}>
                      {item.text} {item.dueTag ? <span className="text-xs text-slate-400">• {item.dueTag}</span> : null}
                    </div>
                  </div>
                  <button onClick={() => deleteDmSneakPeekItem(item, setDmSneakPeekStatus)} className="rounded-lg border border-rose-700 text-rose-300 px-2 py-1 text-xs">Delete</button>
                </div>
              ))}
              {(!state.dmSneakPeek || state.dmSneakPeek.length === 0) && <div className="text-sm text-slate-400">No sneak peek notes yet.</div>}
            </div>
          </div>
        </div>
      )}

      {/* ── TOOLS tab ───────────────────────────────────────────────────── */}
      {dmTab === 'tools' && (
        <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-xl font-semibold">Data Browser</h2>
          <p className="mt-1 text-sm text-slate-400">Pick source + campaign + datasets, then import to approval queue or direct canon.</p>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2">
            <select
              value={dataBrowserSource}
              onChange={(e) => setDataBrowserSource(e.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            >
              <option value="dnd-data">dnd-data (npm)</option>
            </select>
            <select
              value={dataBrowserCampaignId}
              onChange={(e) => setDataBrowserCampaignId(e.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            >
              <option value="">Select campaign…</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select
              value={dataBrowserBook}
              onChange={(e) => setDataBrowserBook(e.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            >
              <option>Curse of Strahd</option>
              <option>Princes of the Apocalypse</option>
              <option>Custom</option>
            </select>
            <select
              value={dataBrowserMode}
              onChange={(e) => setDataBrowserMode(e.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            >
              <option value="approval">Queue for approval</option>
              <option value="merge">Merge to canon</option>
            </select>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            {Object.keys(dataBrowserSets).map((k) => (
              <button
                key={k}
                onClick={() => toggleDataSet(k)}
                className={`rounded-full border px-3 py-1 ${dataBrowserSets[k] ? 'border-amber-500 text-amber-300' : 'border-slate-700 text-slate-300'}`}
              >{k}</button>
            ))}
          </div>
          <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
            Preview: source={dataBrowserSource} • campaign={dataBrowserCampaignId || 'none'} • book={dataBrowserBook} • mode={dataBrowserMode}
          </div>
          <div className="mt-2 text-xs text-amber-300">Status: {dataBrowserStatus}</div>
          <button
            onClick={() => runDataBrowserImport({
              source: dataBrowserSource,
              campaignId: dataBrowserCampaignId || activeCampaign?.id,
              book: dataBrowserBook,
              mode: dataBrowserMode,
              datasets: dataBrowserSets,
            }, setDataBrowserStatus)}
            className="mt-3 rounded-xl border border-amber-700 text-amber-300 px-4 py-2 text-sm"
          >Run Import</button>
        </div>
      )}
    </div>
  )
}
