import { useApp } from '../../AppContext.jsx'

export default function AddPlaceModal() {
  const { showAddPlace, setShowAddPlace, newPlace, setNewPlace, addPlace } = useApp()
  if (!showAddPlace) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-3">
        <h3 className="text-xl font-semibold">Add Place</h3>
        <input value={newPlace.name} onChange={(e) => setNewPlace({ ...newPlace, name: e.target.value })} placeholder="Place name" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newPlace.type} onChange={(e) => setNewPlace({ ...newPlace, type: e.target.value })} placeholder="Type (town/dungeon/landmark)" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newPlace.tags} onChange={(e) => setNewPlace({ ...newPlace, tags: e.target.value })} placeholder="Tags (comma-separated)" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <input value={newPlace.notes} onChange={(e) => setNewPlace({ ...newPlace, notes: e.target.value })} placeholder="Notes" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
        <div className="flex gap-2 justify-end">
          <button onClick={() => setShowAddPlace(false)} className="rounded-xl border border-slate-700 px-4 py-2">Cancel</button>
          <button onClick={addPlace} className="rounded-xl border border-emerald-600 text-emerald-300 px-4 py-2">Add</button>
        </div>
      </div>
    </div>
  )
}
