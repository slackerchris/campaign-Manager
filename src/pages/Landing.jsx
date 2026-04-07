import { useState } from 'react'
import { useApp } from '../AppContext.jsx'

export default function Landing() {
  const { campaigns, createCampaign, selectCampaign, isMobileView } = useApp()
  const [newCampaign, setNewCampaign] = useState('')

  return (
    <div
      className={`min-h-screen text-slate-100 ${isMobileView ? 'p-3' : 'p-6'}`}
      style={{
        backgroundImage: 'url(/campaign-manager-bg.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
        backgroundAttachment: 'scroll',
      }}
    >
      {/* Dark overlay so text stays readable */}
      <div className="absolute inset-0 bg-slate-950/70 pointer-events-none" aria-hidden="true" />

      <div className={`relative z-10 ${isMobileView ? 'max-w-none' : 'max-w-4xl'} mx-auto space-y-6`}>
        {/* Title card */}
        <div className="rounded-3xl border border-amber-900/60 bg-slate-950/80 backdrop-blur-sm p-6">
          <h1 className="text-4xl font-bold tracking-tight text-amber-300 drop-shadow-lg">Campaign Manager</h1>
          <p className="text-slate-400 mt-1">Create or choose a campaign to open its isolated workspace.</p>
        </div>

        <div className="rounded-3xl border border-slate-700/60 bg-slate-950/80 backdrop-blur-sm p-6 space-y-3">
          <h2 className="text-xl font-semibold">Create Campaign</h2>
          <div className="flex gap-2">
            <input
              value={newCampaign}
              onChange={(e) => setNewCampaign(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { createCampaign(newCampaign); setNewCampaign('') } }}
              placeholder="Campaign name"
              className="flex-1 rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2"
            />
            <button
              onClick={() => { createCampaign(newCampaign); setNewCampaign('') }}
              className="rounded-xl bg-amber-500 text-slate-950 px-4 py-2 font-semibold"
            >
              Create
            </button>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-700/60 bg-slate-950/80 backdrop-blur-sm p-6 space-y-2">
          <h2 className="text-xl font-semibold">Campaigns</h2>
          {campaigns.length === 0 && <div className="text-sm text-slate-400">No campaigns yet.</div>}
          {campaigns.map((c) => (
            <button
              key={c.id}
              onClick={() => selectCampaign(c)}
              className="block w-full text-left rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 hover:border-amber-600 hover:bg-amber-950/30 transition-colors"
            >
              <div className="font-medium">{c.name}</div>
              <div className="text-xs text-slate-400">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : c.id}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
