import { useApp } from '../../AppContext.jsx'

export default function AddLexiconModal() {
  const { showAddLexicon, setShowAddLexicon, newLex, setNewLex, addLexicon, trackerTypeForKind } = useApp()
  if (!showAddLexicon) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-3">
        <h3 className="text-xl font-semibold">Add Canon Term</h3>
        <input value={newLex.term} onChange={(e) => setNewLex({ ...newLex, term: e.target.value })} placeholder="Canon term" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newLex.kind} onChange={(e) => setNewLex({ ...newLex, kind: e.target.value })} placeholder="Kind (npc/place/item/etc)" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newLex.role} onChange={(e) => setNewLex({ ...newLex, role: e.target.value })} placeholder="Role" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newLex.relation} onChange={(e) => setNewLex({ ...newLex, relation: e.target.value })} placeholder="Relation (optional)" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newLex.aliases} onChange={(e) => setNewLex({ ...newLex, aliases: e.target.value })} placeholder="Aliases (comma-separated)" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newLex.notes} onChange={(e) => setNewLex({ ...newLex, notes: e.target.value })} placeholder="Notes" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        {trackerTypeForKind(newLex.kind) && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={!!newLex.inTracker} onChange={(e) => setNewLex({ ...newLex, inTracker: !!e.target.checked })} />
            Show in {trackerTypeForKind(newLex.kind)} tracker
          </label>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={() => setShowAddLexicon(false)} className="rounded-xl border border-slate-700 px-4 py-2">Cancel</button>
          <button onClick={addLexicon} className="rounded-xl border border-emerald-600 text-emerald-300 px-4 py-2">Add</button>
        </div>
      </div>
    </div>
  )
}
