import { useEffect } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { useApp } from '../AppContext.jsx'
import ApprovalModal from '../components/modals/ApprovalModal.jsx'
import EditNpcModal from '../components/modals/EditNpcModal.jsx'
import LexiconDetailModal from '../components/modals/LexiconDetailModal.jsx'
import AddPcModal from '../components/modals/AddPcModal.jsx'
import EditPcModal from '../components/modals/EditPcModal.jsx'
import AddLexiconModal from '../components/modals/AddLexiconModal.jsx'
import AddPlaceModal from '../components/modals/AddPlaceModal.jsx'

export default function CampaignLayout() {
  const { id } = useParams()
  const {
    activeCampaign, isMobileView, error, setError,
    initCampaign,
    reviewApproval, editingNpc, editingPc,
    showAddPc, showAddLexicon, showAddPlace, detailModal,
  } = useApp()

  useEffect(() => {
    initCampaign(id)
  }, [id])

  if (!activeCampaign) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-slate-400">Loading campaign...</div>
      </div>
    )
  }

  return (
    <div
      className={`relative min-h-screen text-slate-100 ${isMobileView ? 'p-3' : 'p-6'}`}
      style={{
        backgroundImage: 'url(/campaign-manager-bg.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
        backgroundAttachment: 'scroll',
      }}
    >
      <div className="absolute inset-0 bg-slate-950/80 pointer-events-none" aria-hidden="true" />
      <div className={`relative z-10 ${isMobileView ? 'max-w-none' : 'max-w-7xl'} mx-auto space-y-6`}>

        {/* Header */}
        <div className={`rounded-3xl border border-slate-800 bg-slate-900 ${isMobileView ? 'p-4' : 'p-6'}`}>
          <div className={`flex ${isMobileView ? 'flex-col items-start' : 'justify-between items-center'} gap-4`}>
            <div>
              <h1 className="text-3xl font-bold">{activeCampaign.name}</h1>
              <p className="text-xs text-slate-400">{activeCampaign.id}</p>
            </div>
            <div className={`${isMobileView ? 'grid grid-cols-3 w-full' : 'flex'} gap-2 items-center`}>
              {[
                { to: `/campaigns/${id}`, label: 'Dashboard', end: true },
                { to: `/campaigns/${id}/dm`, label: 'DM' },
                { to: `/campaigns/${id}/player`, label: 'Player' },
                { to: `/campaigns/${id}/lexicon`, label: 'Lexicon' },
                { to: `/campaigns/${id}/settings`, label: 'Settings' },
              ].map(({ to, label, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `rounded-xl border px-4 py-2 text-sm text-center ${isActive ? 'border-amber-500 text-amber-300 bg-amber-950/20' : 'border-slate-700 hover:border-slate-500 transition-colors'}`
                  }
                >
                  {label}
                </NavLink>
              ))}
              <Link
                to="/"
                className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-500 hover:text-slate-300 hover:border-slate-600 transition-colors text-center"
              >
                ← Campaigns
              </Link>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-700 bg-rose-950/20 px-4 py-3 text-rose-300 text-sm flex items-center justify-between gap-2">
            <span>{error}</span>
            <button onClick={() => setError('')} className="rounded border border-rose-700 px-2 py-0.5 text-xs">×</button>
          </div>
        )}

        <Outlet />

        {reviewApproval && <ApprovalModal />}
        {editingNpc && <EditNpcModal />}
        {detailModal && <LexiconDetailModal />}
        {showAddPc && <AddPcModal />}
        {editingPc && <EditPcModal />}
        {showAddLexicon && <AddLexiconModal />}
        {showAddPlace && <AddPlaceModal />}
      </div>
    </div>
  )
}
