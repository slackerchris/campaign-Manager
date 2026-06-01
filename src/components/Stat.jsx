const ACCENT = {
  amber: 'bg-amber-500',
  blue: 'bg-blue-500',
  purple: 'bg-purple-500',
  emerald: 'bg-emerald-500',
}

export default function Stat({ label, value, color }) {
  const accent = ACCENT[color] || 'bg-slate-700'
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/70 overflow-hidden">
      <div className={`h-1 ${accent}`} />
      <div className="p-3">
        <div className="text-[11px] text-slate-500 uppercase">{label}</div>
        <div className="text-2xl font-semibold mt-1 text-slate-100">{value}</div>
      </div>
    </div>
  )
}
