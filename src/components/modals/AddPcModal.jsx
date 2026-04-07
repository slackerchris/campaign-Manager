import { useApp } from '../../AppContext.jsx'

export default function AddPcModal() {
  const { showAddPc, setShowAddPc, newPc, setNewPc, addPc } = useApp()
  if (!showAddPc) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-3">
        <h3 className="text-xl font-semibold">Add Player Character</h3>
        <input value={newPc.playerName} onChange={(e) => setNewPc({ ...newPc, playerName: e.target.value })} placeholder="Player name" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newPc.ddbUsername} onChange={(e) => setNewPc({ ...newPc, ddbUsername: e.target.value })} placeholder="D&D Beyond username" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newPc.characterName} onChange={(e) => setNewPc({ ...newPc, characterName: e.target.value })} placeholder="Character name" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newPc.class} onChange={(e) => setNewPc({ ...newPc, class: e.target.value })} placeholder="Class" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newPc.race} onChange={(e) => setNewPc({ ...newPc, race: e.target.value })} placeholder="Race" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input type="number" value={newPc.level} onChange={(e) => setNewPc({ ...newPc, level: Number(e.target.value || 1) })} placeholder="Level" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <textarea value={newPc.notes} onChange={(e) => setNewPc({ ...newPc, notes: e.target.value })} placeholder="Notes" className="w-full min-h-24 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <div className="flex gap-2 justify-end">
          <button onClick={() => setShowAddPc(false)} className="rounded-xl border border-slate-700 px-4 py-2">Cancel</button>
          <button onClick={addPc} className="rounded-xl border border-emerald-600 text-emerald-300 px-4 py-2">Add</button>
        </div>
      </div>
    </div>
  )
}
