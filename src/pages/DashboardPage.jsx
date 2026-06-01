import { useEffect, useRef, useState } from 'react'
import { useApp, BARD_PERSONAS, BARD_FAITHFULNESS } from '../AppContext.jsx'
import { useAuth } from '../AuthContext.jsx'
import { apiFetch } from '../lib/api.js'
import { gameSessionDisplayCount, recapBulletsFromJournal } from '../lib/utils.js'
import Stat from '../components/Stat.jsx'
import Panel from '../components/Panel.jsx'

const API_BASE = '/api'

function Section({ title, kicker, children, action }) {
  return (
    <section className="rounded-lg border border-slate-800/90 bg-slate-950/80 p-4 shadow-xl shadow-black/10">
      <div className="flex items-start justify-between gap-3">
        <div>
          {kicker && <div className="text-[11px] font-semibold uppercase text-amber-400/80">{kicker}</div>}
          <h2 className="text-base font-semibold text-slate-100">{title}</h2>
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export default function DashboardPage() {
  const {
    state, activeCampaign,
    saveJournalEdit, deleteJournalEntry,
    saveBardsTale, deleteSavedBardsTale,
    submitPlayerContribution, addPlayerQuoteDirect,
  } = useApp()
  const { user } = useAuth()
  const isDm = ['dm', 'admin'].includes(user?.role)

  const journalTextareaRef = useRef(null)

  const [journalPage, setJournalPage] = useState(0)
  const [journalEditDraft, setJournalEditDraft] = useState('')
  const [journalEditStatus, setJournalEditStatus] = useState('')

  // ── player notes state ────────────────────────────────────────────────────
  const sortedSessions = (state.gameSessions || []).slice().sort((a, b) => {
    const na = Number(String(a?.title || '').match(/\d+/)?.[0] || 0)
    const nb = Number(String(b?.title || '').match(/\d+/)?.[0] || 0)
    return na - nb
  })
  const [noteType, setNoteType] = useState('note')
  const [noteSession, setNoteSession] = useState('')
  const [noteText, setNoteText] = useState('')
  const [noteStatus, setNoteStatus] = useState('')
  const [quoteText, setQuoteText] = useState('')
  const [quoteSpeaker, setQuoteSpeaker] = useState('')
  const [quoteStatus, setQuoteStatus] = useState('')

  const [bardTale, setBardTale] = useState('')
  const [bardTitle, setBardTitle] = useState('')
  const [bardName, setBardName] = useState(BARD_PERSONAS.grandiose.bardName)
  const [bardPersonaId, setBardPersonaId] = useState('grandiose')
  const [bardFaithfulness, setBardFaithfulness] = useState('dramatic')
  const [bardStatus, setBardStatus] = useState('')

  const canonicalById = new Map((state.lexiconEntities || []).map((e) => [String(e?.id || ''), e]))
  const legacyById = new Map((state.lexicon || []).map((l) => [String(l?.id || ''), l]))
  const trackerRows = Array.isArray(state.trackerRows) ? state.trackerRows : []

  const npcTrackerItems = trackerRows
    .filter((r) => String(r?.trackerType || '') === 'npc')
    .map((r) => {
      const entity = canonicalById.get(String(r?.entityId || '')) || legacyById.get(String(r?.entityId || ''))
      return {
        id: r.id,
        term: String(entity?.canonicalTerm || entity?.term || 'Unknown NPC').trim(),
        subtitle: String(r?.snapshot?.subtitle || entity?.notes || '').trim(),
      }
    })

  const questTrackerItems = trackerRows
    .filter((r) => String(r?.trackerType || '') === 'quest')
    .map((r) => {
      const entity = canonicalById.get(String(r?.entityId || '')) || legacyById.get(String(r?.entityId || ''))
      const status = String(r?.snapshot?.status || 'unknown').trim()
      return `${String(entity?.canonicalTerm || entity?.term || 'Unknown Quest').trim()} - ${status}`
    })

  const placeTrackerItems = trackerRows
    .filter((r) => String(r?.trackerType || '') === 'place')
    .map((r) => {
      const entity = canonicalById.get(String(r?.entityId || '')) || legacyById.get(String(r?.entityId || ''))
      return String(entity?.canonicalTerm || entity?.term || 'Unknown Place').trim()
    })

  const recapBullets = recapBulletsFromJournal(state.storyJournal || [])
  const journalPages = (state.storyJournal || []).slice().reverse()
  const currentJournal = journalPages[journalPage] || null
  const pendingApprovals = (state.approvals || []).filter((a) => String(a?.status || 'pending') === 'pending')
  const openSneakPeek = (state.dmSneakPeek || []).filter((item) => !item.done)
  const latestSession = (state.gameSessions || []).slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0]
  const recentQuotes = (state.quotes || []).slice(-4).reverse().map((q) => `"${q.text || q}"`)

  useEffect(() => {
    const maxIdx = Math.max(0, (state.storyJournal || []).length - 1)
    if (journalPage > maxIdx) setJournalPage(0)
  }, [journalPage, state.storyJournal])

  useEffect(() => {
    const j = journalPages[journalPage]
    setJournalEditDraft(String(j?.markdown || ''))
    setJournalEditStatus('')
    setBardTale('')
    setBardTitle('')
    setBardName(BARD_PERSONAS[bardPersonaId]?.bardName || BARD_PERSONAS.grandiose.bardName)
    setBardStatus('')
  }, [bardPersonaId, journalPage, state.storyJournal])

  useEffect(() => {
    const el = journalTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [journalEditDraft, journalPage])

  useEffect(() => {
    setBardName(BARD_PERSONAS[bardPersonaId]?.bardName || BARD_PERSONAS.grandiose.bardName)
  }, [bardPersonaId])

  async function submitNote() {
    if (!noteText.trim()) return
    const session = sortedSessions.find((s) => s.id === noteSession)
    const ok = await submitPlayerContribution({
      playerName: user?.displayName || 'Player',
      type: noteType,
      text: noteText.trim(),
      gameSessionId: noteSession || undefined,
      gameSessionTitle: session?.title || 'Session Note',
    }, setNoteStatus)
    if (ok) setNoteText('')
  }

  async function submitQuote() {
    if (!quoteText.trim()) return
    const ok = await addPlayerQuoteDirect({
      text: quoteText.trim(),
      speaker: quoteSpeaker.trim(),
      playerName: user?.displayName || 'Player',
    }, setQuoteStatus)
    if (ok) { setQuoteText(''); setQuoteSpeaker('') }
  }

  async function generateBardsTale() {
    if (!activeCampaign || !currentJournal) return
    setBardStatus('The bard is warming up...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/bards-tale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: currentJournal.title,
        journal: journalEditDraft || currentJournal.markdown || '',
        personaId: bardPersonaId,
        faithfulness: bardFaithfulness,
      }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setBardStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setBardTale(String(j.tale || '').trim())
    setBardTitle(String(j.bardTitle || '').trim())
    setBardName(String(j.bardName || BARD_PERSONAS[bardPersonaId]?.bardName || '').trim())
    setBardPersonaId(String(j.personaId || bardPersonaId))
    setBardFaithfulness(String(j.faithfulness || bardFaithfulness))
    setBardStatus('Freshly sung.')
  }

  function loadSavedBardsTale(entry) {
    if (!entry) return
    setBardTale(String(entry.text || entry.tale || ''))
    setBardTitle(String(entry.bardTitle || ''))
    setBardName(String(entry.bardName || BARD_PERSONAS[entry.personaId || 'grandiose']?.bardName || ''))
    setBardPersonaId(String(entry.personaId || 'grandiose'))
    setBardFaithfulness(String(entry.faithfulness || 'dramatic'))
    setBardStatus(`Loaded: ${entry.bardTitle || entry.title || 'Saved tale'}`)
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sessions" value={gameSessionDisplayCount(state.gameSessions)} color="amber" />
        {isDm
          ? <Stat label="Approvals" value={pendingApprovals.length} color="blue" />
          : <Stat label="Quests" value={questTrackerItems.length} color="blue" />
        }
        {isDm
          ? <Stat label="Open Threads" value={questTrackerItems.length + openSneakPeek.length} color="purple" />
          : <Stat label="NPCs" value={npcTrackerItems.length} color="purple" />
        }
        <Stat label="Party" value={(state.pcs || []).length} color="emerald" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Section title="Table Brief" kicker="Tonight">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_260px]">
              <div className="space-y-2 text-sm text-slate-300">
                {recapBullets.map((b, i) => <div key={i} className="rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2">{b}</div>)}
                {recapBullets.length === 0 && <div className="text-slate-400">No recap yet. Process a session to seed the desk.</div>}
              </div>
              <div className="rounded-md border border-slate-800 bg-slate-900/70 p-3 text-sm">
                <div className="text-[11px] uppercase text-slate-500">Latest Session</div>
                <div className="mt-1 font-medium text-slate-100">{latestSession?.label || latestSession?.title || 'No sessions yet'}</div>
                <div className="mt-2 text-slate-400">{currentJournal?.title || 'No journal selected'}</div>
              </div>
            </div>
          </Section>

          <Section title="Party">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {(state.pcs || []).map((pc) => {
                const ddbUrl = pc.sourceUrl || (pc.ddbCharacterId ? `https://www.dndbeyond.com/characters/${pc.ddbCharacterId}` : '')
                const CardTag = ddbUrl ? 'a' : 'div'
                const cardProps = ddbUrl
                  ? { href: ddbUrl, target: '_blank', rel: 'noreferrer noopener', title: 'Open D&D Beyond character page' }
                  : {}
                return (
                  <CardTag key={pc.id} {...cardProps} className="flex min-h-24 gap-3 rounded-lg border border-slate-800 bg-slate-900/70 p-3 hover:border-amber-700">
                    <img src={pc.avatarUrl || '/pc-placeholder.svg'} alt={pc.characterName || 'pc'} className="h-16 w-16 rounded-md border border-slate-700 object-cover" />
                    <div className="min-w-0 text-sm">
                      <div className="truncate font-medium text-slate-100">{pc.characterName || pc.name || 'Unnamed PC'}</div>
                      <div className="mt-1 text-slate-400">{pc.playerName || 'Unassigned player'}</div>
                      <div className="mt-1 text-xs text-slate-500">{pc.race || 'Race?'} {pc.class || 'Class?'} / Lv {pc.level || 1}</div>
                    </div>
                  </CardTag>
                )
              })}
              {(state.pcs || []).length === 0 && <div className="text-sm text-slate-400">No PCs yet.</div>}
            </div>
          </Section>

          <Section
            title="Journal"
            action={(
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <button
                  onClick={() => setJournalPage((p) => Math.min(journalPages.length - 1, p + 1))}
                  disabled={journalPage >= journalPages.length - 1}
                  className="rounded border border-slate-700 px-2 py-1 disabled:opacity-40"
                >
                  Older
                </button>
                <span>{journalPages.length ? `${journalPage + 1}/${journalPages.length}` : '0/0'}</span>
                <button
                  onClick={() => setJournalPage((p) => Math.max(0, p - 1))}
                  disabled={journalPage <= 0}
                  className="rounded border border-slate-700 px-2 py-1 disabled:opacity-40"
                >
                  Newer
                </button>
              </div>
            )}
          >
            {currentJournal ? (
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                <div className="font-medium text-slate-100">{currentJournal.title}</div>
                {isDm ? (
                  <>
                    <textarea
                      ref={journalTextareaRef}
                      value={journalEditDraft}
                      onChange={(e) => {
                        setJournalEditDraft(e.target.value)
                        e.target.style.height = 'auto'
                        e.target.style.height = `${e.target.scrollHeight}px`
                      }}
                      rows={1}
                      className="mt-3 w-full resize-none overflow-hidden rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                    />
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => saveJournalEdit(currentJournal.id, journalEditDraft, setJournalEditStatus)}
                        className="rounded-md border border-emerald-700 px-3 py-1.5 text-sm text-emerald-300"
                      >Save</button>
                      <button
                        onClick={() => deleteJournalEntry(currentJournal.id, setJournalEditStatus, () => setJournalPage(0))}
                        className="rounded-md border border-rose-800 px-3 py-1.5 text-sm text-rose-300"
                      >Delete</button>
                      {journalEditStatus && <span className="text-xs text-amber-300">{journalEditStatus}</span>}
                    </div>
                  </>
                ) : (
                  <p className="mt-3 text-sm text-slate-300 whitespace-pre-wrap">{currentJournal.markdown}</p>
                )}
              </div>
            ) : (
              <div className="text-sm text-slate-400">No journal entries yet.</div>
            )}
          </Section>

          {!isDm && (
            <Section title="Session Notes" kicker="Your Contribution">
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <select
                    value={noteType}
                    onChange={(e) => setNoteType(e.target.value)}
                    className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                  >
                    <option value="note">Session Note</option>
                    <option value="correction">Correction</option>
                    <option value="npc">NPC Update</option>
                    <option value="quest">Quest Update</option>
                  </select>
                  <select
                    value={noteSession}
                    onChange={(e) => setNoteSession(e.target.value)}
                    className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                  >
                    <option value="">Latest session</option>
                    {sortedSessions.map((s) => (
                      <option key={s.id} value={s.id}>{s.label ? `${s.title} — ${s.label}` : s.title}</option>
                    ))}
                  </select>
                </div>
                <textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="What happened? Any corrections, discoveries, or NPC details you noticed..."
                  className="w-full min-h-24 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm resize-none"
                />
                <div className="flex items-center justify-between gap-3">
                  {noteStatus && <span className="text-xs text-amber-300">{noteStatus}</span>}
                  <button
                    onClick={submitNote}
                    disabled={!noteText.trim()}
                    className="ml-auto rounded-md border border-emerald-700 px-4 py-2 text-sm text-emerald-300 disabled:opacity-40"
                  >Submit Note</button>
                </div>

                <div className="border-t border-slate-800 pt-3">
                  <div className="text-[11px] font-semibold uppercase text-amber-400/80 mb-2">Quick Quote</div>
                  <div className="flex gap-2">
                    <input
                      value={quoteSpeaker}
                      onChange={(e) => setQuoteSpeaker(e.target.value)}
                      placeholder="Who said it?"
                      className="w-36 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                    />
                    <input
                      value={quoteText}
                      onChange={(e) => setQuoteText(e.target.value)}
                      placeholder={`"Something memorable..."`}
                      className="flex-1 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                    />
                    <button
                      onClick={submitQuote}
                      disabled={!quoteText.trim()}
                      className="rounded-md border border-amber-700 px-3 py-2 text-sm text-amber-300 disabled:opacity-40"
                    >Add</button>
                  </div>
                  {quoteStatus && <div className="mt-1 text-xs text-amber-300">{quoteStatus}</div>}
                </div>
              </div>
            </Section>
          )}

          <Section
            title="Bard's Tale"
            kicker="Optional Color"
            action={isDm ? (
              <div className="flex gap-2">
                <button
                  onClick={generateBardsTale}
                  disabled={!currentJournal}
                  className="rounded-md border border-amber-700 px-3 py-1.5 text-sm text-amber-300 disabled:opacity-40"
                >
                  Generate
                </button>
                <button
                  onClick={() => saveBardsTale(currentJournal, bardTale, bardTitle, bardName, bardPersonaId, bardFaithfulness, journalEditDraft, setBardStatus)}
                  disabled={!currentJournal || !String(bardTale || '').trim()}
                  className="rounded-md border border-emerald-700 px-3 py-1.5 text-sm text-emerald-300 disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            ) : null}
          >
            {isDm && (
              <>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <select value={bardPersonaId} onChange={(e) => setBardPersonaId(e.target.value)} className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm">
                    {Object.values(BARD_PERSONAS).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                  </select>
                  <select value={bardFaithfulness} onChange={(e) => setBardFaithfulness(e.target.value)} className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm">
                    {Object.entries(BARD_FAITHFULNESS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                  <input value={bardName} onChange={(e) => setBardName(e.target.value)} placeholder="Bard name" className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm" />
                </div>
                <input value={bardTitle} onChange={(e) => setBardTitle(e.target.value)} placeholder="Title this tale..." className="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-amber-200" />
                {bardStatus && <div className="mt-2 text-xs text-amber-300">{bardStatus}</div>}
              </>
            )}
            <pre className="mt-3 max-h-96 overflow-auto rounded-md border border-slate-800 bg-slate-900/70 p-3 text-sm whitespace-pre-wrap text-slate-200">
              {bardTale || 'No tale yet. Select a journal entry and generate a retelling.'}
            </pre>
            <div className="mt-3 max-h-56 space-y-2 overflow-auto rounded-md border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-slate-200">Saved Tales</span>
                <span className="text-xs text-slate-500">{(state.bardsTales || []).length}</span>
              </div>
              {(state.bardsTales || []).slice().reverse().map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/70 p-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{t.bardTitle || t.title || 'Untitled Tale'}</div>
                    <div className="truncate text-xs text-slate-500">{t.bardName || BARD_PERSONAS[t.personaId || 'grandiose']?.bardName || 'Bard'}</div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => loadSavedBardsTale(t)} className="rounded border border-sky-700 px-2 py-1 text-xs text-sky-300">Load</button>
                    <button onClick={() => deleteSavedBardsTale(t, setBardStatus)} className="rounded border border-rose-800 px-2 py-1 text-xs text-rose-300">Delete</button>
                  </div>
                </div>
              ))}
              {(!state.bardsTales || state.bardsTales.length === 0) && <div className="text-sm text-slate-400">No saved tales yet.</div>}
            </div>
          </Section>
        </div>

        <aside className="space-y-4">
          {isDm && (
            <Section title="Attention Queue" kicker="DM">
              <div className="space-y-2">
                <div className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                  <div className="text-sm font-medium text-slate-100">Approvals</div>
                  <div className="mt-1 text-sm text-slate-400">{pendingApprovals.length ? `${pendingApprovals.length} pending import decisions` : 'No pending approvals'}</div>
                </div>
                {openSneakPeek.slice(0, 5).map((item) => (
                  <div key={item.id} className="rounded-md border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-300">
                    {item.text}
                    {item.dueTag ? <span className="ml-2 text-xs text-slate-500">{item.dueTag}</span> : null}
                  </div>
                ))}
                {openSneakPeek.length === 0 && <div className="text-sm text-slate-500">No open sneak-peek notes.</div>}
              </div>
            </Section>
          )}
          <Panel title="Quest Threads" items={questTrackerItems.slice(0, 12)} />
          <Panel title="NPC Watchlist" items={npcTrackerItems.slice(0, 12).map((n) => n.subtitle ? `${n.term} - ${n.subtitle}` : n.term)} />
          <Panel title="Places" items={placeTrackerItems.slice(0, 12)} />
          <Panel title="Quote Vault" items={recentQuotes} />
        </aside>
      </div>
    </div>
  )
}
