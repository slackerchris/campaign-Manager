import { useEffect } from 'react'
import { Link, NavLink, Outlet, useParams, Navigate, useLocation } from 'react-router-dom'
import { useApp } from '../AppContext.jsx'
import { useAuth } from '../AuthContext.jsx'
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
    setShowAddPc, setShowAddLexicon,
    reviewApproval, editingNpc, editingPc,
    showAddPc, showAddLexicon, showAddPlace, detailModal,
  } = useApp()

  const { user, isLoading, logout } = useAuth()
  const location = useLocation()
  const canManageCampaign = ['dm', 'admin'].includes(user?.role)

  useEffect(() => {
    initCampaign(id)
  }, [id])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-neutral-900 text-neutral-200 flex items-center justify-center">
        <div>Loading session...</div>
      </div>
    )
  }

  // Phase 4: Route Guards
  if (!user) {
    return <Navigate to={`/campaigns/${id}/login`} state={{ from: location }} replace />
  }

  if (!activeCampaign) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-slate-400">Loading campaign...</div>
      </div>
    )
  }

  const navItems = [
    { to: `/campaigns/${id}`, label: 'Desk', end: true },
    ...(canManageCampaign ? [
      { to: `/campaigns/${id}/dm`, label: 'Prep' },
      { to: `/campaigns/${id}/player`, label: 'Party' },
    ] : [
      { to: `/campaigns/${id}/me`, label: 'My Character' },
    ]),
    { to: `/campaigns/${id}/lexicon`, label: 'Canon' },
    ...(canManageCampaign ? [
      { to: `/campaigns/${id}/settings`, label: 'Settings' },
    ] : []),
  ]

  return (
    <div
      className={`relative min-h-screen text-slate-100 ${isMobileView ? 'p-3' : 'p-5'}`}
      style={{
        backgroundImage: 'url(/campaign-manager-bg.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
        backgroundAttachment: 'scroll',
      }}
    >
      <div className="absolute inset-0 bg-slate-950/88 pointer-events-none" aria-hidden="true" />
      <div className={`relative z-10 ${isMobileView ? 'max-w-none' : 'max-w-[1500px]'} mx-auto space-y-4`}>

        <header className="rounded-lg border border-slate-800/90 bg-slate-950/90 shadow-2xl shadow-black/20">
          <div className={`flex ${isMobileView ? 'flex-col items-stretch' : 'items-center justify-between'} gap-4 border-b border-slate-800 px-4 py-3`}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold text-slate-50">{activeCampaign.name}</h1>
                <span className="rounded border border-amber-700/70 bg-amber-950/40 px-2 py-0.5 text-[11px] font-semibold uppercase text-amber-300">
                  {user.role}
                </span>
              </div>
              <div className="mt-1 truncate text-xs text-slate-500">{activeCampaign.id}</div>
            </div>
            <div className={`flex ${isMobileView ? 'w-full flex-col' : 'items-center'} gap-2`}>
              {canManageCampaign && (
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowAddPc(true)}
                    className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:border-emerald-600 hover:text-emerald-300"
                  >
                    Add PC
                  </button>
                  <button
                    onClick={() => setShowAddLexicon(true)}
                    className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:border-amber-600 hover:text-amber-300"
                  >
                    Add Canon
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <Link
                  to="/"
                  className="rounded-md border border-slate-800 px-3 py-2 text-sm text-slate-500 hover:text-slate-300 hover:border-slate-600"
                  title="Switch Campaign"
                >
                  Switch
                </Link>
                <button
                  onClick={() => logout(id)}
                  className="rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-400 hover:text-rose-300 hover:bg-rose-900/40"
                  title="Log Out"
                >
                  Log out
                </button>
              </div>
            </div>
          </div>

          <nav className={`${isMobileView ? 'grid grid-cols-2' : 'flex'} gap-1 px-3 py-2`}>
            {navItems.map(({ to, label, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-2 text-sm text-center transition-colors ${isActive ? 'bg-slate-800 text-amber-300' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'}`
                  }
                >
                  {label}
                </NavLink>
              ))}
          </nav>
        </header>

        {error && (
          <div className="rounded-lg border border-rose-700 bg-rose-950/30 px-4 py-3 text-rose-300 text-sm flex items-center justify-between gap-2">
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
