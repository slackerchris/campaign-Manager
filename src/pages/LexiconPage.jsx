import { useState } from 'react'
import { useApp } from '../AppContext.jsx'
import { apiFetch } from '../lib/api.js'

export default function LexiconPage() {
  const { state, activeCampaign, openLexiconDetail, setShowAddLexicon, loadCampaignState } = useApp()

  const [lexiconSearch, setLexiconSearch] = useState('')
  const [lexiconKindFilter, setLexiconKindFilter] = useState('all')
  const [resetConfirm, setResetConfirm] = useState(false)
  const [resetStatus, setResetStatus] = useState('')

  const unifiedLexiconEntries = (state.lexiconEntities || []).map((e) => ({
    id: e.id || `lex-${e.canonicalTerm}`,
    term: e.canonicalTerm || '',
    kind: e.entityType || 'term',
    role: e.role || '',
    notes: e.notes || '',
    relation: e.relation || '',
    aliases: e.aliases || [],
    raw: e,
  })).sort((a, b) => String(a.term || '').localeCompare(String(b.term || '')))

  const lexiconKinds = Array.from(
    new Set(unifiedLexiconEntries.map((l) => String(l.kind || '').trim()).filter(Boolean))
  ).sort()

  const filteredLexicon = unifiedLexiconEntries.filter((l) => {
    const term = String(l.term || '').toLowerCase()
    const notes = String(l.notes || '').toLowerCase()
    const aliases = (l.aliases || []).join(' ').toLowerCase()
    const search = lexiconSearch.trim().toLowerCase()
    const kindOk = lexiconKindFilter === 'all' || String(l.kind || '') === lexiconKindFilter
    const textOk = !search || term.includes(search) || notes.includes(search) || aliases.includes(search)
    return kindOk && textOk
  })

  async function resetLexicon() {
    if (!activeCampaign) return
    setResetStatus('Resetting…')
    try {
      const r = await apiFetch(`/api/campaigns/${activeCampaign.id}/lexicon`, { method: 'DELETE' })
      const j = await r.json()
      if (!r.ok || !j.ok) { setResetStatus(`Failed: ${j.error || 'unknown error'}`); return }
      setResetStatus(`Cleared ${j.removed?.entities ?? 0} entries. Backup saved.`)
      setResetConfirm(false)
      await loadCampaignState(activeCampaign.id)
    } catch (e) {
      setResetStatus(`Error: ${e.message}`)
    }
  }

  return (
    <div className="space-y-6">
      {/* Search + filter header */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold">Lexicon</h2>
            <p className="text-sm text-slate-400">Glossary and cross-reference for world terms, NPCs, places, quests, and lore.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowAddLexicon(true)} className="rounded-xl border border-slate-700 px-3 py-1 text-sm">Add</button>
            {!resetConfirm
              ? <button onClick={() => { setResetConfirm(true); setResetStatus('') }} className="rounded-xl border border-rose-800 text-rose-400 px-3 py-1 text-sm">Reset</button>
              : <span className="flex items-center gap-2">
                  <span className="text-xs text-rose-400">Clear all {unifiedLexiconEntries.length} entries?</span>
                  <button onClick={resetLexicon} className="rounded-xl border border-rose-600 bg-rose-900/40 text-rose-300 px-3 py-1 text-sm font-medium">Yes, clear</button>
                  <button onClick={() => setResetConfirm(false)} className="rounded-xl border border-slate-700 px-3 py-1 text-sm">Cancel</button>
                </span>
            }
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input
            value={lexiconSearch}
            onChange={(e) => setLexiconSearch(e.target.value)}
            placeholder="Search terms or notes..."
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm md:col-span-2"
          />
          <select
            value={lexiconKindFilter}
            onChange={(e) => setLexiconKindFilter(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            <option value="all">All kinds</option>
            {lexiconKinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div className="text-xs text-slate-400">Showing {filteredLexicon.length} of {unifiedLexiconEntries.length}</div>
        {resetStatus && <div className="text-xs text-amber-300">{resetStatus}</div>}
      </div>

      {/* Entries */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <div className="space-y-2">
          {filteredLexicon.map((l) => (
            <button
              key={l.id}
              onClick={() => openLexiconDetail(l)}
              className="w-full text-left rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-sm hover:border-amber-700 transition-colors"
            >
              <div className="font-medium">{l.term} {l.kind ? `(${l.kind})` : ''}</div>
              {l.notes && <div className="text-xs text-slate-400 mt-0.5 truncate">{l.notes}</div>}
            </button>
          ))}
          {filteredLexicon.length === 0 && (
            <div className="text-sm text-slate-400">
              {unifiedLexiconEntries.length === 0 ? 'No lexicon entries yet.' : 'No entries match your filter.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
