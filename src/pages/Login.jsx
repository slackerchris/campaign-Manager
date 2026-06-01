import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../AuthContext.jsx'
import { apiFetch } from '../lib/api.js'

function storedAdminToken() {
  try {
    return localStorage.getItem('dnd_token_role') === 'admin' ? localStorage.getItem('dnd_token') || '' : ''
  } catch { return '' }
}

const inp = 'w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600'
const lbl = 'block text-[11px] font-semibold uppercase text-slate-500'
const btn = 'w-full rounded-md border border-amber-700 bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400'

export default function Login() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { login } = useAuth()

  const [mode, setMode] = useState('signin') // signin | signup | invite | account-invite
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [campaignId, setCampaignId] = useState(id || '')
  const [inviteToken, setInviteToken] = useState('')
  const [accountInviteToken, setAccountInviteToken] = useState(searchParams.get('accountInvite') || '')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [registered, setRegistered] = useState(null)
  const [checkingAdmin, setCheckingAdmin] = useState(true)

  useEffect(() => {
    const accountInvite = searchParams.get('accountInvite')
    if (accountInvite) {
      setAccountInviteToken(accountInvite)
      setMode('account-invite')
    }
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

  function switchMode(next) { setMode(next); setError(''); setStatus(''); setRegistered(null) }

  async function handleSignIn(e) {
    e.preventDefault()
    if (!username || !password) return
    setStatus('Signing in...')
    setError('')
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Sign in failed')
      localStorage.setItem('dnd_token', data.session.token)
      localStorage.setItem('dnd_token_role', data.session.role || 'unknown')
      localStorage.setItem('dnd_token_user', data.session.userId || '')
      localStorage.setItem('dnd_token_display', data.session.displayName || '')
      if (data.session.role === 'admin') navigate('/admin')
      else if (data.session.role === 'dm') navigate('/dm')
      else navigate('/player')
    } catch (err) { setError(err.message); setStatus('') }
  }

  async function handleSignUp(e) {
    e.preventDefault()
    if (!username.trim() || !displayName.trim() || !password) return
    if (password !== confirmPassword) { setError('Passwords do not match'); return }
    setStatus('Creating account...')
    setError('')
    try {
      const res = await apiFetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName, email, password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Registration failed')
      localStorage.setItem('dnd_token', data.session.token)
      localStorage.setItem('dnd_token_role', data.session.role || 'player')
      localStorage.setItem('dnd_token_user', data.session.userId || '')
      localStorage.setItem('dnd_token_display', data.session.displayName || displayName)
      setRegistered({ name: data.session.displayName || username })
      setStatus('')
      setEmail('')
      setPassword('')
      setConfirmPassword('')
    } catch (err) { setError(err.message); setStatus('') }
  }

  async function handleJoin(e) {
    e.preventDefault()
    const target = String(campaignId || id || '').trim()
    if (!target || !inviteToken || !displayName.trim()) return
    setStatus('Joining...')
    setError('')
    try {
      const res = await apiFetch(`/api/campaigns/${target}/auth/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken, displayName }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Join failed')
      login(target, data.session)
      navigate(data.session.role === 'dm' ? `/campaigns/${target}/dm` : `/campaigns/${target}/me`)
    } catch (err) { setError(err.message); setStatus('') }
  }

  async function handleAccountInvite(e) {
    e.preventDefault()
    if (!accountInviteToken || !username.trim() || !displayName.trim() || !password) return
    setStatus('Creating account...')
    setError('')
    try {
      const res = await apiFetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken: accountInviteToken, username, displayName, password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Invite failed')
      localStorage.setItem('dnd_token', data.session.token)
      localStorage.setItem('dnd_token_role', data.session.role || 'unknown')
      localStorage.setItem('dnd_token_user', data.session.userId || '')
      localStorage.setItem('dnd_token_display', data.session.displayName || '')
      if (data.session.role === 'dm') navigate('/dm')
      else navigate('/player')
    } catch (err) { setError(err.message); setStatus('') }
  }

  if (checkingAdmin) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">Checking setup...</div>
  }

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
          {error && <div className="mb-4 rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">{error}</div>}
          {status && <div className="mb-4 rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-300">{status}</div>}


          {/* Sign In */}
          {mode === 'signin' && (
            <form onSubmit={handleSignIn} className="space-y-3">
              <label className={lbl}>Username</label>
              <input className={inp} type="text" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
              <label className={lbl}>Password</label>
              <input className={inp} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className={btn}>Sign In</button>
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
                <label className={lbl}>Email</label>
                <input className={inp} type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <label className={lbl}>Username</label>
                <input className={inp} type="text" placeholder="letters, numbers, dots, dashes" value={username} onChange={(e) => setUsername(e.target.value)} />
                <label className={lbl}>Display Name</label>
                <input className={inp} type="text" placeholder="How you appear to others" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                <label className={lbl}>Password</label>
                <input className={inp} type="password" placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
                <label className={lbl}>Confirm Password</label>
                <input className={inp} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                <button className={btn}>Create Account</button>
              </form>
            )
          )}

          {/* Campaign Invite (secondary flow) */}
          {mode === 'invite' && (
            <form onSubmit={handleJoin} className="space-y-3">
              {!id && (
                <>
                  <label className={lbl}>Campaign ID</label>
                  <input className={inp} type="text" placeholder="campaign-id" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
                </>
              )}
              <label className={lbl}>Invite Code</label>
              <input className={inp} type="text" value={inviteToken} onChange={(e) => setInviteToken(e.target.value)} />
              <label className={lbl}>Display Name</label>
              <input className={inp} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <button className={btn}>Join Campaign</button>
            </form>
          )}

          {/* Account Invite (secondary flow, usually URL-triggered) */}
          {mode === 'account-invite' && (
            <form onSubmit={handleAccountInvite} className="space-y-3">
              <label className={lbl}>Invite Code</label>
              <input className={inp} type="text" value={accountInviteToken} onChange={(e) => setAccountInviteToken(e.target.value)} />
              <label className={lbl}>Username</label>
              <input className={inp} type="text" value={username} onChange={(e) => setUsername(e.target.value)} />
              <label className={lbl}>Display Name</label>
              <input className={inp} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <label className={lbl}>Password</label>
              <input className={inp} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className={btn}>Create Account</button>
            </form>
          )}

          {/* Footer links */}
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
