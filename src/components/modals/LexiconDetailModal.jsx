import { useApp } from '../../AppContext.jsx'

export default function LexiconDetailModal() {
  const {
    detailModal, setDetailModal,
    detailDraft, setDetailDraft,
    detailStatus,
    saveLexiconDetail, deleteLexiconDetail,
    trackerTypeForKind,
  } = useApp()

  if (!detailModal) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xl font-semibold">{detailModal.title}</h3>
          <button onClick={() => setDetailModal(null)} className="rounded-xl border border-slate-700 px-3 py-1 text-sm">Close</button>
        </div>
        <div className="text-sm text-slate-300 space-y-2">
          {detailModal.type === 'lexicon' && (
            <>
              <input value={detailDraft.term} onChange={(e) => setDetailDraft((p) => ({ ...p, term: e.target.value }))} placeholder="Term" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
              <input value={detailDraft.kind} onChange={(e) => setDetailDraft((p) => ({ ...p, kind: e.target.value }))} placeholder="Kind" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
              <input value={detailDraft.role} onChange={(e) => setDetailDraft((p) => ({ ...p, role: e.target.value }))} placeholder="Role" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
              <input value={detailDraft.relation} onChange={(e) => setDetailDraft((p) => ({ ...p, relation: e.target.value }))} placeholder="Relation (optional)" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
              <input value={detailDraft.aliases} onChange={(e) => setDetailDraft((p) => ({ ...p, aliases: e.target.value }))} placeholder="Aliases (comma-separated)" className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
              <textarea value={detailDraft.notes} onChange={(e) => setDetailDraft((p) => ({ ...p, notes: e.target.value }))} placeholder="Notes" className="w-full min-h-24 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
              {trackerTypeForKind(detailDraft.kind) && (
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={!!detailDraft.inTracker} onChange={(e) => setDetailDraft((p) => ({ ...p, inTracker: !!e.target.checked }))} />
                  Show in {trackerTypeForKind(detailDraft.kind)} tracker
                </label>
              )}
              <div className="flex items-center gap-2">
                <button onClick={saveLexiconDetail} className="rounded-xl border border-emerald-700 text-emerald-300 px-3 py-1 text-sm">Save</button>
                <button onClick={deleteLexiconDetail} className="rounded-xl border border-rose-700 text-rose-300 px-3 py-1 text-sm">Delete</button>
                {detailStatus && <span className="text-xs text-amber-300">{detailStatus}</span>}
              </div>
            </>
          )}
          {detailModal.type === 'place' && (
            <>
              <div><span className="text-slate-400">Type:</span> {detailModal.item.type || '—'}</div>
              <div><span className="text-slate-400">Tags:</span> {(detailModal.item.tags || []).join(', ') || '—'}</div>
              <div><span className="text-slate-400">Notes:</span> {detailModal.item.notes || '—'}</div>
            </>
          )}
          {detailModal.type === 'world-ref' && (
            <>
              <div><span className="text-slate-400">Kind:</span> {detailModal.item.kind || '—'}</div>
              <div><span className="text-slate-400">Role:</span> {detailModal.item.raw?.role || '—'}</div>
              <div><span className="text-slate-400">Relation:</span> {detailModal.item.raw?.relation || '—'}</div>
              <div><span className="text-slate-400">Source:</span> {detailModal.item.source || '—'}</div>
              <div><span className="text-slate-400">Aliases/Tags:</span> {(detailModal.item.aliases || []).join(', ') || '—'}</div>
              <div><span className="text-slate-400">Notes:</span> {detailModal.item.notes || '—'}</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
