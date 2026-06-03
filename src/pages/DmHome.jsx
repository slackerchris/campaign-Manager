import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useApp } from '../AppContext.jsx'
import { useAuth } from '../AuthContext.jsx'
import { apiFetch } from '../lib/api.js'

export default function DmHome() {
  const { campaigns, createCampaign, loadCampaigns, selectCampaign } = useApp()
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()

  const [newCampaignName, setNewCampaignName] = useState('')
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [summaries, setSummaries] = useState({})

  useEffect(() => {
    if (user?.role === 'dm') loadCampaigns()
  }, [user?.role])

  useEffect(() => {
    if (!campaigns.length) return
    Promise.all(
      campaigns.map((c) =>
        apiFetch(`/api/campaigns/${c.id}/summary`)
          .then((r) => r.json())
          .then((j) => ({ id: c.id, ...(j.ok ? j : {}) }))
          .catch(() => ({ id: c.id }))
      )
    ).then((results) => {
      const map = {}
      results.forEach((r) => { map[r.id] = r })
      setSummaries(map)
    })
  }, [campaigns])

  async function submitCreate(e) {
    e.preventDefault()
    if (!newCampaignName.trim()) return
    setCreating(true)
    await createCampaign(newCampaignName.trim())
    setNewCampaignName('')
    setCreating(false)
    setShowCreate(false)
  }

  if (isLoading) return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
      Loading session...
    </div>
  )

  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'admin') return <Navigate to="/admin" replace />
  if (user.role !== 'dm') return <Navigate to="/login" replace />

  return (
    <div
      className="relative min-h-screen text-slate-100"
      style={{
        backgroundImage: 'url(/campaign-manager-bg.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
        backgroundAttachment: 'scroll',
      }}
    >
      <div className="absolute inset-0 bg-slate-950/88 pointer-events-none" aria-hidden="true" />

      <div className="relative z-10 mx-auto max-w-5xl px-5 py-8 space-y-6">

        {/* Header */}
        <header className="rounded-xl border border-slate-800/80 bg-slate-950/80 p-6 shadow-xl shadow-black/20">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-amber-400/80">DM Desk</div>
              <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-50">Your Campaigns</h1>
              <p className="mt-1 text-sm text-slate-400">
                Create worlds, run sessions, and manage your table.
              </p>
            </div>
            <div className="flex shrink-0 gap-3">
              <button
                onClick={() => navigate('/login')}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:border-slate-500 hover:text-slate-100"
              >
                Switch User
              </button>
              <Link
                to="/dm/settings"
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:border-slate-500 hover:text-slate-100"
              >
                Settings
              </Link>
              <button
                onClick={() => setShowCreate((s) => !s)}
                className="rounded-lg border border-amber-700 bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400"
              >
                {showCreate ? 'Cancel' : '+ New Campaign'}
              </button>
            </div>
          </div>

          {showCreate && (
            <form onSubmit={submitCreate} className="mt-5 flex gap-2 border-t border-slate-800 pt-5">
              <input
                value={newCampaignName}
                onChange={(e) => setNewCampaignName(e.target.value)}
                placeholder="Campaign name"
                autoFocus
                className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600"
              />
              <button
                type="submit"
                disabled={creating || !newCampaignName.trim()}
                className="rounded-lg border border-amber-700 bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
            </form>
          )}
        </header>

        {/* Campaign grid */}
        {campaigns.length > 0 ? (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                {campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}
              </h2>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {campaigns.map((c) => {
                const s = summaries[c.id] || {}
                return (
                  <div
                    key={c.id}
                    className="flex flex-col rounded-xl border border-slate-800/80 bg-slate-950/80 p-5 shadow-lg shadow-black/10"
                  >
                    <div className="flex-1">
                      <div className="text-xl font-bold text-slate-50 leading-tight">{c.name}</div>
                      <div className="mt-1 text-xs text-slate-600">
                        {c.id}{c.createdAt ? ` · ${new Date(c.createdAt).toLocaleDateString()}` : ''}
                      </div>

                      <div className="mt-4 grid grid-cols-4 gap-2">
                        <StatPill label="Sessions" value={s.sessions ?? '—'} />
                        <StatPill label="PCs" value={s.pcs ?? '—'} />
                        <StatPill
                          label="Pending"
                          value={s.pendingApprovals ?? '—'}
                          highlight={s.pendingApprovals > 0}
                        />
                        <StatPill label="Journal" value={s.journalEntries ?? '—'} />
                      </div>
                    </div>

                    <button
                      onClick={() => selectCampaign(c)}
                      className="mt-5 w-full rounded-lg border border-amber-700 bg-amber-500/10 py-2.5 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 hover:text-amber-200 transition-colors"
                    >
                      Enter Campaign →
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        ) : (
          <EmptyState onStart={() => setShowCreate(true)} />
        )}
      </div>
    </div>
  )
}

function StatPill({ label, value, highlight }) {
  return (
    <div className={`rounded-lg border p-2.5 text-center ${highlight ? 'border-amber-700/60 bg-amber-950/30' : 'border-slate-800 bg-slate-900/60'}`}>
      <div className={`text-lg font-bold leading-none ${highlight ? 'text-amber-300' : 'text-slate-200'}`}>
        {value}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  )
}

function EmptyState({ onStart }) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-950/80 p-10 text-center shadow-xl shadow-black/20">
      <div className="text-4xl mb-4">⚔️</div>
      <h2 className="text-2xl font-bold text-slate-100">Your Table Awaits</h2>
      <p className="mt-2 text-sm text-slate-400 max-w-md mx-auto">
        Create a campaign to start running a game. Each campaign has its own sessions, players, canon, and transcript pipeline.
      </p>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg mx-auto text-left">
        {[
          ['Sessions', 'Track game sessions and import transcripts for AI-assisted canon updates.'],
          ['Players & PCs', 'Invite players via shareable codes and manage their characters.'],
          ['Canon & Lexicon', 'Approve NPC updates, quest changes, and world lore from session imports.'],
          ['DM Controls', 'Notes, sneak-peek items, and what each player can see.'],
        ].map(([title, desc]) => (
          <div key={title} className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
            <div className="text-sm font-semibold text-amber-300">{title}</div>
            <div className="mt-1 text-xs text-slate-500">{desc}</div>
          </div>
        ))}
      </div>

      <button
        onClick={onStart}
        className="mt-8 rounded-lg border border-amber-700 bg-amber-500 px-8 py-3 text-sm font-semibold text-slate-950 hover:bg-amber-400"
      >
        Create Your First Campaign
      </button>
    </div>
  )
}
