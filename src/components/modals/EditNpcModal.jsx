import { useApp } from '../../AppContext.jsx'

export default function EditNpcModal() {
  const { editingNpc, setEditingNpc, editNpc, setEditNpc, saveEditNpc } = useApp()
  if (!editingNpc) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-3">
        <h3 className="text-xl font-semibold">Edit NPC</h3>
        <input value={editNpc.name} onChange={(e) => setEditNpc({ ...editNpc, name: e.target.value })} placeholder="Name" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={editNpc.role} onChange={(e) => setEditNpc({ ...editNpc, role: e.target.value })} placeholder="Role" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={editNpc.relation} onChange={(e) => setEditNpc({ ...editNpc, relation: e.target.value })} placeholder="Relation" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <textarea value={editNpc.update} onChange={(e) => setEditNpc({ ...editNpc, update: e.target.value })} placeholder="Update/notes" className="w-full min-h-24 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <div className="flex gap-2 justify-end">
          <button onClick={() => setEditingNpc(null)} className="rounded-xl border border-slate-700 px-4 py-2">Cancel</button>
          <button onClick={saveEditNpc} className="rounded-xl border border-amber-500 text-amber-300 px-4 py-2">Save</button>
        </div>
      </div>
    </div>
  )
}
