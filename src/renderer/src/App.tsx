import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppState, Candidate, ScanProgress, Tier, TreeNode } from '@shared/types'
import type { BatchResult, QuarantineItem } from '@shared/executor'
import { Treemap } from './components/Treemap'
import { PlanModal } from './components/PlanModal'
import { QuarantineView } from './components/QuarantineView'
import { AiPanel } from './components/AiPanel'
import { TourOverlay } from './components/TourOverlay'
import type { SystemStats } from '@shared/system'
import { memoryPressure } from '@shared/system'
import { baseName, fmtBytes, fmtCount, fmtRelative, prettyPath } from './lib/format'

const TIER_LABEL: Record<Tier, string> = {
  SAFE_PURGE: 'Safe',
  REVIEW: 'Review',
  KEEP: 'Keep',
  LOCKED: 'Locked'
}

const TIER_BLURB: Record<Tier, string> = {
  SAFE_PURGE: 'Rebuilds itself. Safe to remove.',
  REVIEW: 'Needs your judgement before removal.',
  KEEP: 'Your data, or a folder holding data. Not removable here.',
  LOCKED: 'System-critical. Cannot be selected.'
}

const TIER_RANK: Record<Tier, number> = { SAFE_PURGE: 0, REVIEW: 1, KEEP: 2, LOCKED: 3 }

function resultSummary(r: BatchResult): string {
  const n = (s: string): number => r.items.filter((i) => i.status === s).length
  if (n('quarantined')) return `Quarantined ${n('quarantined')} folders`
  if (n('restored')) return `Restored ${n('restored')} folders`
  if (n('purged')) return `Permanently deleted ${n('purged')} folders · ${fmtBytes(r.bytes)} freed`
  return 'Nothing changed'
}

function findNode(node: TreeNode | null, path: string): TreeNode | null {
  if (!node) return null
  if (node.path.toLowerCase() === path.toLowerCase()) return node
  for (const child of node.children) {
    const hit = findNode(child, path)
    if (hit) return hit
  }
  return null
}

function chainTo(node: TreeNode | null, path: string): TreeNode[] {
  if (!node) return []
  if (node.path.toLowerCase() === path.toLowerCase()) return [node]
  for (const child of node.children) {
    const tail = chainTo(child, path)
    if (tail.length) return [node, ...tail]
  }
  return []
}

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [view, setView] = useState<'map' | 'review' | 'quarantine'>(() => {
    const v = new URLSearchParams(window.location.search).get('view')
    return v === 'review' || v === 'quarantine' ? v : 'map'
  })
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [tierFilter, setTierFilter] = useState<'ALL' | Tier>('ALL')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [planOpen, setPlanOpen] = useState(false)
  const [quarantineItems, setQuarantineItems] = useState<QuarantineItem[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BatchResult | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [tutorialOpen, setTutorialOpen] = useState(false)
  const [scanNotice, setScanNotice] = useState<string | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)

  useEffect(() => {
    let alive = true
    window.dsa
      .getState()
      .then((s) => {
        if (!alive) return
        setState(s)
        if (s.tree) setFocusPath(s.tree.path)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    return window.dsa.onProgress((p) => setProgress(p))
  }, [])

  // First run: show the guide once. Afterwards it lives behind the “?” button.
  useEffect(() => {
    void window.dsa.uiStateGet().then((s) => {
      if (!s.tutorialSeen) setTutorialOpen(true)
    })
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const next = await window.dsa.systemStats()
      if (alive) setStats(next)
    }
    void tick()
    const id = setInterval(() => void tick(), 4000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const refreshQuarantine = useCallback(async () => {
    setQuarantineItems(await window.dsa.listQuarantine())
  }, [])

  useEffect(() => {
    void refreshQuarantine()
  }, [refreshQuarantine])

  const refreshAll = useCallback(async () => {
    setState(await window.dsa.getState())
    await refreshQuarantine()
  }, [refreshQuarantine])

  const doRestore = useCallback(
    async (ids: string[]) => {
      setBusy(true)
      try {
        setResult(await window.dsa.restore(ids))
        await refreshAll()
      } finally {
        setBusy(false)
      }
    },
    [refreshAll]
  )

  const doPurge = useCallback(
    async (ids: string[]) => {
      setBusy(true)
      try {
        setResult(await window.dsa.purge(ids))
        await refreshAll()
      } finally {
        setBusy(false)
      }
    },
    [refreshAll]
  )

  const runScan = useCallback(async () => {
    setScanning(true)
    setProgress(null)
    try {
      const s = await window.dsa.runScan()
      setState(s)
      setFocusPath(s.tree?.path ?? null)
      setPicked(new Set())
      if (s.meta) {
        setScanNotice(
          `Scan finished in ${Math.round(s.meta.durationMs / 1000)}s — ${fmtCount(
            s.meta.totalDirs
          )} folders, ${fmtBytes(s.meta.totalBytes)}`
        )
        window.setTimeout(() => setScanNotice(null), 9000)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setScanning(false)
      setProgress(null)
    }
  }, [])

  const tree = state?.tree ?? null
  const candidates = state?.candidates ?? []

  const focusNode = useMemo(() => {
    if (!tree) return null
    return findNode(tree, focusPath ?? tree.path) ?? tree
  }, [tree, focusPath])

  const chain = useMemo(() => {
    if (!tree || !focusNode) return []
    return chainTo(tree, focusNode.path)
  }, [tree, focusNode])

  const selectedCandidate = useMemo(
    () => candidates.find((c) => c.path === selectedPath) ?? null,
    [candidates, selectedPath]
  )

  const filtered = useMemo(() => {
    const base = tierFilter === 'ALL' ? candidates : candidates.filter((c) => c.tier === tierFilter)
    return [...base].sort((a, b) => {
      if (tierFilter === 'ALL') {
        const rank = TIER_RANK[a.tier] - TIER_RANK[b.tier]
        if (rank !== 0) return rank
      }
      return b.size - a.size
    })
  }, [candidates, tierFilter])

  const [shown, setShown] = useState(250)
  useEffect(() => setShown(250), [tierFilter])
  const visible = useMemo(() => filtered.slice(0, shown), [filtered, shown])

  const selectedCandidates = useMemo(
    () => candidates.filter((c) => picked.has(c.path)),
    [candidates, picked]
  )

  const selectedBytes = selectedCandidates.reduce((n, c) => n + c.size, 0)

  const doQuarantine = useCallback(async () => {
    if (selectedCandidates.length === 0) return
    setBusy(true)
    try {
      const res = await window.dsa.quarantine(
        selectedCandidates.map((c) => ({ path: c.path, tier: c.tier, ruleId: c.ruleId, size: c.size }))
      )
      setResult(res)
      setPlanOpen(false)
      setPicked(new Set())
      await refreshAll()
      setView('quarantine')
    } catch (err) {
      console.error(err)
    } finally {
      setBusy(false)
    }
  }, [selectedCandidates, refreshAll])

  const toggle = useCallback((c: Candidate) => {
    if (c.tier === 'KEEP' || c.tier === 'LOCKED') return
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(c.path)) next.delete(c.path)
      else next.add(c.path)
      return next
    })
  }, [])

  const countByTier = useMemo(() => {
    const acc: Record<string, { n: number; bytes: number }> = {}
    for (const c of candidates) {
      acc[c.tier] = acc[c.tier] ?? { n: 0, bytes: 0 }
      acc[c.tier].n++
      acc[c.tier].bytes += c.size
    }
    return acc
  }, [candidates])

  const usedPct = state?.space ? ((state.space.total - state.space.free) / state.space.total) * 100 : 0
  const heldCount = quarantineItems.filter((i) => i.status === 'quarantined').length

  // A real percentage needs a denominator. Used bytes at scan start is close
  // enough to be useful, and it gives way to an exact 100% when the walk ends.
  const scanPct = useMemo(() => {
    if (!progress) return null
    if (progress.phase === 'totalling' || progress.phase === 'done') return 100
    if (!progress.usedBytes || progress.usedBytes <= 0) return null
    return Math.min(99, (progress.bytes / progress.usedBytes) * 100)
  }, [progress])

  const scanEta = useMemo(() => {
    if (!progress) return 'starting…'
    if (progress.phase === 'totalling') return 'finishing up…'
    if (!progress.usedBytes || progress.elapsedMs < 1500) return 'estimating…'
    const rate = progress.bytes / progress.elapsedMs
    if (rate <= 0) return 'estimating…'
    const remainingMs = Math.max(0, progress.usedBytes - progress.bytes) / rate
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'almost done…'
    const seconds = Math.round(remainingMs / 1000)
    return seconds >= 60 ? `~${Math.floor(seconds / 60)}m ${seconds % 60}s left` : `~${seconds}s left`
  }, [progress])

  const scanLabel =
    progress?.phase === 'totalling'
      ? 'Finishing up'
      : progress?.phase === 'done'
        ? 'Done'
        : 'Scanning'

  if (loading) {
    return (
      <div className="boot">
        <div className="boot-mark">opendump</div>
        <div className="boot-sub">Reading cache…</div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">od</div>
          <div className="brand-text">
            <h1>opendump</h1>
            <p>
              {state?.meta
                ? `${state.meta.root.replace(/\\$/, '')} · ${fmtBytes(state.meta.totalBytes)} across ${fmtCount(
                    state.meta.totalDirs
                  )} folders · scanned ${fmtRelative(state.meta.scannedAt)}`
                : 'No scan yet — start one to map the drive.'}
            </p>
          </div>
        </div>

        <nav className="segmented" aria-label="View" data-tour="nav">
          <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>
            Map
          </button>
          <button className={view === 'review' ? 'on' : ''} onClick={() => setView('review')} data-tour="nav-review">
            Review
            {candidates.length > 0 && <span className="pill">{candidates.length}</span>}
          </button>
          <button className={view === 'quarantine' ? 'on' : ''} onClick={() => setView('quarantine')}>
            Quarantine
            {heldCount > 0 && <span className="pill">{heldCount}</span>}
          </button>
        </nav>

        <div className="space">
          {state?.space && (
            <>
              <div className="space-line">
                <strong>{fmtBytes(state.space.free)}</strong> free of {fmtBytes(state.space.total)}
              </div>
              <div className="meter" title={`${usedPct.toFixed(1)}% used`}>
                <i style={{ width: `${usedPct}%` }} />
              </div>
              {stats && (
                <div
                  className={`ram-chip p-${memoryPressure(stats.ramFreeBytes)}`}
                  title="Free system RAM. Local AI needs about 1.5 GB of headroom."
                >
                  <i />
                  {fmtBytes(stats.ramFreeBytes)} RAM free
                </div>
              )}
            </>
          )}
        </div>

        <div className="actions">
          <button
            className="btn ghost help"
            onClick={() => setTutorialOpen(true)}
            title="How opendump works"
          >
            ?
          </button>
          <button className="btn ghost" onClick={() => window.dsa.openRules()} title="Open rules.json" data-tour="rules">
            Rules
          </button>
          <button className="btn primary" onClick={runScan} disabled={scanning} data-tour="scan">
            {scanning ? 'Scanning…' : state?.meta ? 'Rescan' : 'Scan drive'}
          </button>
        </div>
      </header>

      {scanning && (
        <div className="scanbar">
          <div className="scanbar-main">
            <div className="scanbar-row">
              <div className="scanbar-pulse" />
              <strong>{scanLabel}</strong>
              <span className="mono scanbar-pct">
                {scanPct === null ? '—' : `${scanPct >= 99 ? 100 : Math.round(scanPct)}%`}
              </span>
              <span className="scanbar-eta">{scanEta}</span>
              <span className="mono scanbar-counts">
                {progress
                  ? `${fmtCount(progress.dirs)} folders · ${fmtCount(progress.files)} files · ${fmtBytes(
                      progress.bytes
                    )}`
                  : ''}
              </span>
            </div>
            <div className={`scan-progress ${scanPct === null ? 'indeterminate' : ''}`}>
              <i style={scanPct === null ? undefined : { width: `${scanPct}%` }} />
            </div>
          </div>
          <div className="scanbar-path">{progress?.current ?? ''}</div>
        </div>
      )}

      <main className="body">
        {view === 'quarantine' ? (
          <QuarantineView
            items={quarantineItems}
            root={state?.meta?.root ?? 'C:\\'}
            busy={busy}
            onRestore={doRestore}
            onPurge={doPurge}
          />
        ) : !tree ? (
          <div className="empty">
            <div className="empty-card">
              <h2>Nothing indexed yet</h2>
              <p>
                The first scan walks the whole drive once. Results are cached, so every later open is
                instant.
              </p>
              <button className="btn primary lg" onClick={runScan} disabled={scanning}>
                Scan {state?.drive ?? 'this drive'}
              </button>
            </div>
          </div>
        ) : view === 'map' ? (
          <div className="map-layout">
            <section className="map-col">
              <div className="crumbs">
                {chain.map((n) => (
                  <button
                    key={n.path}
                    className="crumb"
                    onClick={() => {
                      setFocusPath(n.path)
                      setSelectedPath(n.path)
                    }}
                  >
                    {n.name}
                  </button>
                ))}
              </div>
              <Treemap
                root={focusNode ?? tree}
                selectedPath={selectedPath}
                onPick={(n) => {
                  setSelectedPath(n.path)
                  if (n.children.length === 0) {
                    const cand = candidates.find((c) => c.path === n.path)
                    if (cand) setView('review')
                  }
                }}
                onDrill={(n) => setFocusPath(n.path)}
              />
              <div className="legend">
                {(['SAFE_PURGE', 'REVIEW', 'KEEP', 'LOCKED'] as Tier[]).map((t) => (
                  <span key={t} className={`legend-item t-${t}`}>
                    <i /> {TIER_LABEL[t]}
                  </span>
                ))}
                <span className="legend-item t-none">
                  <i /> Unclassified
                </span>
              </div>
            </section>

            <aside className="inspector">
              {focusNode && (
                <>
                  <div className="ins-head">
                    <div>
                      <h2>{focusNode.name}</h2>
                      <p className="mono ellipsis" title={focusNode.path}>
                        {focusNode.path}
                      </p>
                    </div>
                    {focusPath !== tree.path && (
                      <button
                        className="btn tiny"
                        onClick={() => {
                          const parent = focusNode.path.slice(0, focusNode.path.lastIndexOf('\\'))
                          setFocusPath(parent.length <= 3 ? tree.path : parent)
                        }}
                      >
                        Up
                      </button>
                    )}
                  </div>

                  <div className="stat-row">
                    <div>
                      <span className="stat-k">Size</span>
                      <span className="stat-v">{fmtBytes(focusNode.size)}</span>
                    </div>
                    {state?.space && (
                      <div>
                        <span className="stat-k">Of drive</span>
                        <span className="stat-v">
                          {((focusNode.size / state.space.total) * 100).toFixed(1)}%
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="children">
                    {focusNode.children.length === 0 && <p className="muted">No subfolders above the display threshold.</p>}
                    {focusNode.children.map((child) => (
                      <button
                        key={child.path}
                        className="child-row"
                        onClick={() => {
                          setFocusPath(child.path)
                          setSelectedPath(child.path)
                        }}
                      >
                        <span className={`dot t-${child.tier ?? 'none'}`} />
                        <span className="child-name">{child.name}</span>
                        <span className="child-size mono">{fmtBytes(child.size)}</span>
                      </button>
                    ))}
                  </div>

                  <div className="insp-foot">
                    <button className="btn tiny ghost" onClick={() => window.dsa.reveal(focusNode.path)}>
                      Reveal in Explorer
                    </button>
                  </div>
                </>
              )}
            </aside>
          </div>
        ) : (
          <div className="review-layout">
            <div className="review-toolbar">
              <div className="chips" data-tour="tiers">
                <button
                  className={`chip ${tierFilter === 'ALL' ? 'on' : ''}`}
                  onClick={() => setTierFilter('ALL')}
                >
                  All <b>{candidates.length}</b>
                </button>
                {(['SAFE_PURGE', 'REVIEW', 'KEEP', 'LOCKED'] as Tier[]).map((t) => (
                  <button
                    key={t}
                    className={`chip t-${t} ${tierFilter === t ? 'on' : ''}`}
                    onClick={() => setTierFilter(t)}
                  >
                    {TIER_LABEL[t]} <b>{countByTier[t]?.n ?? 0}</b>
                    <em>{fmtBytes(countByTier[t]?.bytes ?? 0)}</em>
                  </button>
                ))}
              </div>
              <div className="toolbar-actions">
                <button className="btn tiny ghost" onClick={() => setAiOpen(true)} data-tour="ai">
                  Local AI
                  {state && state.unclassified > 0 && (
                    <span className="pill">{fmtCount(state.unclassified)}</span>
                  )}
                </button>
                <button
                  className="btn tiny ghost"
                  onClick={() => {
                    const safe = candidates.filter((c) => c.tier === 'SAFE_PURGE')
                    setPicked(new Set(safe.map((c) => c.path)))
                  }}
                >
                  Select all safe
                </button>
              </div>
            </div>

            <div className="review-list">
              {visible.map((c) => {
                const checked = picked.has(c.path)
                const disabled = c.tier === 'KEEP' || c.tier === 'LOCKED'
                return (
                  <div
                    key={c.path}
                    className={`row ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} ${
                      selectedPath === c.path ? 'active' : ''
                    }`}
                    onClick={() => setSelectedPath(c.path)}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(c)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${c.path}`}
                    />
                    <span className={`dot t-${c.tier}`} />
                    <div className="row-main">
                      <div className="row-title">
                        <span className="row-name">{baseName(c.path)}</span>
                        <span className={`tag t-${c.tier}`}>{TIER_LABEL[c.tier]}</span>
                        {c.blocked && <span className="tag warn">holds {fmtBytes(c.blockedBytes)} protected</span>}
                      </div>
                      <div className="row-sub mono ellipsis">{prettyPath(c.path, state?.meta?.root ?? 'C:\\')}</div>
                      {selectedPath === c.path && (
                        <div className="row-why">
                          <span className="why-k">{c.category}</span> — {c.reason}
                          {c.impact && <div className="why-impact">If removed: {c.impact}</div>}
                          {c.blocked && (
                            <ul className="why-list">
                              {c.blockedBy.map((b) => (
                                <li key={b} className="mono">
                                  {prettyPath(b, state?.meta?.root ?? 'C:\\')}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="row-size mono">{fmtBytes(c.size)}</div>
                  </div>
                )
              })}
              {filtered.length > visible.length && (
                <button className="show-more" onClick={() => setShown((n) => n + 500)}>
                  Show 500 more · {fmtCount(filtered.length - visible.length)} remaining
                </button>
              )}
            </div>

            <div className="review-footer">
              <div>
                <strong>{selectedCandidates.length}</strong> selected ·{' '}
                <strong className="reclaim">{fmtBytes(selectedBytes)}</strong> reclaimable
              </div>
              <div className="foot-actions">
                <button className="btn ghost" onClick={() => setPicked(new Set())} disabled={!picked.size}>
                  Clear
                </button>
                <button
                  className="btn primary"
                  disabled={!picked.size || busy}
                  onClick={() => setPlanOpen(true)}
                  data-tour="quarantine"
                >
                  Quarantine selected
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {planOpen && (
        <PlanModal
          items={selectedCandidates}
          root={state?.meta?.root ?? 'C:\\'}
          busy={busy}
          onClose={() => setPlanOpen(false)}
          onConfirm={doQuarantine}
        />
      )}

      {aiOpen && (
        <AiPanel
          unclassified={state?.unclassified ?? 0}
          onClose={() => setAiOpen(false)}
          onApplied={(next) => {
            setState(next)
            setPicked(new Set())
          }}
        />
      )}

      {tutorialOpen && (
        <TourOverlay
          onFinish={() => {
            setTutorialOpen(false)
            void window.dsa.uiStateSet({ tutorialSeen: true })
          }}
        />
      )}

      {scanNotice && (
        <div className="result-toast scan" role="status">
          <div className="result-main">
            <strong>{scanNotice}</strong>
            <span>Ready to review — nothing has been removed.</span>
          </div>
          <button className="btn tiny ghost" onClick={() => setScanNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {result && (
        <div className="result-toast" role="status">
          <div className="result-main">
            <strong>{resultSummary(result)}</strong>
            <span>
              {result.items.filter((i) => i.status === 'skipped' || i.status === 'refused').length}{' '}
              skipped
              {result.bytes > 0 ? ` · ${fmtBytes(result.bytes)}` : ''}
            </span>
          </div>
          <button className="btn tiny ghost" onClick={() => setResult(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
