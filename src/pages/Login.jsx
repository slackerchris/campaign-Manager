import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../AuthContext.jsx'
import { apiFetch } from '../lib/api.js'

export default function Login() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { login } = useAuth()
  const [bootstrapToken, setBootstrapToken] = useState('')
  const [inviteToken, setInviteToken] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  async function handleBootstrap(e) {
    e.preventDefault()
    if (!bootstrapToken) return
    setStatus('Bootstrapping DM Account...')
    setError('')
    try {
      const res = await apiFetch(`/api/campaigns/${id}/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: bootstrapToken, displayName: 'Dungeon Master' })
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Bootstrap failed')
      login(id, data.session)
      navigate(`/campaigns/${id}`)
    } catch (err) {
      setError(err.message)
      setStatus('')
    }
  }

  async function handleJoin(e) {
    e.preventDefault()
    if (!inviteToken || !displayName) return
    setStatus('Joining Campaign...')
    setError('')
    try {
      const res = await apiFetch(`/api/campaigns/${id}/auth/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken, displayName })
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Join failed')
      login(id, data.session)
      // Redirect player to their workspace
      if (data.session.role === 'player') {
        navigate(`/campaigns/${id}/me`)
      } else {
        navigate(`/campaigns/${id}`)
      }
    } catch (err) {
      setError(err.message)
      setStatus('')
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-900 text-neutral-200">
      <div className="w-[400px] p-6 bg-neutral-800 rounded shadow-md border border-neutral-700">
        <h1 className="text-2xl font-bold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-orange-400 to-amber-200">Campaign Gateway</h1>
        
        {error && <div className="mb-4 p-2 bg-red-900/50 text-red-200 rounded border border-red-800 text-sm">{error}</div>}
        {status && <div className="mb-4 p-2 bg-amber-900/50 text-amber-200 rounded border border-amber-800 text-sm">{status}</div>}
        
        {/* PLAYER JOIN FLOW */}
        <form onSubmit={handleJoin} className="mb-8">
          <h2 className="text-lg mb-2 font-semibold">Join via Invite</h2>
          <input
            className="w-full mb-3 p-2 bg-neutral-900 border border-neutral-700 rounded focus:border-amber-500 outline-none"
            type="text"
            placeholder="Invite Token"
            value={inviteToken}
            onChange={(e) => setInviteToken(e.target.value)}
          />
          <input
            className="w-full mb-3 p-2 bg-neutral-900 border border-neutral-700 rounded focus:border-amber-500 outline-none"
            type="text"
            placeholder="Your Display Name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <button className="w-full py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded transition">
            Join Campaign
          </button>
        </form>

        <hr className="border-neutral-700 mb-6" />

        {/* DM BOOTSTRAP RECOVERY */}
        <form onSubmit={handleBootstrap}>
          <h2 className="text-lg mb-2 font-semibold text-neutral-400">DM System Unlock</h2>
          <input
            className="w-full mb-3 p-2 bg-neutral-900 border border-neutral-700 rounded focus:border-amber-500 outline-none"
            type="password"
            placeholder="Global APP_TOKEN"
            value={bootstrapToken}
            onChange={(e) => setBootstrapToken(e.target.value)}
          />
          <button className="w-full py-2 border border-neutral-600 hover:border-amber-500 hover:text-amber-400 text-neutral-400 font-bold rounded transition">
            Bootstrap DM
          </button>
        </form>
      </div>
    </div>
  )
}
