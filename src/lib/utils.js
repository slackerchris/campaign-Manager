export function fmtEta(sec) {
  if (!sec && sec !== 0) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m ? `${m}m ${s}s` : `${s}s`
}

export function formatJournalMarkdown(markdown) {
  const raw = String(markdown || '').trim()
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const lines = parsed
        .map((x) => (typeof x === 'string' ? x : x?.entry || x?.text || ''))
        .map((x) => String(x).trim())
        .filter(Boolean)
      if (lines.length) return lines.map((l) => `• ${l}`).join('\n')
    }
  } catch {
    // keep raw if not JSON
  }
  return raw
}

export function gameSessionDisplayCount(gameSessions = []) {
  if (!Array.isArray(gameSessions) || gameSessions.length === 0) return 0
  const nums = gameSessions
    .map((s) => String(s?.title || '').trim())
    .map((t) => {
      if (/^\d+$/.test(t)) return Number(t)
      const m = t.match(/session\s*(\d+)/i)
      if (m) return Number(m[1])
      const anyNum = t.match(/(\d+)/)
      return anyNum ? Number(anyNum[1]) : null
    })
    .filter((n) => Number.isFinite(n))
  return nums.length ? Math.max(...nums) : gameSessions.length
}

export function recapBulletsFromJournal(journalEntries = []) {
  if (!Array.isArray(journalEntries) || journalEntries.length === 0) return []
  const latest = journalEntries[journalEntries.length - 1]
  const text = formatJournalMarkdown(latest?.markdown || '')
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^[-•\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 5)
}

export function importSummaryFromApproval(approval) {
  if (!approval || approval.sourceType !== 'data-browser') return []
  const raw = String(approval.journal || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((x) => (typeof x === 'string' ? x : x?.entry || x?.text || ''))
      .map((x) => String(x).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function speakerIdsFromTranscript(text = '') {
  const ids = new Set()
  String(text || '')
    .split('\n')
    .forEach((line) => {
      const m = line.match(/^(S\d+|U)\s+\d{2}:\d{2}\s+/)
      if (m) ids.add(m[1])
    })
  return Array.from(ids)
}

export function relabelSpeakerTranscript(text = '', speakerMap = {}) {
  return String(text || '')
    .split('\n')
    .map((line) => {
      const m = line.match(/^(S\d+|U)(\s+\d{2}:\d{2}\s+.*)$/)
      if (!m) return line
      const label = speakerMap[m[1]] || m[1]
      return `${label}${m[2]}`
    })
    .join('\n')
}

export function sortedSessionsFromState(gameSessions = []) {
  return (gameSessions || []).slice().sort((a, b) => {
    const na = Number(String(a?.title || '').match(/\d+/)?.[0] || 0)
    const nb = Number(String(b?.title || '').match(/\d+/)?.[0] || 0)
    return na - nb
  })
}
