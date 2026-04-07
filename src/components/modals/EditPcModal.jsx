import { useApp } from '../../AppContext.jsx'

export default function EditPcModal() {
  const { editingPc, setEditingPc, editPc, setEditPc, saveEditPc } = useApp()
  if (!editingPc) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-3">
        <h3 className="text-xl font-semibold">Edit Player Character</h3>
        <input value={editPc.playerName} onChange={(e) => setEditPc({ ...editPc, playerName: e.target.value })} placeholder="Player name" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={editPc.ddbUsername} onChange={(e) => setEditPc({ ...editPc, ddbUsername: e.target.value })} placeholder="D&D Beyond username" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={editPc.characterName} onChange={(e) => setEditPc({ ...editPc, characterName: e.target.value })} placeholder="Character name" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={editPc.class} onChange={(e) => setEditPc({ ...editPc, class: e.target.value })} placeholder="Class" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={editPc.race} onChange={(e) => setEditPc({ ...editPc, race: e.target.value })} placeholder="Race" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input type="number" value={editPc.level} onChange={(e) => setEditPc({ ...editPc, level: Number(e.target.value || 1) })} placeholder="Level" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <textarea value={editPc.notes} onChange={(e) => setEditPc({ ...editPc, notes: e.target.value })} placeholder="Notes" className="w-full min-h-24 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <div className="flex gap-2 justify-end">
          <button onClick={() => setEditingPc(null)} className="rounded-xl border border-slate-700 px-4 py-2">Cancel</button>
          <button onClick={saveEditPc} className="rounded-xl border border-amber-500 text-amber-300 px-4 py-2">Save</button>
        </div>
      </div>
    </div>
  )
}
