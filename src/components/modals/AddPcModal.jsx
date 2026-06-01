import { useState } from 'react'
import { useApp } from '../../AppContext.jsx'

const inp = 'w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-600'

export default function AddPcModal() {
  const { showAddPc, setShowAddPc, newPc, setNewPc, addPc, importDndbCharacter } = useApp()
  const [ddbInput, setDdbInput] = useState('')
  const [ddbStatus, setDdbStatus] = useState('')
  const [ddbError, setDdbError] = useState('')
  const [importing, setImporting] = useState(false)

  if (!showAddPc) return null

  async function handleDdbImport() {
    if (!ddbInput.trim()) return
    setImporting(true)
    setDdbError('')
    setDdbStatus('')
    try {
      const pc = await importDndbCharacter(ddbInput.trim(), (msg) => {
        if (msg.startsWith('Sync failed') || msg.startsWith('DDB')) setDdbError(msg)
        else setDdbStatus(msg)
      })
      if (pc) {
        setDdbInput('')
        setDdbStatus('')
        setShowAddPc(false)
      }
    } catch (err) {
      setDdbError(err.message)
    }
    setImporting(false)
  }

  function handleClose() {
    setShowAddPc(false)
    setDdbInput('')
    setDdbStatus('')
    setDdbError('')
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-4">
        <h3 className="text-xl font-semibold">Add Player Character</h3>

        {/* D&D Beyond import */}
        <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-4 space-y-2">
          <div className="text-xs font-semibold uppercase text-amber-400/80">Import from D&D Beyond</div>
          <div className="flex gap-2">
            <input
              value={ddbInput}
              onChange={(e) => setDdbInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleDdbImport()}
              placeholder="Character URL or ID"
              className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-600"
            />
            <button
              onClick={handleDdbImport}
              disabled={importing || !ddbInput.trim()}
              className="rounded-xl border border-amber-700 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
            >
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
          {ddbError && <div className="text-xs text-rose-400">{ddbError}</div>}
          {ddbStatus && <div className="text-xs text-emerald-400">{ddbStatus}</div>}
          <div className="text-xs text-slate-600">
            The character must be set to <strong className="text-slate-500">Public</strong> in D&D Beyond settings.
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-slate-800" />
          <span className="text-xs text-slate-600">or enter manually</span>
          <div className="flex-1 border-t border-slate-800" />
        </div>

        {/* Manual entry */}
        <div className="space-y-2">
          <input value={newPc.playerName} onChange={(e) => setNewPc({ ...newPc, playerName: e.target.value })} placeholder="Player name" className={inp} />
          <input value={newPc.ddbUsername} onChange={(e) => setNewPc({ ...newPc, ddbUsername: e.target.value })} placeholder="D&D Beyond username (optional)" className={inp} />
          <input value={newPc.characterName} onChange={(e) => setNewPc({ ...newPc, characterName: e.target.value })} placeholder="Character name" className={inp} />
          <div className="grid grid-cols-3 gap-2">
            <input value={newPc.class} onChange={(e) => setNewPc({ ...newPc, class: e.target.value })} placeholder="Class" className={inp} />
            <input value={newPc.race} onChange={(e) => setNewPc({ ...newPc, race: e.target.value })} placeholder="Race" className={inp} />
            <input type="number" value={newPc.level} onChange={(e) => setNewPc({ ...newPc, level: Number(e.target.value || 1) })} placeholder="Level" className={inp} />
          </div>
          <textarea value={newPc.notes} onChange={(e) => setNewPc({ ...newPc, notes: e.target.value })} placeholder="Notes" className={`${inp} min-h-20`} />
        </div>

        <div className="flex gap-2 justify-end">
          <button onClick={handleClose} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Cancel</button>
          <button onClick={addPc} className="rounded-xl border border-emerald-600 text-emerald-300 px-4 py-2 text-sm">Add Manually</button>
        </div>
      </div>
    </div>
  )
}
