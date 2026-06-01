export default function Panel({ title, items }) {
  return (
    <div className="rounded-lg border border-slate-800/80 bg-slate-950/70 p-4">
      <h2 className="text-sm font-semibold uppercase text-slate-300">{title}</h2>
      <div className="mt-3 space-y-2 max-h-72 overflow-auto">
        {items.map((it, i) => (
          <div key={`${i}-${String(it).slice(0, 40)}`} className="rounded-md border border-slate-800 bg-slate-900/70 p-2 text-sm text-slate-200">{it}</div>
        ))}
        {items.length === 0 && <div className="text-sm text-slate-400">No entries yet.</div>}
      </div>
    </div>
  )
}
