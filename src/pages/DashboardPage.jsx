import { useEffect, useRef, useState } from 'react'
import { useApp, BARD_PERSONAS, BARD_FAITHFULNESS } from '../AppContext.jsx'
import { apiFetch } from '../lib/api.js'
import { formatJournalMarkdown, gameSessionDisplayCount, recapBulletsFromJournal } from '../lib/utils.js'
import Stat from '../components/Stat.jsx'
import Panel from '../components/Panel.jsx'

const API_BASE = '/api'

export default function DashboardPage() {
  const {
    state, activeCampaign, isMobileView,
    setError, saveJournalEdit, deleteJournalEntry,
    saveBardsTale, deleteSavedBardsTale,
  } = useApp()

  const journalTextareaRef = useRef(null)

  // ── journal state ─────────────────────────────────────────────────────────
  const [journalPage, setJournalPage] = useState(0)
  const [journalEditDraft, setJournalEditDraft] = useState('')
  const [journalEditStatus, setJournalEditStatus] = useState('')

  // ── bard's tale state ─────────────────────────────────────────────────────
  const [bardTale, setBardTale] = useState('')
  const [bardTitle, setBardTitle] = useState('')
  const [bardName, setBardName] = useState(BARD_PERSONAS.grandiose.bardName)
  const [bardPersonaId, setBardPersonaId] = useState('grandiose')
  const [bardFaithfulness, setBardFaithfulness] = useState('dramatic')
  const [bardStatus, setBardStatus] = useState('')

  // ── derived ───────────────────────────────────────────────────────────────
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
      return `${String(entity?.canonicalTerm || entity?.term || 'Unknown Quest').trim()} — ${status}`
    })

  const recapBullets = recapBulletsFromJournal(state.storyJournal || [])
  const journalPages = (state.storyJournal || []).slice().reverse()
  const currentJournal = journalPages[journalPage] || null

  // ── effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const maxIdx = Math.max(0, (state.storyJournal || []).length - 1)
    if (journalPage > maxIdx) setJournalPage(0)
  }, [state.storyJournal?.length])

  useEffect(() => {
    const j = journalPages[journalPage]
    setJournalEditDraft(String(j?.markdown || ''))
    setJournalEditStatus('')
    setBardTale('')
    setBardTitle('')
    setBardName(BARD_PERSONAS[bardPersonaId]?.bardName || BARD_PERSONAS.grandiose.bardName)
    setBardStatus('')
  }, [journalPage, state.storyJournal])

  useEffect(() => {
    const el = journalTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [journalEditDraft, journalPage])

  useEffect(() => {
    setBardName(BARD_PERSONAS[bardPersonaId]?.bardName || BARD_PERSONAS.grandiose.bardName)
  }, [bardPersonaId])

  // ── bard's tale functions ─────────────────────────────────────────────────
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
    <div className="space-y-6">
      {/* Last Session Recap */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5 space-y-3">
        <h2 className="text-xl font-semibold">Last Session Recap</h2>
        <div className="text-sm text-slate-300 space-y-1">
          {recapBullets.map((b, i) => <div key={i}>• {b}</div>)}
          {recapBullets.length === 0 && <div className="text-slate-400">No recap yet — run one session through DM processing.</div>}
        </div>
      </div>

      {/* Character Cards */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">Character Cards</h2>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {state.pcs.map((pc) => {
            const ddbUrl = pc.sourceUrl || (pc.ddbCharacterId ? `https://www.dndbeyond.com/characters/${pc.ddbCharacterId}` : '')
            const CardTag = ddbUrl ? 'a' : 'div'
            const cardProps = ddbUrl
              ? { href: ddbUrl, target: '_blank', rel: 'noreferrer noopener', title: 'Open D&D Beyond character page' }
              : {}
            return (
              <CardTag key={pc.id} {...cardProps} className="rounded-xl border border-slate-700 bg-slate-950/60 p-3 flex gap-3 hover:border-amber-700 transition-colors">
                <img src={pc.avatarUrl || '/pc-placeholder.svg'} alt={pc.characterName || 'pc'} className="h-16 w-16 rounded-lg object-cover border border-slate-700" />
                <div className="text-sm">
                  <div className="font-medium">{pc.characterName || pc.name}</div>
                  <div className="text-slate-400">{pc.playerName || 'Player?'}{pc.ddbUsername ? ` • @${pc.ddbUsername}` : ''} • {pc.race || 'Race?'} {pc.class || 'Class?'} • Lv {pc.level || 1}</div>
                  {pc.lastSyncedAt ? <div className="text-xs text-slate-500">Synced: {new Date(pc.lastSyncedAt).toLocaleString()}</div> : null}
                </div>
              </CardTag>
            )
          })}
          {state.pcs.length === 0 && <div className="text-sm text-slate-400">No PCs yet.</div>}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Game Sessions" value={gameSessionDisplayCount(state.gameSessions)} color="amber" />
        <Stat label="NPCs" value={npcTrackerItems.length} color="blue" />
        <Stat label="Quests" value={questTrackerItems.length} color="purple" />
        <Stat label="Quotes" value={state.quotes.length} color="emerald" />
      </div>

      {/* Trackers */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-xl font-semibold">NPC Tracker</h2>
          <div className="mt-3 space-y-2">
            {npcTrackerItems.map((n) => (
              <div key={n.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm">
                {n.subtitle ? `${n.term} — ${n.subtitle}` : n.term}
              </div>
            ))}
            {npcTrackerItems.length === 0 && <div className="text-sm text-slate-400">No NPC tracker rows yet.</div>}
          </div>
        </div>
        <Panel title="Quest Tracker" items={questTrackerItems} />
        <Panel title="Quote Vault" items={state.quotes.map((q) => `"${q.text || q}"`)} />
      </div>

      {/* Journal */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">Journal</h2>
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => setJournalPage((p) => Math.min(journalPages.length - 1, p + 1))}
              disabled={journalPage >= journalPages.length - 1}
              className="rounded-lg border border-slate-700 px-2 py-1 disabled:opacity-40"
            >← Older</button>
            <div>{journalPages.length ? `Page ${journalPage + 1} / ${journalPages.length}` : 'No entries'}</div>
            <button
              onClick={() => setJournalPage((p) => Math.max(0, p - 1))}
              disabled={journalPage <= 0}
              className="rounded-lg border border-slate-700 px-2 py-1 disabled:opacity-40"
            >Newer →</button>
          </div>
        </div>

        {currentJournal ? (
          <div className="mt-3 rounded-xl border border-slate-700 bg-slate-950/60 p-4">
            <div className="font-medium">{currentJournal.title}</div>
            <textarea
              ref={journalTextareaRef}
              value={journalEditDraft}
              onChange={(e) => {
                setJournalEditDraft(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = `${e.target.scrollHeight}px`
              }}
              rows={1}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm whitespace-pre-wrap overflow-hidden resize-none"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => saveJournalEdit(currentJournal.id, journalEditDraft, setJournalEditStatus)}
                className="rounded-lg border border-emerald-700 text-emerald-300 px-3 py-1 text-sm"
              >
                Save Journal Edit
              </button>
              <button
                onClick={() => deleteJournalEntry(currentJournal.id, setJournalEditStatus, () => setJournalPage(0))}
                className="rounded-lg border border-rose-700 text-rose-300 px-3 py-1 text-sm"
              >
                Delete Entry
              </button>
              {journalEditStatus && <span className="text-xs text-amber-300">{journalEditStatus}</span>}
            </div>
          </div>
        ) : (
          <div className="mt-3 text-sm text-slate-400">No journal entries yet.</div>
        )}
      </div>

      {/* Bard's Tale */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">Bard's Tale</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={generateBardsTale}
              disabled={!currentJournal}
              className="rounded-lg border border-amber-700 text-amber-300 px-3 py-1 text-sm disabled:opacity-40"
            >
              Spin the Tale
            </button>
            <button
              onClick={() => saveBardsTale(currentJournal, bardTale, bardTitle, bardName, bardPersonaId, bardFaithfulness, journalEditDraft, setBardStatus)}
              disabled={!currentJournal || !String(bardTale || '').trim()}
              className="rounded-lg border border-emerald-700 text-emerald-300 px-3 py-1 text-sm disabled:opacity-40"
            >
              Save Tale
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-400">A colorful retelling of the current journal entry, in proper tavern style.</p>
        <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
          <select
            value={bardPersonaId}
            onChange={(e) => setBardPersonaId(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            {Object.values(BARD_PERSONAS).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
          <select
            value={bardFaithfulness}
            onChange={(e) => setBardFaithfulness(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            {Object.entries(BARD_FAITHFULNESS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <input
            value={bardName}
            onChange={(e) => setBardName(e.target.value)}
            placeholder="Bard name"
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
        </div>
        <input
          value={bardTitle}
          onChange={(e) => setBardTitle(e.target.value)}
          placeholder="Give this tale a title..."
          className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-amber-200"
        />
        {bardStatus && <div className="mt-2 text-xs text-amber-300">{bardStatus}</div>}
        <pre className="mt-3 rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-sm whitespace-pre-wrap">
          {bardTale || 'No tale yet. Select a journal entry and click "Spin the Tale".'}
        </pre>

        {/* Bard's Tale Library */}
        <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold">Bard's Tale Library</h3>
            <div className="text-xs text-slate-400">Saved: {(state.bardsTales || []).length}</div>
          </div>
          <div className="mt-2 space-y-2 max-h-56 overflow-auto">
            {(state.bardsTales || []).slice().reverse().map((t) => (
              <div key={t.id} className="rounded-lg border border-slate-700 bg-slate-950/60 p-2 text-sm flex items-center justify-between gap-2">
                <div>
                  <div className="font-medium">{t.bardTitle || t.title || 'Untitled Tale'}</div>
                  <div className="text-xs text-slate-500">{t.journalEntryTitle || t.title || 'Session'} • {t.bardName || BARD_PERSONAS[t.personaId || 'grandiose']?.bardName || 'Bard'} • {t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</div>
                  <div className="text-xs text-slate-400">{BARD_FAITHFULNESS[t.faithfulness] || t.faithfulness || 'Dramatic retelling'} • {t.promptVersion || 'bard-v1'} {t.isStale ? '• Source changed' : ''}</div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => loadSavedBardsTale(t)} className="rounded border border-sky-700 text-sky-300 px-2 py-1 text-xs">Load</button>
                  <button onClick={() => deleteSavedBardsTale(t, setBardStatus)} className="rounded border border-rose-700 text-rose-300 px-2 py-1 text-xs">Delete</button>
                </div>
              </div>
            ))}
            {(!state.bardsTales || state.bardsTales.length === 0) && <div className="text-sm text-slate-400">No saved tales yet.</div>}
          </div>
        </div>
      </div>

      {/* DM Sneak Peek (read-only view for dashboard) */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">DM Sneak Peek</h2>
          <div className="text-xs text-slate-400">Output view from DM panel</div>
        </div>
        <div className="mt-3 space-y-2">
          {(state.dmSneakPeek || []).slice().reverse().map((item) => (
            <div key={item.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm flex items-center gap-2">
              <input type="checkbox" checked={!!item.done} readOnly />
              <div className={item.done ? 'line-through text-slate-500' : ''}>
                {item.text} {item.dueTag ? <span className="text-xs text-slate-400">• {item.dueTag}</span> : null}
              </div>
            </div>
          ))}
          {(!state.dmSneakPeek || state.dmSneakPeek.length === 0) && (
            <div className="text-sm text-slate-400">No sneak peek notes yet.</div>
          )}
        </div>
      </div>
    </div>
  )
}
