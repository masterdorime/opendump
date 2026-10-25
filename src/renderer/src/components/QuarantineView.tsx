import { useMemo, useState } from 'react'
import type { QuarantineItem, StagedDetail } from '@shared/executor'
import { baseName, fmtBytes, prettyPath } from '../lib/format'
import { PurgeConfirm } from './PurgeConfirm'

interface Props {
  items: QuarantineItem[]
  root: string
  busy: boolean
  onRestore: (ids: string[]) => void
  onPurge: (ids: string[]) => void
}

const STATUS_LABEL: Record<QuarantineItem['status'], string> = {
  quarantined: 'Staged',
  restored: 'Restored',
  purged: 'Purged',
  missing: 'Missing',
  interrupted: 'Interrupted'
}

export function QuarantineView({ items, root, busy, onRestore, onPurge }: Props): React.JSX.Element {
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)
  const [details, setDetails] = useState<StagedDetail[]>([])
  const [preparing, setPreparing] = useState(false)

  const batches = useMemo(() => {
    const map = new Map<string, QuarantineItem[]>()
    for (const item of items) {
      const list = map.get(item.batch) ?? []
      list.push(item)
      map.set(item.batch, list)
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [items])

  const staged = items.filter((i) => i.status === 'quarantined' || i.status === 'missing')
  const stagedBytes = staged.reduce((n, i) => n + i.bytes, 0)
  const recoverable = staged.filter((i) => i.status === 'quarantined')
  const ids = recoverable.map((i) => i.id)

  const askPurge = async (target: string[]): Promise<void> => {
    setPreparing(true)
    try {
      const inspected = await window.dsa.inspectQuarantine(target)
      setDetails(inspected)
      setConfirmIds(target)
    } finally {
      setPreparing(false)
    }
  }

  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="empty-card">
          <h2>Nothing in quarantine</h2>
          <p>
            Pick folders in <strong>Review</strong> and choose “Quarantine”. They land here, still on
            disk and restorable, until you decide to purge.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="quar-layout">
      <div className="quar-head">
        <div>
          <h2>Quarantine</h2>
          <p>
            {recoverable.length} folders staged · <strong>{fmtBytes(stagedBytes)}</strong> held. Space
            is reclaimed when you purge, not when you stage.
          </p>
        </div>
        <div className="foot-actions">
          <button className="btn ghost" disabled={busy || !ids.length} onClick={() => onRestore(ids)}>
            Restore all
          </button>
          <button
            className="btn danger"
            disabled={busy || preparing || !ids.length}
            onClick={() => void askPurge(ids)}
          >
            {preparing ? 'Reading contents…' : `Permanently delete all · ${fmtBytes(stagedBytes)}`}
          </button>
        </div>
      </div>

      <div className="quar-list">
        {batches.map(([batch, list]) => (
          <div key={batch} className="quar-batch">
            <div className="quar-batch-head">
              <span className="mono">{batch}</span>
              <span className="muted">
                {list.length} item{list.length === 1 ? '' : 's'} ·{' '}
                {fmtBytes(list.reduce((n, i) => n + i.bytes, 0))}
              </span>
            </div>
            {list.map((item) => (
              <div key={item.id} className={`quar-row s-${item.status}`}>
                <span className={`chip-status s-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                <div className="quar-main">
                  <div className="row-name">{baseName(item.src)}</div>
                  <div className="mono ellipsis row-sub">{prettyPath(item.src, root)}</div>
                </div>
                <span className="mono quar-size">{fmtBytes(item.bytes)}</span>
                <div className="row-actions">
                  <button
                    className="btn tiny ghost"
                    disabled={busy || item.status !== 'quarantined'}
                    onClick={() => onRestore([item.id])}
                  >
                    Restore
                  </button>
                  <button
                    className="btn tiny danger"
                    disabled={busy || preparing || item.status !== 'quarantined'}
                    onClick={() => void askPurge([item.id])}
                  >
                    Delete…
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {confirmIds && (
        <PurgeConfirm
          items={items.filter((i) => confirmIds.includes(i.id))}
          details={details}
          root={root}
          busy={busy}
          onCancel={() => setConfirmIds(null)}
          onConfirm={() => {
            const target = confirmIds
            setConfirmIds(null)
            onPurge(target)
          }}
        />
      )}
    </div>
  )
}
