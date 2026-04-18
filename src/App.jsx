import { Routes, Route } from 'react-router-dom'
import { AppProvider } from './AppContext.jsx'
import { AuthProvider } from './AuthContext.jsx'
import Landing from './pages/Landing.jsx'
import CampaignLayout from './pages/CampaignLayout.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import DmPage from './pages/DmPage.jsx'
import PlayerPage from './pages/PlayerPage.jsx'
import LexiconPage from './pages/LexiconPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import Login from './pages/Login.jsx'
import AdminSetup from './pages/AdminSetup.jsx'

export default function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/setup" element={<AdminSetup />} />
          <Route path="/campaigns/:id/login" element={<Login />} />
          <Route path="/campaigns/:id" element={<CampaignLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="dm" element={<DmPage />} />
            <Route path="player" element={<PlayerPage />} />
            <Route path="me" element={<PlayerPage />} /> {/* Future Phase 5 Workspace */}
            <Route path="lexicon" element={<LexiconPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AppProvider>
    </AuthProvider>
  )
}
