import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../AuthContext.jsx'
import { apiFetch } from '../lib/api.js'

function storedAdminToken() {
  try {
    return localStorage.getItem('dnd_token_role') === 'admin' ? localStorage.getItem('dnd_token') || '' : ''
  } catch { return '' }
}

const inp = 'w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600 disabled:opacity-40'
const lbl = 'block text-[11px] font-semibold uppercase text-slate-500'
const btn = 'w-full rounded-md border border-amber-700 bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed'

function saveSession(session, displayName) {
  localStorage.setItem('dnd_token', session.token)
  localStorage.setItem('dnd_token_role', session.role || 'unknown')
  localStorage.setItem('dnd_token_user', session.userId || '')
  localStorage.setItem('dnd_token_display', session.displayName || displayName || '')
}

function friendlyError(err, res) {
  if (!res) return 'Connection failed — is the server running?'
  if (res.status === 429) {
    const retryAfter = res.headers?.get?.('Retry-After')
    return retryAfter
      ? `Too many attempts — please wait ${retryAfter}s before trying again`
      : 'Too many attempts — please wait a minute before trying again'
  }
  if (res.status === 401) return 'Incorrect username or password'
  if (res.status === 409) return err.message || 'That username is already taken'
  if (res.status === 400) return err.message || 'Please check your details and try again'
  if (res.status >= 500) return 'Server error — please try again in a moment'
  return err.message || 'Something went wrong'
}

// Counts down from retryAfter seconds, calling onDone when it reaches 0
function useCountdown(seconds, onDone) {
  const [remaining, setRemaining] = useState(seconds)
  const ref = useRef(null)
  useEffect(() => {
    setRemaining(seconds)
    if (seconds <= 0) { onDone?.(); return }
    ref.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) { clearInterval(ref.current); onDone?.(); return 0 }
        return r - 1
      })
    }, 1000)
    return () => clearInterval(ref.current)
  }, [seconds]) // eslint-disable-line react-hooks/exhaustive-deps
  return remaining
}

export default function Login() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { login } = useAuth()

  const [mode, setMode] = useState('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [campaignId, setCampaignId] = useState(id || '')
  const [inviteToken, setInviteToken] = useState('')
  const [accountInviteToken, setAccountInviteToken] = useState(searchParams.get('accountInvite') || '')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [registered, setRegistered] = useState(null)
  const [checkingAdmin, setCheckingAdmin] = useState(true)
  const [rateLimitSeconds, setRateLimitSeconds] = useState(0)

  const retryRemaining = useCountdown(rateLimitSeconds, () => setRateLimitSeconds(0))
  const isRateLimited = retryRemaining > 0

  useEffect(() => {
    const accountInvite = searchParams.get('accountInvite')
    if (accountInvite) { setAccountInviteToken(accountInvite); setMode('account-invite') }
  }, [searchParams])

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const res = await apiFetch('/api/admin/status')
        const data = await res.json()
        if (!cancelled && data.ok && !data.hasAdmin) { navigate('/setup', { replace: true }); return }
      } catch { /* render login */ }
      if (!cancelled) setCheckingAdmin(false)
    }
    check()
    return () => { cancelled = true }
  }, [navigate])

  function switchMode(next) { setMode(next); setError(''); setLoading(false); setRegistered(null); setRateLimitSeconds(0) }

  async function handleSignIn(e) {
    e.preventDefault()
    if (!username.trim()) { setError('Username is required'); return }
    if (!password) { setError('Password is required'); return }
    setLoading(true); setError('')
    let res
    try {
      res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw Object.assign(new Error(data.error || 'Sign in failed'), { res })
      saveSession(data.session, username)
      if (data.session.role === 'admin') navigate('/admin')
      else if (data.session.role === 'dm') navigate('/dm')
      else navigate('/player')
    } catch (err) {
      if (res?.status === 429) {
        const after = Number(res.headers?.get?.('Retry-After') || 60)
        setRateLimitSeconds(after)
      }
      setPassword('')
      setError(friendlyError(err, res))
      setLoading(false)
    }
  }

  async function handleSignUp(e) {
    e.preventDefault()
    if (!username.trim()) { setError('Username is required'); return }
    if (!displayName.trim()) { setError('Display name is required'); return }
    if (!password) { setError('Password is required'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (password !== confirmPassword) { setError('Passwords do not match'); return }
    setLoading(true); setError('')
    let res
    try {
      res = await apiFetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), displayName: displayName.trim(), email: email.trim() || undefined, password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw Object.assign(new Error(data.error || 'Registration failed'), { res })
      saveSession(data.session, displayName)
      setRegistered({ name: data.session.displayName || username })
      setEmail(''); setPassword(''); setConfirmPassword('')
    } catch (err) {
      setPassword(''); setConfirmPassword('')
      setError(friendlyError(err, res))
    } finally { setLoading(false) }
  }

  async function handleJoin(e) {
    e.preventDefault()
    const target = String(campaignId || id || '').trim()
    if (!target) { setError('Campaign ID is required'); return }
    if (!inviteToken.trim()) { setError('Invite code is required'); return }
    if (!displayName.trim()) { setError('Display name is required'); return }

    const serverToken = localStorage.getItem('dnd_token')
    if (!serverToken) {
      setError('You need to sign in or create an account before joining a campaign')
      setMode('signin')
      return
    }

    setLoading(true); setError('')
    let res
    try {
      res = await apiFetch(`/api/campaigns/${target}/auth/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serverToken}` },
        body: JSON.stringify({ inviteToken: inviteToken.trim(), displayName: displayName.trim() }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw Object.assign(new Error(data.error || 'Join failed'), { res })
      navigate(`/player`)
    } catch (err) {
      setError(friendlyError(err, res))
    } finally { setLoading(false) }
  }

  async function handleAccountInvite(e) {
    e.preventDefault()
    if (!accountInviteToken.trim()) { setError('Invite code is required'); return }
    if (!username.trim()) { setError('Username is required'); return }
    if (!displayName.trim()) { setError('Display name is required'); return }
    if (!password) { setError('Password is required'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setLoading(true); setError('')
    let res
    try {
      res = await apiFetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken: accountInviteToken.trim(), username: username.trim(), displayName: displayName.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw Object.assign(new Error(data.error || 'Invite failed'), { res })
      saveSession(data.session, displayName)
      if (data.session.role === 'dm') navigate('/dm')
      else navigate('/player')
    } catch (err) {
      setPassword('')
      setError(friendlyError(err, res))
    } finally { setLoading(false) }
  }

  if (checkingAdmin) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">Checking setup…</div>
  }

  const disabled = loading || isRateLimited

  return (
    <div
      className="relative flex min-h-screen items-center justify-center p-5 text-slate-100"
      style={{ backgroundImage: 'url(/campaign-manager-bg.png)', backgroundSize: 'cover', backgroundPosition: 'center top' }}
    >
      <div className="absolute inset-0 bg-slate-950/90 pointer-events-none" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-sm overflow-hidden rounded-lg border border-slate-800 bg-slate-950/92 shadow-2xl shadow-black/30">

        <div className="border-b border-slate-800 px-5 py-4">
          <div className="text-[11px] font-semibold uppercase text-amber-400/80">Campaign Manager</div>
          <h1 className="mt-1 text-2xl font-semibold text-slate-50">
            {mode === 'signup' ? 'Create Account' : mode === 'invite' ? 'Join Campaign' : mode === 'account-invite' ? 'Accept Invite' : 'Sign In'}
          </h1>
        </div>

        <div className="p-5">
          {error && (
            <div className="mb-4 rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">
              {error}
            </div>
          )}
          {isRateLimited && (
            <div className="mb-4 rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-300">
              Too many attempts — try again in {retryRemaining}s
            </div>
          )}

          {/* Sign In */}
          {mode === 'signin' && (
            <form onSubmit={handleSignIn} className="space-y-3">
              <div>
                <label className={lbl}>Username</label>
                <input className={inp} type="text" autoFocus autoComplete="username" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={disabled} />
              </div>
              <div>
                <label className={lbl}>Password</label>
                <input className={inp} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={disabled} />
              </div>
              <button className={btn} disabled={disabled}>
                {loading ? 'Signing in…' : isRateLimited ? `Wait ${retryRemaining}s` : 'Sign In'}
              </button>
            </form>
          )}

          {/* Sign Up */}
          {mode === 'signup' && (
            registered ? (
              <div className="space-y-3">
                <div className="rounded-md border border-emerald-800 bg-emerald-950/40 p-4 text-sm">
                  <div className="font-semibold text-emerald-200">Welcome, {registered.name}!</div>
                  <div className="mt-1 text-emerald-300/80 text-xs">Account created. Ask your DM for a campaign invite code to join a game.</div>
                </div>
                <button onClick={() => switchMode('invite')} className={btn}>Enter Campaign Invite Code →</button>
              </div>
            ) : (
              <form onSubmit={handleSignUp} className="space-y-3">
                <div>
                  <label className={lbl}>Email <span className="normal-case text-slate-600">(optional)</span></label>
                  <input className={inp} type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} />
                </div>
                <div>
                  <label className={lbl}>Username</label>
                  <input className={inp} type="text" autoComplete="username" placeholder="letters, numbers, dots, dashes" value={username} onChange={(e) => setUsername(e.target.value)} disabled={loading} />
                </div>
                <div>
                  <label className={lbl}>Display Name</label>
                  <input className={inp} type="text" placeholder="How you appear to others" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={loading} />
                </div>
                <div>
                  <label className={lbl}>Password</label>
                  <input className={inp} type="password" autoComplete="new-password" placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} />
                </div>
                <div>
                  <label className={lbl}>Confirm Password</label>
                  <input className={inp} type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} disabled={loading} />
                </div>
                <button className={btn} disabled={loading}>{loading ? 'Creating account…' : 'Create Account'}</button>
              </form>
            )
          )}

          {/* Campaign Invite */}
          {mode === 'invite' && (
            <form onSubmit={handleJoin} className="space-y-3">
              {!id && (
                <div>
                  <label className={lbl}>Campaign ID</label>
                  <input className={inp} type="text" placeholder="campaign-id" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} disabled={loading} />
                </div>
              )}
              <div>
                <label className={lbl}>Invite Code</label>
                <input className={inp} type="text" value={inviteToken} onChange={(e) => setInviteToken(e.target.value)} disabled={loading} />
              </div>
              <div>
                <label className={lbl}>Display Name</label>
                <input className={inp} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={loading} />
              </div>
              <button className={btn} disabled={loading}>{loading ? 'Joining…' : 'Join Campaign'}</button>
            </form>
          )}

          {/* Account Invite */}
          {mode === 'account-invite' && (
            <form onSubmit={handleAccountInvite} className="space-y-3">
              <div>
                <label className={lbl}>Invite Code</label>
                <input className={inp} type="text" value={accountInviteToken} onChange={(e) => setAccountInviteToken(e.target.value)} disabled={loading} />
              </div>
              <div>
                <label className={lbl}>Username</label>
                <input className={inp} type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={loading} />
              </div>
              <div>
                <label className={lbl}>Display Name</label>
                <input className={inp} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={loading} />
              </div>
              <div>
                <label className={lbl}>Password</label>
                <input className={inp} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} />
              </div>
              <button className={btn} disabled={loading}>{loading ? 'Creating account…' : 'Create Account'}</button>
            </form>
          )}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            {mode === 'invite' || mode === 'account-invite' ? (
              <button onClick={() => switchMode('signin')} className="hover:text-amber-300">← Back</button>
            ) : mode === 'signup' ? (
              <button onClick={() => switchMode('signin')} className="hover:text-amber-300">← Sign In</button>
            ) : (
              <Link to="/" className="hover:text-amber-300">Back</Link>
            )}
            <div className="flex gap-3">
              {mode === 'signin' && (
                <>
                  <button onClick={() => switchMode('invite')} className="hover:text-slate-300">Campaign Invite</button>
                  <button onClick={() => switchMode('signup')} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-amber-700 hover:text-amber-300">
                    Sign Up
                  </button>
                </>
              )}
              {mode === 'signup' && (
                <button onClick={() => switchMode('invite')} className="hover:text-slate-300">Campaign Invite</button>
              )}
              {storedAdminToken() && (
                <button onClick={() => { if (id && storedAdminToken()) navigate(`/campaigns/${id}`); else navigate('/admin') }} className="hover:text-amber-300">
                  Continue as Admin
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
