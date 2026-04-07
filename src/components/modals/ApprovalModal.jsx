import { useApp } from '../../AppContext.jsx'

export default function ApprovalModal() {
  const {
    reviewApproval, setReviewApproval,
    reviewTab, setReviewTab,
    reviewJournalDraft, setReviewJournalDraft,
    reviewSelect, setReviewSelect,
    isMobileView,
    handleApproval, approveSelectedFromReview, approveAllFromReview,
  } = useApp()

  if (!reviewApproval) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3">
      <div className={`w-full ${isMobileView ? 'h-[100dvh] rounded-none p-3' : 'h-[92vh] rounded-2xl p-4'} border border-slate-700 bg-slate-900 flex flex-col`}>
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
          <div>
            <div className="text-lg font-semibold">Approval Review</div>
            <div className="text-xs text-slate-400">{reviewApproval.gameSessionTitle} • {reviewApproval.sourceLabel}</div>
          </div>
          <button onClick={() => setReviewApproval(null)} className="rounded-lg border border-slate-600 px-3 py-1 text-sm">Close</button>
        </div>

        <div className={`mt-2 flex ${isMobileView ? 'overflow-x-auto whitespace-nowrap' : 'flex-wrap'} gap-2 text-xs`}>
          {[
            { id: 'overview', label: 'Overview' },
            { id: 'transcript', label: 'Transcript' },
            { id: 'full-journal', label: 'Full Journal' },
            { id: 'timeline', label: 'Timeline' },
            { id: 'quotes', label: 'Quotes' },
            { id: 'quest-tracker', label: 'Quest Tracker' },
            { id: 'npc-tracker', label: 'NPC Tracker' },
            { id: 'session-recap', label: 'Session Recap' },
            { id: 'running-log', label: 'Running Log' },
            { id: 'changes', label: 'Changes' },
          ].map(({ id, label }) => (
            <button key={id} onClick={() => setReviewTab(id)} className={`rounded-lg border px-2 py-1 ${reviewTab === id ? 'border-amber-500 text-amber-300' : 'border-slate-700'}`}>{label}</button>
          ))}
        </div>

        <div className="mt-3 flex-1 overflow-auto rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm">
          {reviewTab === 'overview' && (
            <div className="space-y-1">
              <div>Status: {reviewApproval.status}</div>
              <div>Source: {reviewApproval.sourceType || 'source'}</div>
              <div>Created: {reviewApproval.createdAt ? new Date(reviewApproval.createdAt).toLocaleString() : ''}</div>
              <div>NPC updates: {(reviewApproval.npcUpdates || []).length}</div>
              <div>Quest updates: {(reviewApproval.questUpdates || []).length}</div>
              <div>Quotes: {(reviewApproval.quotes || []).length}</div>
              <div>Lexicon adds: {(reviewApproval.lexiconAdds || []).length}</div>
              <div>Place adds: {(reviewApproval.placeAdds || []).length}</div>
              {(reviewApproval.extractionFallback || (
                !(reviewApproval.journal || '').trim()
                && !(reviewApproval.npcUpdates || []).length
                && !(reviewApproval.questUpdates || []).length
                && !(reviewApproval.quotes || []).length
              )) && (
                <div className="mt-2 rounded-lg border border-amber-700/60 bg-amber-950/20 p-2 text-amber-200">
                  Structured extraction returned little/no content. Review transcript directly.
                </div>
              )}
            </div>
          )}
          {reviewTab === 'transcript' && (
            <pre className="whitespace-pre-wrap text-xs">{reviewApproval.cleanedTranscript || reviewApproval.transcript || 'No transcript'}</pre>
          )}
          {reviewTab === 'full-journal' && (
            <div className="space-y-2">
              <div className="text-xs text-slate-400">Editable — this text will be used if you approve.</div>
              <textarea
                value={reviewJournalDraft}
                onChange={(e) => setReviewJournalDraft(e.target.value)}
                className="w-full min-h-72 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs whitespace-pre-wrap"
              />
            </div>
          )}
          {reviewTab === 'timeline' && (
            <div className="space-y-1 text-xs">
              {(reviewApproval.timeline || []).map((t, i) => <div key={`tl-${i}`}>{i + 1}. {String(t || '')}</div>)}
              {(!reviewApproval.timeline || reviewApproval.timeline.length === 0) && <div className="text-slate-500">No timeline items</div>}
            </div>
          )}
          {reviewTab === 'quotes' && (
            <div className="space-y-1 text-xs">
              {(reviewApproval.quotes || []).map((q, i) => {
                const text = String(typeof q === 'string' ? q : q?.text || '').trim()
                return <div key={`qt-${i}`}>• {text}</div>
              })}
              {(!reviewApproval.quotes || reviewApproval.quotes.length === 0) && <div className="text-slate-500">No quotes</div>}
            </div>
          )}
          {reviewTab === 'quest-tracker' && (
            <div className="space-y-2 text-xs">
              {(reviewApproval.questUpdates || []).map((q, i) => (
                <div key={`qq-${i}`} className="rounded border border-slate-700 p-2">
                  <div className="font-medium">{q.name || `quest-${i}`}</div>
                  <div>Status: {q.status || 'Pending'}</div>
                  <div>Objective: {q.objective || 'Unknown'}</div>
                  <div>Reward: {q.reward || 'Unknown'}</div>
                  <div>Update: {q.update || ''}</div>
                  {Array.isArray(q.leads) && q.leads.length > 0 && <div>Leads: {q.leads.join(' | ')}</div>}
                </div>
              ))}
              {(!reviewApproval.questUpdates || reviewApproval.questUpdates.length === 0) && <div className="text-slate-500">No quest tracker updates</div>}
            </div>
          )}
          {reviewTab === 'npc-tracker' && (
            <div className="space-y-2 text-xs">
              {(reviewApproval.npcUpdates || []).map((n, i) => (
                <div key={`nn-${i}`} className="rounded border border-slate-700 p-2">
                  <div className="font-medium">{n.name || `npc-${i}`}</div>
                  <div>Role: {n.role || 'Unknown'}</div>
                  <div>Relation: {n.relation || 'Unknown'}</div>
                  <div>Notes: {n.notes || ''}</div>
                </div>
              ))}
              {(!reviewApproval.npcUpdates || reviewApproval.npcUpdates.length === 0) && <div className="text-slate-500">No NPC tracker updates</div>}
            </div>
          )}
          {reviewTab === 'session-recap' && (
            <pre className="whitespace-pre-wrap text-xs">{String(reviewApproval.sessionRecap || '').trim() || 'No session recap'}</pre>
          )}
          {reviewTab === 'running-log' && (
            <div className="space-y-1 text-xs">
              {(reviewApproval.runningCampaignLog || []).map((x, i) => <div key={`rl-${i}`}>• {String(x || '')}</div>)}
              {(!reviewApproval.runningCampaignLog || reviewApproval.runningCampaignLog.length === 0) && <div className="text-slate-500">No running campaign log entries</div>}
            </div>
          )}
          {reviewTab === 'changes' && (
            <div className="space-y-4 text-xs">
              <div>
                <div className="text-slate-300 mb-1">Section Includes (Approve Selected)</div>
                <div className="space-y-1">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={!!reviewSelect.includeFullCampaignJournal} onChange={(e) => setReviewSelect((prev) => ({ ...prev, includeFullCampaignJournal: e.target.checked }))} /><span>Full Campaign Journal</span></label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={!!reviewSelect.includeTimeline} onChange={(e) => setReviewSelect((prev) => ({ ...prev, includeTimeline: e.target.checked }))} /><span>Timeline</span></label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={!!reviewSelect.includeSessionRecap} onChange={(e) => setReviewSelect((prev) => ({ ...prev, includeSessionRecap: e.target.checked }))} /><span>Session Recap</span></label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={!!reviewSelect.includeRunningCampaignLog} onChange={(e) => setReviewSelect((prev) => ({ ...prev, includeRunningCampaignLog: e.target.checked }))} /><span>Running Campaign Log</span></label>
                </div>
              </div>
              <div>
                <div className="text-slate-300 mb-1">NPCs</div>
                <div className="space-y-1">
                  {(reviewApproval.npcUpdates || []).map((n, i) => {
                    const name = n.name || `npc-${i}`
                    const checked = reviewSelect.npcNames.includes(name)
                    return (
                      <label key={`${name}-${i}`} className="flex items-center gap-2">
                        <input type="checkbox" checked={checked} onChange={(e) => setReviewSelect((prev) => ({ ...prev, npcNames: e.target.checked ? [...prev.npcNames, name] : prev.npcNames.filter((x) => x !== name) }))} />
                        <span>{name}</span>
                      </label>
                    )
                  })}
                  {(reviewApproval.npcUpdates || []).length === 0 && <div className="text-slate-500">none</div>}
                </div>
              </div>
              <div>
                <div className="text-slate-300 mb-1">Quests</div>
                <div className="space-y-1">
                  {(reviewApproval.questUpdates || []).map((q, i) => {
                    const name = q.name || `quest-${i}`
                    const checked = reviewSelect.questNames.includes(name)
                    return (
                      <label key={`${name}-${i}`} className="flex items-center gap-2">
                        <input type="checkbox" checked={checked} onChange={(e) => setReviewSelect((prev) => ({ ...prev, questNames: e.target.checked ? [...prev.questNames, name] : prev.questNames.filter((x) => x !== name) }))} />
                        <span>{name}</span>
                      </label>
                    )
                  })}
                  {(reviewApproval.questUpdates || []).length === 0 && <div className="text-slate-500">none</div>}
                </div>
              </div>
              <div>
                <div className="text-slate-300 mb-1">Quotes</div>
                <div className="space-y-1">
                  {(reviewApproval.quotes || []).map((q, i) => {
                    const text = String(typeof q === 'string' ? q : q?.text || '').trim() || `quote-${i}`
                    const checked = reviewSelect.quotes.includes(text)
                    return (
                      <label key={`${text}-${i}`} className="flex items-start gap-2">
                        <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => setReviewSelect((prev) => ({ ...prev, quotes: e.target.checked ? [...prev.quotes, text] : prev.quotes.filter((x) => x !== text) }))} />
                        <span>{text}</span>
                      </label>
                    )
                  })}
                  {(reviewApproval.quotes || []).length === 0 && <div className="text-slate-500">none</div>}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-3 flex gap-2 justify-end border-t border-slate-800 pt-2">
          <button onClick={async () => { await handleApproval(reviewApproval.id, 'reject'); setReviewApproval(null) }} disabled={reviewApproval.status !== 'pending'} className="rounded-lg border border-rose-600 px-3 py-1 text-sm disabled:opacity-40">Reject</button>
          <button onClick={approveSelectedFromReview} disabled={reviewApproval.status !== 'pending'} className="rounded-lg border border-amber-600 px-3 py-1 text-sm disabled:opacity-40">Approve Selected</button>
          <button onClick={approveAllFromReview} disabled={reviewApproval.status !== 'pending'} className="rounded-lg border border-emerald-600 px-3 py-1 text-sm disabled:opacity-40">Approve All</button>
        </div>
      </div>
    </div>
  )
}
