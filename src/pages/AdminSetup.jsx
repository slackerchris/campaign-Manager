import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api.js'

export default function AdminSetup() {
  const [username, setUsername] = useState('admin')
  const [displayName, setDisplayName] = useState('Admin')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checkingSetup, setCheckingSetup] = useState(true)
  const navigate = useNavigate()
  const passwordReady = password.length >= 8
  const passwordsMatch = !!confirmPassword && password === confirmPassword

  useEffect(() => {
    let cancelled = false
    async function checkSetup() {
      try {
        const res = await apiFetch('/api/admin/status')
        const data = await res.json()
        if (!cancelled && data.ok && data.hasAdmin) {
          navigate(localStorage.getItem('dnd_token') ? '/admin' : '/login', { replace: true })
          return
        }
      } catch {
        // Render setup if status cannot be checked.
      }
      if (!cancelled) setCheckingSetup(false)
    }
    checkSetup()
    return () => { cancelled = true }
  }, [navigate])

  async function handleSetup(e) {
    e.preventDefault()
    if (!username.trim()) { setError('Username is required'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (password !== confirmPassword) { setError('Passwords do not match'); return }

    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), displayName: displayName.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Setup failed')

      const loginRes = await apiFetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const loginData = await loginRes.json()
      if (!loginRes.ok || !loginData.ok) throw new Error('Account created — please sign in')

      localStorage.setItem('dnd_token', loginData.session.token)
      localStorage.setItem('dnd_token_role', loginData.session.role || 'admin')
      localStorage.setItem('dnd_token_user', loginData.session.userId || '')
      navigate('/admin')
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  if (checkingSetup) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
        Checking setup...
      </div>
    )
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center p-5 text-slate-100"
      style={{
        backgroundImage: 'url(/campaign-manager-bg.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
      }}
    >
      <div className="absolute inset-0 bg-slate-950/90 pointer-events-none" aria-hidden="true" />
      <div className="relative z-10 grid w-full max-w-4xl overflow-hidden rounded-lg border border-slate-800 bg-slate-950/92 shadow-2xl shadow-black/30 md:grid-cols-[1fr_320px]">
        <div>
        <div className="border-b border-slate-800 px-5 py-4">
          <div className="text-[11px] font-semibold uppercase text-amber-400/80">First Run</div>
          <h1 className="mt-1 text-2xl font-semibold text-slate-50">Initial Setup</h1>
          <p className="mt-2 text-sm text-slate-400">
            Create the first server admin account for this installation.
          </p>
        </div>

        <div className="p-5">
          {error && <div className="mb-4 rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">{error}</div>}

        <form onSubmit={handleSetup} className="space-y-3">
          <label className="block text-[11px] font-semibold uppercase text-slate-500">Username</label>
          <input
            className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <label className="block text-[11px] font-semibold uppercase text-slate-500">Display Name</label>
          <input
            className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <label className="block text-[11px] font-semibold uppercase text-slate-500">Password</label>
          <input
            className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600"
            type="password"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className={`text-xs ${passwordReady ? 'text-emerald-400' : 'text-slate-500'}`}>
            {passwordReady ? 'Password length looks good.' : 'Use at least 8 characters.'}
          </div>
          <label className="block text-[11px] font-semibold uppercase text-slate-500">Confirm Password</label>
          <input
            className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-600"
            type="password"
            placeholder="Repeat password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          {confirmPassword && (
            <div className={`text-xs ${passwordsMatch ? 'text-emerald-400' : 'text-rose-400'}`}>
              {passwordsMatch ? 'Passwords match.' : 'Passwords do not match yet.'}
            </div>
          )}
          <button className="w-full rounded-md border border-amber-700 bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed" disabled={loading}>
            {loading ? 'Creating account…' : 'Create Admin Account'}
          </button>
          <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
            <Link to="/" className="hover:text-amber-300">Back</Link>
            <Link to="/admin/login" className="hover:text-amber-300">Already set up?</Link>
          </div>
        </form>
        </div>
        </div>

        <aside className="border-t border-slate-800 bg-slate-900/45 p-5 md:border-l md:border-t-0">
          <div className="text-[11px] font-semibold uppercase text-slate-500">This Account Can</div>
          <div className="mt-3 space-y-3 text-sm text-slate-300">
            <div className="rounded-md border border-slate-800 bg-slate-950/70 p-3">
              Invite and manage DM accounts
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/70 p-3">
              Configure model, transcription, and API settings
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-950/70 p-3">
              Manage access while DMs run their own games
            </div>
          </div>
          <div className="mt-5 rounded-md border border-amber-900/60 bg-amber-950/20 p-3 text-xs text-amber-200/90">
            Password recovery is handled from the server console with npm run admin:reset.
          </div>
        </aside>
      </div>
    </div>
  )
}
