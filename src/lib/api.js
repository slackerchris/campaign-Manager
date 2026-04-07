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
 */
export function apiFetch(url, opts = {}) {
  const token = getStoredToken()
  if (!token) return fetch(url, opts)
  const headers = new Headers(opts.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  return fetch(url, { ...opts, headers })
}
