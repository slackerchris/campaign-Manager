import { useEffect, useState } from 'react'
import { useApp } from '../AppContext.jsx'
import { apiFetch } from '../lib/api.js'

const API_BASE = '/api'

export default function SettingsPage() {
  const {
    activeCampaign,
    llmProvider, setLlmProvider, llmModel, setLlmModel,
    pipelineHasKey, setPipelineHasKey,
    anthropicHasKey, setAnthropicHasKey,
    geminiHasKey, setGeminiHasKey,
    pyannoteHasToken, setPyannoteHasToken,
    loadPipelineKeyStatus, loadAnthropicKeyStatus, loadGeminiKeyStatus, loadPyannoteTokenStatus,
  } = useApp()

  // ── ASR state ─────────────────────────────────────────────────────────────
  const [asrProvider, setAsrProvider] = useState('remote')
  const [asrStatus, setAsrStatus] = useState('')
  const [groqApiKey, setGroqApiKey] = useState('')
  const [groqKeyStatus, setGroqKeyStatus] = useState('')
  const [groqHasKey, setGroqHasKey] = useState(false)
  const [asrInfo, setAsrInfo] = useState(null)

  // ── LLM state ─────────────────────────────────────────────────────────────
  const [llmStatus, setLlmStatus] = useState('')
  const [llmModelsByProvider, setLlmModelsByProvider] = useState({ ollama: [], openai: [], anthropic: [], gemini: [] })

  // ── API key state ─────────────────────────────────────────────────────────
  const [pipelineOpenaiKey, setPipelineOpenaiKey] = useState('')
  const [pipelineKeyStatus, setPipelineKeyStatus] = useState('')
  const [anthropicApiKey, setAnthropicApiKey] = useState('')
  const [anthropicKeyStatus, setAnthropicKeyStatus] = useState('')
  const [geminiApiKey, setGeminiApiKey] = useState('')
  const [geminiKeyStatus, setGeminiKeyStatus] = useState('')
  const [pyannoteToken, setPyannoteToken] = useState('')
  const [pyannoteTokenStatus, setPyannoteTokenStatus] = useState('')

  // ── SQLite state ──────────────────────────────────────────────────────────
  const [sqlStorageStatus, setSqlStorageStatus] = useState('')
  const [sqlStorageReport, setSqlStorageReport] = useState(null)
  const [sqlOpsStatus, setSqlOpsStatus] = useState('')
  const [sqlExportInfo, setSqlExportInfo] = useState(null)
  const [sqlBackupInfo, setSqlBackupInfo] = useState(null)

  useEffect(() => {
    loadLlmModels()
    loadAsrConfig()
  }, [])

  async function loadAsrConfig() {
    try {
      const r = await apiFetch(`${API_BASE}/asr/config`)
      const j = await r.json()
      if (j.ok) {
        setAsrProvider(j.asrProvider || 'remote')
        setGroqHasKey(!!j.hasGroqKey)
        setAsrInfo(j)
      }
    } catch { /* ignore */ }
  }

  async function saveAsrProvider(provider) {
    setAsrStatus('Saving...')
    const r = await apiFetch(`${API_BASE}/asr/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asrProvider: provider }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setAsrStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setAsrProvider(j.asrProvider)
    setAsrStatus(`ASR provider set to: ${j.asrProvider}`)
  }

  async function saveGroqKey() {
    if (!groqApiKey.trim()) { setGroqKeyStatus('Enter a key first'); return }
    setGroqKeyStatus('Saving key...')
    const r = await apiFetch(`${API_BASE}/groq/key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groqApiKey: groqApiKey.trim() }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setGroqKeyStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setGroqApiKey('')
    setGroqHasKey(true)
    setGroqKeyStatus('Saved. Groq API key is persisted on server.')
  }

  async function loadLlmModels() {
    try {
      const r = await apiFetch(`${API_BASE}/llm/models`)
      const j = await r.json()
      if (j.ok && j.byProvider) setLlmModelsByProvider(j.byProvider)
    } catch { /* ignore */ }
  }

  async function saveLlmConfig() {
    setLlmStatus('Saving...')
    const r = await apiFetch(`${API_BASE}/llm/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: llmProvider, model: llmModel }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setLlmStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setLlmStatus(`Saved: ${j.provider} / ${j.model}`)
  }

  async function savePipelineKey() {
    if (!pipelineOpenaiKey.trim()) { setPipelineKeyStatus('Enter a key first'); return }
    setPipelineKeyStatus('Saving key...')
    const r = await apiFetch(`${API_BASE}/pipeline/key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openaiApiKey: pipelineOpenaiKey.trim() }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setPipelineKeyStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setPipelineOpenaiKey('')
    setPipelineHasKey(true)
    setPipelineKeyStatus('Saved. OpenAI API key is persisted on server.')
  }

  async function saveAnthropicKey() {
    if (!anthropicApiKey.trim()) { setAnthropicKeyStatus('Enter a key first'); return }
    setAnthropicKeyStatus('Saving key...')
    const r = await apiFetch(`${API_BASE}/anthropic/key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicApiKey: anthropicApiKey.trim() }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setAnthropicKeyStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setAnthropicApiKey('')
    setAnthropicHasKey(true)
    setAnthropicKeyStatus('Saved. Anthropic API key is persisted on server.')
  }

  async function saveGeminiKey() {
    if (!geminiApiKey.trim()) { setGeminiKeyStatus('Enter a key first'); return }
    setGeminiKeyStatus('Saving key...')
    const r = await apiFetch(`${API_BASE}/gemini/key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geminiApiKey: geminiApiKey.trim() }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setGeminiKeyStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setGeminiApiKey('')
    setGeminiHasKey(true)
    setGeminiKeyStatus('Saved. Gemini API key is persisted on server.')
  }

  async function savePyannoteToken() {
    if (!pyannoteToken.trim()) { setPyannoteTokenStatus('Enter a token first'); return }
    setPyannoteTokenStatus('Saving token...')
    const r = await apiFetch(`${API_BASE}/pyannote/key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pyannoteToken: pyannoteToken.trim() }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setPyannoteTokenStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setPyannoteToken('')
    setPyannoteHasToken(true)
    setPyannoteTokenStatus('Saved. Pyannote token is persisted on server.')
  }

  async function runSqlStorageCheck() {
    if (!activeCampaign?.id) { setSqlStorageStatus('Select a campaign first'); return }
    setSqlStorageStatus('Loading SQLite diagnostics...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/sql-parity`)
    const j = await r.json()
    if (!r.ok || !j.ok) { setSqlStorageStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setSqlStorageReport(j.parity || null)
    setSqlStorageStatus('SQLite diagnostics loaded')
  }

  async function downloadCampaignExport() {
    if (!activeCampaign?.id) { setSqlOpsStatus('Select a campaign first'); return }
    setSqlOpsStatus('Building export...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/export`)
    const j = await r.json()
    if (!r.ok || !j.ok) { setSqlOpsStatus(`Export failed: ${j.error || 'unknown error'}`); return }

    const payload = j.export || {}
    const stamp = new Date(payload.exportedAt || Date.now()).toISOString().replace(/[:.]/g, '-')
    const fileName = `${stamp}-${activeCampaign.id}-export.json`
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)

    setSqlExportInfo({ fileName, exportedAt: payload.exportedAt || Date.now(), bytes: blob.size, mode: 'download' })
    setSqlOpsStatus('Export downloaded')
  }

  async function writeCampaignExportFile() {
    if (!activeCampaign?.id) { setSqlOpsStatus('Select a campaign first'); return }
    setSqlOpsStatus('Writing export file...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeArtifactIndex: true }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setSqlOpsStatus(`Export file failed: ${j.error || 'unknown error'}`); return }
    setSqlExportInfo({ ...(j.exportFile || null), mode: 'server-file' })
    setSqlOpsStatus('Export file written to server')
  }

  async function createCampaignBackup() {
    if (!activeCampaign?.id) { setSqlOpsStatus('Select a campaign first'); return }
    setSqlOpsStatus('Creating SQLite backup...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setSqlOpsStatus(`Backup failed: ${j.error || 'unknown error'}`); return }
    setSqlBackupInfo(j.backup || null)
    setSqlOpsStatus('SQLite backup created')
  }

  return (
    <div className="space-y-6">

      {/* ASR Provider */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">Audio Transcription (ASR) Provider</h2>
        <p className="mt-1 text-sm text-slate-400">Choose how session audio is transcribed to text.</p>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2 items-center">
          <select
            value={asrProvider}
            onChange={(e) => saveAsrProvider(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            <option value="remote">Remote — SSH + Whisper GPU</option>
            <option value="local">Local — Whisper CPU/GPU in container</option>
            <option value="groq">Groq Cloud — free fast API</option>
            <option value="openai">OpenAI Cloud — whisper-1</option>
          </select>
          <div className="text-xs text-slate-400">
            {asrProvider === 'remote' && 'Transcription runs on the remote GPU host via SSH.'}
            {asrProvider === 'local' && 'Runs openai-whisper locally inside the container (CPU/GPU).'}
            {asrProvider === 'groq' && 'Uses Groq\'s free whisper-large-v3 API. Requires a Groq key below.'}
            {asrProvider === 'openai' && 'Uses OpenAI whisper-1 endpoint. Requires an OpenAI key.'}
          </div>
          {asrInfo && (
            <div className="text-xs text-slate-500">
              {asrProvider === 'remote' && asrInfo.remoteHost && <span>Host: {asrInfo.remoteHost}</span>}
              {asrProvider === 'local' && <span>Model: {asrInfo.whisperModel} · Device: {asrInfo.whisperDevice}</span>}
              {asrProvider === 'groq' && <span>Model: {asrInfo.groqModel}</span>}
              {asrProvider === 'openai' && <span>Model: whisper-1</span>}
            </div>
          )}
        </div>
        {asrStatus && <div className="mt-2 text-xs text-amber-300">{asrStatus}</div>}
      </div>

      {/* Groq API Key */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">Groq API Key</h2>
        <div className="mt-1 text-xs text-slate-400">Required when ASR provider is set to Groq. Get a free key at console.groq.com.</div>
        <div className="mt-2">
          {groqHasKey
            ? <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/60 border border-emerald-700 px-2.5 py-0.5 text-xs font-medium text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>Key saved</span>
            : <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-2.5 py-0.5 text-xs text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-slate-600"/>No key stored</span>}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={groqApiKey}
            onChange={(e) => setGroqApiKey(e.target.value)}
            placeholder="gsk_..."
            className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <button onClick={saveGroqKey} className="rounded-xl border border-emerald-700 text-emerald-300 px-4 py-2 text-sm">Save Key</button>
        </div>
        {groqKeyStatus && <div className="mt-2 text-xs text-amber-300">{groqKeyStatus}</div>}
      </div>

      {/* AI Provider */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">AI Provider</h2>
        <p className="mt-1 text-sm text-slate-400">Switch between Ollama, OpenAI, Anthropic, and Google Gemini.</p>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
          <select
            value={llmProvider}
            onChange={(e) => {
              const p = e.target.value
              setLlmProvider(p)
              const opts = llmModelsByProvider[p] || []
              if (opts.length) setLlmModel(opts[0])
            }}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            <option value="ollama">ollama</option>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="gemini">gemini</option>
          </select>
          <select
            value={llmModel}
            onChange={(e) => setLlmModel(e.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            {(llmModelsByProvider[llmProvider] || []).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!(llmModelsByProvider[llmProvider] || []).length && (
              <option value={llmModel}>{llmModel}</option>
            )}
          </select>
          <button onClick={saveLlmConfig} className="rounded-xl border border-amber-700 text-amber-300 px-4 py-2 text-sm">Save LLM</button>
        </div>
        {llmStatus && <div className="mt-2 text-xs text-amber-300">{llmStatus}</div>}
      </div>

      {/* OpenAI Key */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">OpenAI API Key</h2>
        <div className="mt-1 text-xs text-slate-400">Used whenever provider is set to OpenAI (including pipeline in flexible mode).</div>
        <div className="mt-2">
          {pipelineHasKey
            ? <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/60 border border-emerald-700 px-2.5 py-0.5 text-xs font-medium text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>Key saved</span>
            : <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-2.5 py-0.5 text-xs text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-slate-600"/>No key stored</span>}
        </div>
        <div className="mt-3 flex gap-2">
          <input type="password" value={pipelineOpenaiKey} onChange={(e) => setPipelineOpenaiKey(e.target.value)} placeholder="sk-..." className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
          <button onClick={savePipelineKey} className="rounded-xl border border-emerald-700 text-emerald-300 px-4 py-2 text-sm">Save Key</button>
        </div>
        {pipelineKeyStatus && <div className="mt-2 text-xs text-amber-300">{pipelineKeyStatus}</div>}
      </div>

      {/* Anthropic Key */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">Anthropic API Key</h2>
        <div className="mt-1 text-xs text-slate-400">Used when provider is set to anthropic.</div>
        <div className="mt-2">
          {anthropicHasKey
            ? <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/60 border border-emerald-700 px-2.5 py-0.5 text-xs font-medium text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>Key saved</span>
            : <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-2.5 py-0.5 text-xs text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-slate-600"/>No key stored</span>}
        </div>
        <div className="mt-3 flex gap-2">
          <input type="password" value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)} placeholder="sk-ant-..." className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
          <button onClick={saveAnthropicKey} className="rounded-xl border border-emerald-700 text-emerald-300 px-4 py-2 text-sm">Save Key</button>
        </div>
        {anthropicKeyStatus && <div className="mt-2 text-xs text-amber-300">{anthropicKeyStatus}</div>}
      </div>

      {/* Gemini Key */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">Google Gemini API Key</h2>
        <div className="mt-1 text-xs text-slate-400">Used when provider is set to gemini.</div>
        <div className="mt-2">
          {geminiHasKey
            ? <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/60 border border-emerald-700 px-2.5 py-0.5 text-xs font-medium text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>Key saved</span>
            : <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-2.5 py-0.5 text-xs text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-slate-600"/>No key stored</span>}
        </div>
        <div className="mt-3 flex gap-2">
          <input type="password" value={geminiApiKey} onChange={(e) => setGeminiApiKey(e.target.value)} placeholder="AIza..." className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
          <button onClick={saveGeminiKey} className="rounded-xl border border-emerald-700 text-emerald-300 px-4 py-2 text-sm">Save Key</button>
        </div>
        {geminiKeyStatus && <div className="mt-2 text-xs text-amber-300">{geminiKeyStatus}</div>}
      </div>

      {/* Pyannote Token */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-xl font-semibold">Pyannote / Hugging Face Token</h2>
        <div className="mt-1 text-xs text-slate-400">Used when diarization mode is set to pyannote.</div>
        <div className="mt-2">
          {pyannoteHasToken
            ? <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/60 border border-emerald-700 px-2.5 py-0.5 text-xs font-medium text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>Token saved</span>
            : <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-2.5 py-0.5 text-xs text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-slate-600"/>No token stored</span>}
        </div>
        <div className="mt-3 flex gap-2">
          <input type="password" value={pyannoteToken} onChange={(e) => setPyannoteToken(e.target.value)} placeholder="hf_..." className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
          <button onClick={savePyannoteToken} className="rounded-xl border border-emerald-700 text-emerald-300 px-4 py-2 text-sm">Save Token</button>
        </div>
        {pyannoteTokenStatus && <div className="mt-2 text-xs text-amber-300">{pyannoteTokenStatus}</div>}
      </div>

      {/* SQLite Diagnostics */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-xl font-semibold">SQLite Diagnostics</h2>
          <div className="flex flex-wrap justify-end gap-2">
            <button onClick={runSqlStorageCheck} className="rounded-xl border border-sky-700 text-sky-300 px-4 py-2 text-sm">Run Check</button>
            <button onClick={downloadCampaignExport} className="rounded-xl border border-emerald-700 text-emerald-300 px-4 py-2 text-sm">Download Export</button>
            <button onClick={writeCampaignExportFile} className="rounded-xl border border-cyan-700 text-cyan-300 px-4 py-2 text-sm">Write Export File</button>
            <button onClick={createCampaignBackup} className="rounded-xl border border-amber-700 text-amber-300 px-4 py-2 text-sm">Create Backup</button>
          </div>
        </div>
        <div className="mt-1 text-xs text-slate-400">Shows current SQLite-backed counts and hashes for canonical state, trackers, journal, and bard tales.</div>
        {sqlStorageStatus && <div className="mt-2 text-xs text-amber-300">{sqlStorageStatus}</div>}
        {sqlOpsStatus && <div className="mt-2 text-xs text-emerald-300">{sqlOpsStatus}</div>}
        {(sqlExportInfo || sqlBackupInfo) && (
          <div className="mt-3 rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-xs space-y-2">
            {sqlExportInfo && (
              <>
                <div className="text-slate-200">Last export: {sqlExportInfo.fileName || 'unknown file'}</div>
                <div className="text-slate-400">Mode: {sqlExportInfo.mode === 'server-file' ? 'server file' : 'download'}</div>
                {sqlExportInfo.bytes != null && <div className="text-slate-400">Size: {sqlExportInfo.bytes} bytes</div>}
              </>
            )}
            {sqlBackupInfo && (
              <>
                <div className="text-slate-200">Last backup: {sqlBackupInfo.fileName || 'unknown file'}</div>
                {sqlBackupInfo.manifestFileName && <div className="text-slate-400">Manifest: {sqlBackupInfo.manifestFileName}</div>}
                {sqlBackupInfo.bytes != null && <div className="text-slate-400">Size: {sqlBackupInfo.bytes} bytes</div>}
              </>
            )}
          </div>
        )}
        {sqlStorageReport && (
          <div className="mt-3 rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-xs space-y-2">
            <div className={sqlStorageReport.ok ? 'text-emerald-300' : 'text-rose-300'}>Storage mode: {sqlStorageReport.mode || 'unknown'}</div>
            <div>Canonical entities: {sqlStorageReport.canonical?.entityCount ?? 0}</div>
            <div>Canonical aliases: {sqlStorageReport.canonical?.aliasCount ?? 0}</div>
            <div>Canonical tracker rows: {sqlStorageReport.canonical?.trackerCount ?? 0}</div>
            <div>Trackers quest: {sqlStorageReport.trackers?.quest?.count ?? 0}</div>
            <div>Trackers npc: {sqlStorageReport.trackers?.npc?.count ?? 0}</div>
            <div>Trackers place: {sqlStorageReport.trackers?.place?.count ?? 0}</div>
            <div>Journal: {sqlStorageReport.journal?.count ?? 0}</div>
            <div>Bard tales: {sqlStorageReport.bardTales?.count ?? 0}</div>
            <details>
              <summary className="cursor-pointer text-slate-300">Show SQLite hashes</summary>
              <pre className="mt-2 whitespace-pre-wrap text-[11px] text-slate-400">{JSON.stringify(sqlStorageReport, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}
