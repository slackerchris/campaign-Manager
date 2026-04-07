export default function Panel({ title, items }) {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="mt-3 space-y-2 max-h-72 overflow-auto">
        {items.map((it, i) => (
          <div key={`${i}-${String(it).slice(0, 40)}`} className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 text-sm">{it}</div>
        ))}
        {items.length === 0 && <div className="text-sm text-slate-400">No entries yet.</div>}
      </div>
    </div>
  )
}
