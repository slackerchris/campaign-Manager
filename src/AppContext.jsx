import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from './lib/api.js'

const AppContext = createContext(null)
const API_BASE = '/api'

export function useApp() {
  return useContext(AppContext)
}

export const BARD_PERSONAS = {
  grandiose: { id: 'grandiose', displayName: 'The Grandiose Lutenist', bardName: 'Milo Thrice-Stabbed' },
  drunken: { id: 'drunken', displayName: 'The Drunken Tavern Fool', bardName: 'Bramble Alebelly' },
  grim: { id: 'grim', displayName: 'The Grim Chronicler', bardName: 'Sister Ash' },
  hymnist: { id: 'hymnist', displayName: 'The Sanctimonious Hymnist', bardName: 'Brother Candlewick' },
  replacement7: { id: 'replacement7', displayName: 'The Replacement Bard #7', bardName: 'Tobble, Last-Minute Hire' },
}

export const BARD_FAITHFULNESS = {
  close: 'Close to the journal',
  dramatic: 'Dramatic retelling',
  performance: 'Full tavern performance',
}

export function AppProvider({ children }) {
  const navigate = useNavigate()

  // ── campaign list ─────────────────────────────────────────────────────────
  const [campaigns, setCampaigns] = useState([])
  const [activeCampaign, setActiveCampaign] = useState(null)

  // ── full campaign state ───────────────────────────────────────────────────
  const [state, setState] = useState({
    npcs: [], quests: [], quotes: [], journal: [], storyJournal: [],
    pcs: [], gameSessions: [], approvals: [], lexicon: [], places: [],
    bardsTales: [], dmSneakPeek: [], dmNotes: '',
    lexiconEntities: [], entityAliases: [], trackerRows: [],
  })

  // ── UI shared state ───────────────────────────────────────────────────────
  const [isMobileView, setIsMobileView] = useState(false)
  const [error, setError] = useState('')
  const [globalMenuOpen, setGlobalMenuOpen] = useState(false)

  // ── per-entity key state ──────────────────────────────────────────────────
  const [pipelineHasKey, setPipelineHasKey] = useState(false)
  const [anthropicHasKey, setAnthropicHasKey] = useState(false)
  const [geminiHasKey, setGeminiHasKey] = useState(false)
  const [pyannoteHasToken, setPyannoteHasToken] = useState(false)
  const [llmProvider, setLlmProvider] = useState('ollama')
  const [llmModel, setLlmModel] = useState('qwen2.5:7b')

  // ── DM notes ─────────────────────────────────────────────────────────────
  const [dmNotesDraft, setDmNotesDraft] = useState('')

  // ── modals ────────────────────────────────────────────────────────────────
  const [editingNpc, setEditingNpc] = useState(null)
  const [editNpc, setEditNpc] = useState({ name: '', role: '', relation: '', update: '' })
  const [editingPc, setEditingPc] = useState(null)
  const [editPc, setEditPc] = useState({ playerName: '', ddbUsername: '', characterName: '', class: '', race: '', level: 1, notes: '' })
  const [showAddPc, setShowAddPc] = useState(false)
  const [newPc, setNewPc] = useState({ playerName: '', ddbUsername: '', characterName: '', class: '', race: '', level: 1, notes: '' })

  const [reviewApproval, setReviewApproval] = useState(null)
  const [reviewTab, setReviewTab] = useState('overview')
  const [reviewJournalDraft, setReviewJournalDraft] = useState('')
  const [reviewSelect, setReviewSelect] = useState({
    npcNames: [], questNames: [], quotes: [],
    includeFullCampaignJournal: true, includeTimeline: true,
    includeSessionRecap: true, includeRunningCampaignLog: true,
  })

  const [detailModal, setDetailModal] = useState(null)
  const [detailDraft, setDetailDraft] = useState({ term: '', kind: '', role: '', relation: '', aliases: '', notes: '', inTracker: false })
  const [detailStatus, setDetailStatus] = useState('')

  const [showAddLexicon, setShowAddLexicon] = useState(false)
  const [newLex, setNewLex] = useState({ term: '', kind: '', role: '', relation: '', aliases: '', notes: '', inTracker: false })

  const [showAddPlace, setShowAddPlace] = useState(false)
  const [newPlace, setNewPlace] = useState({ name: '', type: '', notes: '', tags: '' })

  // ── session selection (shared across DM + pipeline views) ─────────────────
  const [managerSessionId, setManagerSessionId] = useState('')
  const [pipelineSessionId, setPipelineSessionId] = useState('')

  // ── initialisation ────────────────────────────────────────────────────────
  useEffect(() => {
    loadCampaigns()
    loadLlmConfig()
    loadPipelineKeyStatus()
    loadAnthropicKeyStatus()
    loadGeminiKeyStatus()
    loadPyannoteTokenStatus()
  }, [])

  useEffect(() => {
    const detectMobile = () => {
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
      const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(ua)
      const smallViewport = typeof window !== 'undefined' ? window.matchMedia('(max-width: 820px)').matches : false
      setIsMobileView(uaMobile && smallViewport)
    }
    detectMobile()
    window.addEventListener('resize', detectMobile)
    return () => window.removeEventListener('resize', detectMobile)
  }, [])

  // ── helpers ───────────────────────────────────────────────────────────────
  function trackerTypeForKind(kind) {
    const k = String(kind || '').trim().toLowerCase()
    if (k === 'quest') return 'quest'
    if (k === 'npc') return 'npc'
    if (k === 'place') return 'place'
    return null
  }

  function isLexiconItemInTracker(item) {
    const t = trackerTypeForKind(item?.kind)
    if (!t) return false
    return (state.trackerRows || []).some(
      (r) => String(r?.trackerType || '') === t && String(r?.entityId || '') === String(item?.id || ''),
    )
  }

  // ── campaign initialisation (for direct URL navigation) ──────────────────
  async function initCampaign(campaignId) {
    let campaign = campaigns.find((c) => c.id === campaignId)
    if (!campaign) {
      try {
        const r = await apiFetch(`${API_BASE}/campaigns`)
        const j = await r.json()
        if (j.ok) {
          setCampaigns(j.campaigns)
          campaign = j.campaigns.find((c) => c.id === campaignId)
        }
      } catch { /* ignore */ }
    }
    if (!campaign) return
    if (activeCampaign?.id === campaignId) return // already loaded
    setActiveCampaign(campaign)
    await loadCampaignState(campaignId)
  }

  // ── data loading ──────────────────────────────────────────────────────────
  async function loadCampaigns() {
    try {
      const r = await apiFetch(`${API_BASE}/campaigns`)
      const j = await r.json()
      if (j.ok) setCampaigns(j.campaigns)
    } catch { /* ignore network errors at startup */ }
  }

  async function loadLlmConfig() {
    try {
      const r = await apiFetch(`${API_BASE}/llm/config`)
      const j = await r.json()
      if (j.ok) { setLlmProvider(j.provider || 'ollama'); setLlmModel(j.model || '') }
    } catch { /* ignore */ }
  }

  async function loadPipelineKeyStatus() {
    try {
      const r = await apiFetch(`${API_BASE}/pipeline/key`)
      const j = await r.json()
      if (j.ok) setPipelineHasKey(!!j.hasOpenaiKey)
    } catch { /* ignore */ }
  }

  async function loadAnthropicKeyStatus() {
    try {
      const r = await apiFetch(`${API_BASE}/anthropic/key`)
      const j = await r.json()
      if (j.ok) setAnthropicHasKey(!!j.hasAnthropicKey)
    } catch { /* ignore */ }
  }

  async function loadGeminiKeyStatus() {
    try {
      const r = await apiFetch(`${API_BASE}/gemini/key`)
      const j = await r.json()
      if (j.ok) setGeminiHasKey(!!j.hasGeminiKey)
    } catch { /* ignore */ }
  }

  async function loadPyannoteTokenStatus() {
    try {
      const r = await apiFetch(`${API_BASE}/pyannote/key`)
      const j = await r.json()
      if (j.ok) setPyannoteHasToken(!!j.hasPyannoteToken)
    } catch { /* ignore */ }
  }

  async function loadCampaignState(campaignId) {
    try {
      const r = await apiFetch(`${API_BASE}/campaigns/${campaignId}/state`)
      const j = await r.json()
      if (j.ok) {
        setState(j)
        setDmNotesDraft(j.dmNotes || '')
      } else {
        setError(j.error || 'Failed to load campaign state')
      }
    } catch (e) {
      setError(e?.message || 'Failed to load campaign state')
    }
  }

  // ── campaign actions ──────────────────────────────────────────────────────
  async function createCampaign(name) {
    if (!name.trim()) return
    const r = await apiFetch(`${API_BASE}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    })
    const j = await r.json()
    if (j.ok) {
      await loadCampaigns()
      setActiveCampaign(j.campaign)
      await loadCampaignState(j.campaign.id)
      navigate(`/campaigns/${j.campaign.id}`)
    }
  }

  async function selectCampaign(c) {
    setActiveCampaign(c)
    setManagerSessionId('')
    setPipelineSessionId('')
    await loadCampaignState(c.id)
    navigate(`/campaigns/${c.id}`)
  }

  // ── PC actions ────────────────────────────────────────────────────────────
  async function addPc() {
    if (!activeCampaign || !newPc.characterName.trim()) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/pcs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newPc),
    })
    const j = await r.json()
    if (j.ok) {
      setNewPc({ playerName: '', ddbUsername: '', characterName: '', class: '', race: '', level: 1, notes: '' })
      setShowAddPc(false)
      await loadCampaignState(activeCampaign.id)
    }
  }

  function openEditPc(pc) {
    setEditingPc(pc)
    setEditPc({
      playerName: pc.playerName || '',
      ddbUsername: pc.ddbUsername || '',
      characterName: pc.characterName || pc.name || '',
      class: pc.class || '',
      race: pc.race || '',
      level: Number(pc.level || 1),
      notes: pc.notes || '',
    })
  }

  async function saveEditPc() {
    if (!activeCampaign || !editingPc) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/pcs/${editingPc.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editPc),
    })
    const j = await r.json()
    if (j.ok) { setEditingPc(null); await loadCampaignState(activeCampaign.id) }
    else setError(j.error || 'Failed to save PC')
  }

  async function deletePc(pc) {
    if (!activeCampaign || !pc?.id) return
    if (!window.confirm(`Delete ${pc.characterName || pc.name}?`)) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/pcs/${pc.id}`, { method: 'DELETE' })
    const j = await r.json()
    if (!r.ok || !j.ok) { setError(j.error || 'Failed to delete PC'); return }
    await loadCampaignState(activeCampaign.id)
  }

  // ── NPC actions ───────────────────────────────────────────────────────────
  function openEditNpc(npc) {
    setEditingNpc(npc)
    setEditNpc({ name: npc.name || '', role: npc.role || '', relation: npc.relation || '', update: npc.update || '' })
  }

  async function saveEditNpc() {
    if (!activeCampaign || !editingNpc) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/npcs/update`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchName: editingNpc.name, ...editNpc }),
    })
    const j = await r.json()
    if (j.ok) { setEditingNpc(null); await loadCampaignState(activeCampaign.id) }
    else setError(j.error || 'Failed to save NPC')
  }

  // ── Session actions ───────────────────────────────────────────────────────
  async function createGameSession(number, label) {
    if (!activeCampaign || !number.trim()) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: number.trim(), label: label.trim() }),
    })
    const j = await r.json()
    if (j.ok) {
      setManagerSessionId(j.session.id)
      await loadCampaignState(activeCampaign.id)
      return j.session
    } else {
      setError(j.error || 'Failed to create session')
      return null
    }
  }

  async function deleteSelectedSession(sessionId) {
    if (!activeCampaign || !sessionId) return
    const s = (state.gameSessions || []).find((x) => x.id === sessionId)
    if (!window.confirm(`Delete session ${s?.title || sessionId}?`)) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/sessions/${sessionId}`, { method: 'DELETE' })
    const j = await r.json()
    if (!r.ok || !j.ok) { setError(j.error || 'Failed to delete session'); return }
    setManagerSessionId('')
    setPipelineSessionId('')
    await loadCampaignState(activeCampaign.id)
  }

  // ── Lexicon actions ──────────────────────────────────────────────────────
  async function addLexicon() {
    if (!activeCampaign || !newLex.term.trim()) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/lexicon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        term: newLex.term, kind: newLex.kind, role: newLex.role, relation: newLex.relation,
        aliases: newLex.aliases.split(',').map((x) => x.trim()).filter(Boolean),
        notes: newLex.notes, inTracker: !!newLex.inTracker,
      }),
    })
    const j = await r.json()
    if (j.ok) {
      setNewLex({ term: '', kind: '', role: '', relation: '', aliases: '', notes: '', inTracker: false })
      setShowAddLexicon(false)
      await loadCampaignState(activeCampaign.id)
    }
  }

  function openLexiconDetail(item) {
    setDetailModal({ type: 'lexicon', title: item?.term || 'Lexicon Term', item })
    setDetailDraft({
      term: String(item?.term || ''), kind: String(item?.kind || ''),
      role: String(item?.role || ''), relation: String(item?.relation || ''),
      aliases: Array.isArray(item?.aliases) ? item.aliases.join(', ') : '',
      notes: String(item?.notes || ''), inTracker: isLexiconItemInTracker(item),
    })
    setDetailStatus('')
  }

  async function saveLexiconDetail() {
    if (!activeCampaign || !detailModal?.item?.id) return
    setDetailStatus('Saving...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/lexicon/${detailModal.item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        term: detailDraft.term, kind: detailDraft.kind, role: detailDraft.role, relation: detailDraft.relation,
        aliases: detailDraft.aliases.split(',').map((x) => x.trim()).filter(Boolean),
        notes: detailDraft.notes, inTracker: !!detailDraft.inTracker,
      }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setDetailStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setDetailStatus('Saved')
    await loadCampaignState(activeCampaign.id)
    openLexiconDetail(j.term)
  }

  async function deleteLexiconDetail() {
    if (!activeCampaign || !detailModal?.item?.id) return
    const term = String(detailModal?.item?.term || 'this term').trim()
    if (!window.confirm(`Delete lexicon term "${term}"?`)) return
    setDetailStatus('Deleting...')
    let r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/lexicon/${detailModal.item.id}`, { method: 'DELETE' })
    let j = await r.json()
    if (r.status === 409) {
      const force = window.confirm('This term has linked tracker rows. Delete it and remove linked rows too?')
      if (!force) { setDetailStatus('Delete canceled'); return }
      r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/lexicon/${detailModal.item.id}?force=true`, { method: 'DELETE' })
      j = await r.json()
    }
    if (!r.ok || !j.ok) { setDetailStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setDetailStatus('Deleted')
    setDetailModal(null)
    await loadCampaignState(activeCampaign.id)
  }

  // ── Place actions ─────────────────────────────────────────────────────────
  async function addPlace() {
    if (!activeCampaign || !newPlace.name.trim()) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/places`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newPlace.name, type: newPlace.type, notes: newPlace.notes,
        tags: newPlace.tags.split(',').map((x) => x.trim()).filter(Boolean),
      }),
    })
    const j = await r.json()
    if (j.ok) {
      setNewPlace({ name: '', type: '', notes: '', tags: '' })
      setShowAddPlace(false)
      await loadCampaignState(activeCampaign.id)
    }
  }

  // ── DM Notes ─────────────────────────────────────────────────────────────
  async function saveDmNotes() {
    if (!activeCampaign) return
    await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/dm-notes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: dmNotesDraft }),
    })
    await loadCampaignState(activeCampaign.id)
  }

  // ── Approvals ─────────────────────────────────────────────────────────────
  async function handleApproval(id, action) {
    if (!activeCampaign) return
    await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/approvals/${id}/${action}`, { method: 'POST' })
    await loadCampaignState(activeCampaign.id)
  }

  function openApprovalReview(a) {
    setReviewApproval(a)
    setReviewTab('overview')
    setReviewJournalDraft(String(a.fullCampaignJournal || a.journal || ''))
    setReviewSelect({
      npcNames: (a.npcUpdates || []).map((n) => n.name).filter(Boolean),
      questNames: (a.questUpdates || []).map((q) => q.name).filter(Boolean),
      quotes: (a.quotes || []).map((q) => (typeof q === 'string' ? q : q?.text)).filter(Boolean),
      includeFullCampaignJournal: true, includeTimeline: true,
      includeSessionRecap: true, includeRunningCampaignLog: true,
    })
  }

  async function approveSelectedFromReview() {
    if (!activeCampaign || !reviewApproval) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/approvals/${reviewApproval.id}/approve-selected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...reviewSelect, editedFullCampaignJournal: reviewJournalDraft }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setError(j.error || 'Approve selected failed'); return }
    setReviewApproval(null)
    await loadCampaignState(activeCampaign.id)
  }

  async function approveAllFromReview() {
    if (!activeCampaign || !reviewApproval) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/approvals/${reviewApproval.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editedFullCampaignJournal: reviewJournalDraft }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setError(j.error || 'Approve all failed'); return }
    setReviewApproval(null)
    await loadCampaignState(activeCampaign.id)
  }

  // ── D&D Beyond sync ───────────────────────────────────────────────────────
  async function importDndbCharacter(characterInput, setStatus) {
    if (!activeCampaign || !characterInput.trim()) return
    setStatus('Syncing from D&D Beyond...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/pcs/import-dndbeyond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: characterInput.trim() }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Sync failed: ${j.error || 'unknown error'}`); return null }
    setStatus(`Synced ${j.pc?.characterName || 'character'} successfully.`)
    await loadCampaignState(activeCampaign.id)
    return j.pc
  }

  async function linkPcToDdb(pc, setStatus) {
    if (!activeCampaign || !pc?.id) return
    const raw = window.prompt('Paste D&D Beyond character URL or ID', pc.ddbCharacterId || '')
    if (!raw) return
    setStatus(`Linking ${pc.characterName || pc.name}...`)
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/pcs/${pc.id}/link-dndbeyond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: raw }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Link failed for ${pc.characterName || pc.name}: ${j.error || 'unknown error'}`); return }
    setStatus(`Linked ${pc.characterName || pc.name} to D&D Beyond ID ${j.pc?.ddbCharacterId || ''}.`)
    await loadCampaignState(activeCampaign.id)
  }

  async function syncPcFromDdb(pc, setStatus) {
    if (!activeCampaign || !pc?.id) return
    setStatus(`Syncing ${pc.characterName || pc.name}...`)
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/pcs/${pc.id}/sync-dndbeyond`, { method: 'POST' })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Sync failed for ${pc.characterName || pc.name}: ${j.error || 'unknown error'}`); return }
    setStatus(`Synced ${pc.characterName || pc.name} successfully.`)
    await loadCampaignState(activeCampaign.id)
  }

  // ── Module PDF ────────────────────────────────────────────────────────────
  async function importModulePdf(file, setImporting, onError) {
    if (!activeCampaign || !file) return
    setImporting(true)
    onError('')
    try {
      const form = new FormData()
      form.append('module', file)
      const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/module-pdf`, { method: 'POST', body: form })
      const j = await r.json()
      if (!r.ok || !j.ok) { onError(j.error || 'Module import failed'); return }
      await loadCampaignState(activeCampaign.id)
    } finally {
      setImporting(false)
    }
  }

  // ── DM Sneak Peek ─────────────────────────────────────────────────────────
  async function addDmSneakPeekItem(text, dueTag, setStatus) {
    if (!activeCampaign || !text.trim()) { setStatus('Add a note first'); return }
    setStatus('Saving...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/dm-sneak-peek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim(), dueTag: dueTag.trim() }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setStatus('Saved')
    await loadCampaignState(activeCampaign.id)
  }

  async function toggleDmSneakPeekItem(item, setStatus) {
    if (!activeCampaign || !item?.id) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/dm-sneak-peek/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: !item.done }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) setStatus?.(`Failed: ${j.error || 'unknown error'}`)
    else await loadCampaignState(activeCampaign.id)
  }

  async function deleteDmSneakPeekItem(item, setStatus) {
    if (!activeCampaign || !item?.id) return
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/dm-sneak-peek/${item.id}`, { method: 'DELETE' })
    const j = await r.json()
    if (!r.ok || !j.ok) setStatus?.(`Failed: ${j.error || 'unknown error'}`)
    else await loadCampaignState(activeCampaign.id)
  }

  // ── Data Browser ──────────────────────────────────────────────────────────
  async function runDataBrowserImport(params, setStatus) {
    if (!activeCampaign) { setError('Pick campaign first'); return }
    setStatus('Running import...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/data-browser/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) {
      setStatus('Import failed.')
      setError(j.error || 'Data Browser import failed')
      return
    }
    const imported = j.imported || {}
    setStatus(`Done (${j.mode}). NPCs: ${imported.npcs || 0}, Lexicon: ${imported.lexicon || 0}, Places: ${imported.places || 0}`)
    await loadCampaignState(activeCampaign.id)
  }

  // ── Bard's Tale ───────────────────────────────────────────────────────────
  async function saveBardsTale(journalEntry, tale, bardTitle, bardName, personaId, faithfulness, journalDraft, setStatus) {
    if (!activeCampaign || !journalEntry || !String(tale || '').trim()) return
    setStatus('Saving tale...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/bards-tales`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        journalEntryId: journalEntry.id, journalEntryTitle: journalEntry.title,
        title: journalEntry.title, bardTitle, bardName, personaId, faithfulness,
        promptVersion: 'bard-v1',
        sourceLength: String(journalDraft || journalEntry.markdown || '').length,
        journal: journalDraft || journalEntry.markdown || '', tale,
      }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Failed to save: ${j.error || 'unknown error'}`); return }
    setStatus('Tale saved.')
    await loadCampaignState(activeCampaign.id)
  }

  async function deleteSavedBardsTale(entry, setStatus) {
    if (!activeCampaign || !entry?.id) return
    if (!window.confirm("Delete this saved Bard's Tale?")) return
    setStatus('Deleting tale...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/bards-tales/${entry.id}`, { method: 'DELETE' })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setStatus('Tale deleted.')
    await loadCampaignState(activeCampaign.id)
  }

  // ── Player contributions ──────────────────────────────────────────────────
  async function submitPlayerContribution(params, setStatus) {
    setStatus('Submitting...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/player-submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Failed: ${j.error || 'unknown error'}`); return false }
    setStatus('Submitted')
    await loadCampaignState(activeCampaign.id)
    return true
  }

  async function addPlayerQuoteDirect(params, setStatus) {
    setStatus('Adding...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/player-quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Failed: ${j.error || 'unknown error'}`); return false }
    if (j.duplicate) { setStatus('Duplicate quote — already in vault'); return false }
    setStatus('Quote added directly to vault')
    await loadCampaignState(activeCampaign.id)
    return true
  }

  // ── Journal ───────────────────────────────────────────────────────────────
  async function saveJournalEdit(entryId, markdown, setStatus) {
    if (!activeCampaign || !entryId) return
    setStatus('Saving...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/journal/${entryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown }),
    })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setStatus('Saved')
    await loadCampaignState(activeCampaign.id)
  }

  async function deleteJournalEntry(entryId, setStatus, onDeleted) {
    if (!activeCampaign || !entryId) return
    if (!window.confirm('Delete this journal entry?')) return
    setStatus('Deleting...')
    const r = await apiFetch(`${API_BASE}/campaigns/${activeCampaign.id}/journal/${entryId}`, { method: 'DELETE' })
    const j = await r.json()
    if (!r.ok || !j.ok) { setStatus(`Failed: ${j.error || 'unknown error'}`); return }
    setStatus('Deleted')
    onDeleted?.()
    await loadCampaignState(activeCampaign.id)
  }

  const value = {
    // state
    campaigns, activeCampaign, state, isMobileView, error, setError,
    globalMenuOpen, setGlobalMenuOpen,
    pipelineHasKey, anthropicHasKey, geminiHasKey, pyannoteHasToken,
    llmProvider, setLlmProvider, llmModel, setLlmModel,
    dmNotesDraft, setDmNotesDraft,
    editingNpc, setEditingNpc, editNpc, setEditNpc,
    editingPc, setEditingPc, editPc, setEditPc,
    showAddPc, setShowAddPc, newPc, setNewPc,
    reviewApproval, setReviewApproval, reviewTab, setReviewTab,
    reviewJournalDraft, setReviewJournalDraft,
    reviewSelect, setReviewSelect,
    detailModal, setDetailModal, detailDraft, setDetailDraft, detailStatus, setDetailStatus,
    showAddLexicon, setShowAddLexicon, newLex, setNewLex,
    showAddPlace, setShowAddPlace, newPlace, setNewPlace,
    managerSessionId, setManagerSessionId,
    pipelineSessionId, setPipelineSessionId,
    // helpers
    trackerTypeForKind, isLexiconItemInTracker,
    // actions
    loadCampaigns, loadCampaignState, loadLlmConfig, initCampaign,
    loadPipelineKeyStatus, loadAnthropicKeyStatus, loadGeminiKeyStatus, loadPyannoteTokenStatus,
    createCampaign, selectCampaign,
    addPc, openEditPc, saveEditPc, deletePc,
    openEditNpc, saveEditNpc,
    createGameSession, deleteSelectedSession,
    addLexicon, openLexiconDetail, saveLexiconDetail, deleteLexiconDetail,
    addPlace, saveDmNotes,
    handleApproval, openApprovalReview, approveSelectedFromReview, approveAllFromReview,
    importDndbCharacter, linkPcToDdb, syncPcFromDdb,
    importModulePdf,
    addDmSneakPeekItem, toggleDmSneakPeekItem, deleteDmSneakPeekItem,
    runDataBrowserImport,
    saveBardsTale, deleteSavedBardsTale,
    submitPlayerContribution, addPlayerQuoteDirect,
    saveJournalEdit, deleteJournalEntry,
    setPipelineHasKey, setAnthropicHasKey, setGeminiHasKey, setPyannoteHasToken,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
