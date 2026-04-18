import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api.js'

export default function AdminSetup() {
  const [token, setToken] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  async function handleSetup(e) {
    e.preventDefault()
    if (token.length < 8) {
      setError('Token must be at least 8 characters long.')
      return
    }

    setStatus('Claiming server...')
    setError('')
    try {
      const res = await apiFetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Server already claimed.')
      
      setStatus('Success! Server claimed.')
      setTimeout(() => navigate('/'), 1500)
    } catch (err) {
      setError(err.message)
      setStatus('')
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-950 text-neutral-200">
      <div className="w-[450px] p-8 bg-neutral-900 rounded-xl shadow-2xl border border-neutral-800">
        <h1 className="text-3xl font-bold mb-2 text-white">Initial Setup</h1>
        <p className="text-sm text-neutral-400 mb-6">
          This server is currently completely unlocked. Set a master APP_TOKEN below. You will use this token to generate your first DM account credentials for any campaign you create.
        </p>

        {error && <div className="mb-4 p-3 bg-red-950/40 text-red-300 rounded border border-red-900/50 text-sm">{error}</div>}
        {status && <div className="mb-4 p-3 bg-emerald-950/40 text-emerald-300 rounded border border-emerald-900/50 text-sm">{status}</div>}

        <form onSubmit={handleSetup}>
          <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">Master Token / Password</label>
          <input
            className="w-full mb-6 p-3 bg-neutral-950 border border-neutral-800 rounded focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all placeholder:text-neutral-700 font-mono text-sm"
            type="password"
            placeholder="e.g. my-super-secret-passphrase"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold rounded transition-colors shadow-lg shadow-indigo-900/20">
            Claim Server & Lock
          </button>
        </form>
      </div>
    </div>
  )
}
