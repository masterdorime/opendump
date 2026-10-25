import { useMemo } from 'react'
import type { Candidate } from '@shared/types'
import { baseName, fmtBytes, prettyPath } from '../lib/format'

interface Props {
  items: Candidate[]
  root: string
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}

interface Group {
  category: string
  items: Candidate[]
  bytes: number
}

const PREVIEW_PER_GROUP = 4

/**
 * Grouping is not cosmetic. A "select all safe" batch is typically 90 folders
 * that are 85 tiny `__pycache__` directories and 5 multi-gigabyte caches.
 * Flat, the user sees a wall of 1 MB rows and never notices where the space
 * actually is.
 */
export function PlanModal({ items, root, busy, onClose, onConfirm }: Props): React.JSX.Element {
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>()
    for (const c of items) {
      const group = map.get(c.category) ?? { category: c.category, items: [], bytes: 0 }
      group.items.push(c)
      group.bytes += c.size
      map.set(c.category, group)
    }
    for (const g of map.values()) g.items.sort((a, b) => b.size - a.size)
    return [...map.values()].sort((a, b) => b.bytes - a.bytes)
  }, [items])

  const total = items.reduce((n, c) => n + c.size, 0)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Quarantine {items.length} folders</h2>
          <button className="btn tiny ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <p className="modal-sub">
          They will be <strong>moved</strong> to a holding folder on this drive — instantly, without
          copying — and can be restored with one click until you purge. Nothing is deleted in this step.
        </p>

        <div className="plan-list">
          {groups.map((g) => (
            <div className="plan-group" key={g.category}>
              <div className="plan-group-head">
                <span>{g.category}</span>
                <span className="mono">
                  {g.items.length} · {fmtBytes(g.bytes)}
                </span>
              </div>
              {g.items.slice(0, PREVIEW_PER_GROUP).map((c) => (
                <div key={c.path} className="plan-row">
                  <span className={`dot t-${c.tier}`} />
                  <span className="mono ellipsis" title={c.path}>
                    {prettyPath(c.path, root)}
                  </span>
                  <span className="mono">{fmtBytes(c.size)}</span>
                </div>
              ))}
              {g.items.length > PREVIEW_PER_GROUP && (
                <div className="plan-more">
                  + {g.items.length - PREVIEW_PER_GROUP} more ·{' '}
                  {fmtBytes(g.items.slice(PREVIEW_PER_GROUP).reduce((n, c) => n + c.size, 0))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="modal-foot">
          <span className="muted">{fmtBytes(total)} total</span>
          <div className="foot-actions">
            <button className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={onConfirm} disabled={busy || items.length === 0}>
              {busy ? 'Moving…' : `Quarantine ${items.length} folders · ${fmtBytes(total)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
