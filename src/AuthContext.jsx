import { createContext, useContext, useEffect, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'

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
      setUser(null)
      setSessionToken(null)
      setIsLoading(false)
      return
    }

    const token = localStorage.getItem(`dnd_session_${activeCampaignId}`)
    if (token) {
      setSessionToken(token)
      // Because we use JWTs/Opaque tokens and map them via middleware, we can decode 
      // the role easily or make an authenticated health check
      // For now, assume if token exists, we do a quick validation
      validateSession(token, activeCampaignId)
    } else {
      setUser(null)
      setSessionToken(null)
      setIsLoading(false)
    }
  }, [activeCampaignId])

  async function validateSession(token, campaignId) {
    try {
      // In a real app we'd have a /me or /health that requires auth
      // For now, if we hit any campaign endpoint and it 401s, we know the token is bad
      setUser({ role: 'unknown', token }) // Temporary pessimistic state
      setIsLoading(false)
    } catch {
      logout(campaignId)
    }
  }

  function login(campaignId, session) {
    localStorage.setItem(`dnd_session_${campaignId}`, session.token)
    setSessionToken(session.token)
    setUser({ id: session.userId, role: session.role })
  }

  function logout(campaignId) {
    localStorage.removeItem(`dnd_session_${campaignId}`)
    setSessionToken(null)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, sessionToken, isLoading, login, logout, activeCampaignId }}>
      {children}
    </AuthContext.Provider>
  )
}
