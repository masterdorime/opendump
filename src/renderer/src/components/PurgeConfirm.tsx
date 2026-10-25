import { useMemo, useState } from 'react'
import type { StagedDetail } from '@shared/executor'
import type { QuarantineItem } from '@shared/executor'
import { baseName, fmtBytes, fmtCount, prettyPath } from '../lib/format'

interface Props {
  items: QuarantineItem[]
  details: StagedDetail[]
  root: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * The last screen before data stops existing.
 *
 * It deliberately answers "what am I destroying?" rather than "how much?" —
 * folder names, real filenames, and a file count you have to acknowledge. The
 * confirm button stays disabled until that acknowledgement is ticked.
 */
export function PurgeConfirm({ items, details, root, busy, onCancel, onConfirm }: Props): React.JSX.Element {
  const [acknowledged, setAcknowledged] = useState(false)

  const byId = useMemo(() => new Map(details.map((d) => [d.id, d])), [details])
  const totalBytes = items.reduce((n, i) => n + i.bytes, 0)
  const totalFiles = details.reduce((n, d) => n + d.fileCount, 0)
  const truncated = details.some((d) => d.truncated)

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal danger-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            Permanently delete {items.length} folder{items.length === 1 ? '' : 's'} ·{' '}
            {fmtBytes(totalBytes)}
          </h2>
          <button className="btn tiny ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>

        <div className="danger-banner">
          This cannot be undone. There is no Recycle Bin copy, no restore point for these files, and
          no way back from this screen.
        </div>

        <div className="purge-summary">
          <div>
            <span className="stat-k">Folders</span>
            <span className="stat-v">{fmtCount(items.length)}</span>
          </div>
          <div>
            <span className="stat-k">Files</span>
            <span className="stat-v">
              {truncated ? `${fmtCount(totalFiles)}+` : fmtCount(totalFiles)}
            </span>
          </div>
          <div>
            <span className="stat-k">Space reclaimed</span>
            <span className="stat-v reclaim">{fmtBytes(totalBytes)}</span>
          </div>
        </div>

        <div className="purge-list">
          {items.map((item) => {
            const detail = byId.get(item.id)
            return (
              <div key={item.id} className="purge-item">
                <div className="purge-item-head">
                  <span className="purge-name">{baseName(item.src)}</span>
                  <span className="muted mono">
                    {detail ? `${fmtCount(detail.fileCount)} files · ` : ''}
                    {fmtBytes(item.bytes)}
                  </span>
                </div>
                <div className="mono ellipsis purge-path" title={item.src}>
                  {prettyPath(item.src, root)}
                </div>
                {detail && detail.topFiles.length > 0 && (
                  <ul className="purge-files">
                    {detail.topFiles.map((f) => (
                      <li key={f.name}>
                        <span className="mono ellipsis">{f.name}</span>
                        <span className="mono muted">{fmtBytes(f.bytes)}</span>
                      </li>
                    ))}
                    {detail.fileCount > detail.topFiles.length && (
                      <li className="purge-more">
                        …and {fmtCount(detail.fileCount - detail.topFiles.length)} more files
                      </li>
                    )}
                  </ul>
                )}
                {detail && detail.fileCount === 0 && (
                  <div className="purge-empty">Nothing left inside — this entry is already empty.</div>
                )}
              </div>
            )
          })}
        </div>

        <label className="purge-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I understand that {truncated ? 'at least ' : ''}
            {fmtCount(totalFiles)} files will be destroyed and cannot be recovered.
          </span>
        </label>

        <div className="modal-foot">
          <span className="muted">Nothing is deleted until you confirm.</span>
          <div className="foot-actions">
            <button className="btn ghost" onClick={onCancel} disabled={busy} autoFocus>
              Cancel
            </button>
            <button className="btn danger" onClick={onConfirm} disabled={busy || !acknowledged}>
              {busy ? 'Deleting…' : `Permanently delete ${fmtBytes(totalBytes)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
