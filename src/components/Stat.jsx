const ACCENT = {
  amber: 'bg-amber-500',
  blue: 'bg-blue-500',
  purple: 'bg-purple-500',
  emerald: 'bg-emerald-500',
}

export default function Stat({ label, value, color }) {
  const accent = ACCENT[color] || 'bg-slate-700'
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden">
      <div className={`h-1 ${accent}`} />
      <div className="p-4">
        <div className="text-xs text-slate-400 uppercase tracking-wide">{label}</div>
        <div className="text-2xl font-bold mt-1">{value}</div>
      </div>
    </div>
  )
}
