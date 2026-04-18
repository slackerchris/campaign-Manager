const TOKEN_KEY = 'dnd_token'

export function getStoredToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

export function setStoredToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token) } catch {}
}

export function clearStoredToken() {
  try { localStorage.removeItem(TOKEN_KEY) } catch {}
}

/**
 * Drop-in fetch() replacement that automatically adds the stored
 * Authorization Bearer token when one is present in localStorage.
 * Now intelligently pulls campaign-specific session tokens for multi-tenant isolation.
 */
export function apiFetch(url, opts = {}) {
  let token = getStoredToken() // Fallback to global DM bootstrap token
  
  // Attempt to sniff campaignId from the fetch URL
  // e.g. /api/campaigns/my-campaign/endpoints
  const URLStr = String(url)
  const match = URLStr.match(/\/campaigns\/([^/?]+)/)
  if (match) {
    const campaignId = match[1]
    const sessionToken = localStorage.getItem(`dnd_session_${campaignId}`)
    if (sessionToken) {
      token = sessionToken
    }
  }

  if (!token) return fetch(url, opts)
  const headers = new Headers(opts.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  return fetch(url, { ...opts, headers })
}
