import { createContext, useContext, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

const AuthContext = createContext(null)

export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }) {
  // To handle multiple campaigns, we store tokens with the campaign ID as the key prefix
  // e.g., dnd_session_<campaignId> = token
  const [user, setUser] = useState(null)
  const [sessionToken, setSessionToken] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  
  // We extract campaignId manually since standard useParams requires routing matches,
  // but AuthProvider wraps standard routes.
  const location = useLocation()
  const match = location.pathname.match(/\/campaigns\/([^/?]+)/)
  const activeCampaignId = match ? match[1] : null

  useEffect(() => {
    if (!activeCampaignId) {
      const token = localStorage.getItem('dnd_token')
      if (token) {
        setSessionToken(token)
        setUser({
          id: localStorage.getItem('dnd_token_user') || '',
          role: localStorage.getItem('dnd_token_role') || 'unknown',
          displayName: localStorage.getItem('dnd_token_display') || '',
          token,
        })
      } else {
        setUser(null)
        setSessionToken(null)
      }
      setIsLoading(false)
      return
    }

    const campaignToken = localStorage.getItem(`dnd_session_${activeCampaignId}`)
    const adminToken = localStorage.getItem('dnd_token')
    const token = campaignToken || adminToken
    if (token) {
      const role = campaignToken
        ? localStorage.getItem(`dnd_session_role_${activeCampaignId}`) || 'unknown'
        : localStorage.getItem('dnd_token_role') || 'admin'
      const userId = campaignToken
        ? localStorage.getItem(`dnd_session_user_${activeCampaignId}`) || ''
        : localStorage.getItem('dnd_token_user') || 'server-admin'
      setSessionToken(token)
      setUser({ id: userId, role, token })
      setIsLoading(false)
    } else {
      setUser(null)
      setSessionToken(null)
      setIsLoading(false)
    }
  }, [activeCampaignId, location.pathname])

  function login(campaignId, session) {
    localStorage.setItem(`dnd_session_${campaignId}`, session.token)
    localStorage.setItem(`dnd_session_role_${campaignId}`, session.role || 'unknown')
    localStorage.setItem(`dnd_session_user_${campaignId}`, session.userId || '')
    setSessionToken(session.token)
    setUser({ id: session.userId, role: session.role })
  }

  function logout(campaignId) {
    localStorage.removeItem(`dnd_session_${campaignId}`)
    localStorage.removeItem(`dnd_session_role_${campaignId}`)
    localStorage.removeItem(`dnd_session_user_${campaignId}`)
    if (user?.role === 'admin') {
      localStorage.removeItem('dnd_token')
      localStorage.removeItem('dnd_token_role')
      localStorage.removeItem('dnd_token_user')
    }
    setSessionToken(null)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, sessionToken, isLoading, login, logout, activeCampaignId }}>
      {children}
    </AuthContext.Provider>
  )
}
