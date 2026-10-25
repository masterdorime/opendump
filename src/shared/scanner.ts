import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { DirEntry, FileEntry, ScanProgress, ScanResult } from './types'

/**
 * Directories that are reparse points / loops and must never be walked.
 * `$Recycle.Bin` is excluded because its contents are already surfaced
 * separately by Windows, and walking it double-counts.
 */
const SKIP_NAMES = new Set(['$recycle.bin', 'system volume information', 'config.msi'])

/**
 * Legacy junction names inside a user profile (Application Data -> AppData\Roaming, etc).
 * Node reports junctions as symlinks, but this is a belt-and-braces guard: if the
 * symlink flag is ever missed, walking these would double-count the entire profile.
 * Scoped to `C:\Users\<name>` so a real project folder called "Templates" is unaffected.
 */
const LEGACY_JUNCTIONS = new Set([
  'application data',
  'documents and settings',
  'local settings',
  'my documents',
  'nethood',
  'printhood',
  'recent',
  'sendto',
  'start menu',
  'templates',
  'cookies',
  'history',
  'temporary internet files'
])

const PROFILE_ROOT = /^[a-z]:\\users\\[^\\]+$/i

/** Files below this size are not recorded individually; they are still counted in totals. */
const TOP_FILE_MIN_BYTES = 100 * 1024 * 1024

/** How many file stats a single directory will have in flight at once. */
const FILE_BATCH = 128

export interface ScanOptions {
  /** Directories read concurrently. 24-48 is the useful range on a single disk. */
  concurrency?: number
  onProgress?: (p: ScanProgress) => void
  signal?: AbortSignal
}

interface Tally {
  bytes: number
  count: number
  mtime: number
  pkg?: boolean
  git?: boolean
}

/**
 * Walk a directory tree and return recursive sizes per directory.
 *
 * Strategy: a flat work queue with bounded concurrency, collecting *direct*
 * file bytes per directory, then a single post-order rollup sorted by path
 * length (a child path is always longer than its parent). This avoids
 * recursive-promise overhead and keeps memory to one small record per
 * directory rather than one per file.
 */
export async function scanDrive(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const concurrency = Math.max(1, Math.min(64, opts.concurrency ?? 32))
  const started = Date.now()

  const direct = new Map<string, Tally>()
  const topFiles: FileEntry[] = []
  const queue: string[] = [root]
  const inFlight = new Set<Promise<void>>()

  let dirsSeen = 0
  let filesSeen = 0
  let bytesSeen = 0
  let skipped = 0
  let lastReport = 0

  const report = (phase: ScanProgress['phase'], current: string, force = false) => {
    if (!opts.onProgress) return
    const now = Date.now()
    if (!force && now - lastReport < 250) return
    lastReport = now
    opts.onProgress({
      phase,
      dirs: dirsSeen,
      files: filesSeen,
      bytes: bytesSeen,
      current,
      elapsedMs: now - started
    })
  }

  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      skipped++
      return
    }

    const tally: Tally = { bytes: 0, count: 0, mtime: 0 }
    const fileJobs: Array<() => Promise<void>> = []

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        skipped++
        continue
      }

      const lower = entry.name.toLowerCase()
      if (lower === 'package.json' && entry.isFile()) tally.pkg = true
      if (lower === '.git' && entry.isDirectory()) tally.git = true

      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_NAMES.has(lower)) {
          skipped++
          continue
        }
        if (LEGACY_JUNCTIONS.has(lower) && PROFILE_ROOT.test(dir)) {
          skipped++
          continue
        }
        queue.push(full)
        continue
      }

      if (!entry.isFile()) continue

      fileJobs.push(async () => {
        try {
          const st = await fs.stat(full)
          tally.bytes += st.size
          tally.count++
          if (st.mtimeMs > tally.mtime) tally.mtime = st.mtimeMs
          if (st.size >= TOP_FILE_MIN_BYTES) {
            topFiles.push({ p: full, s: st.size, m: st.mtimeMs })
          }
        } catch {
          // File vanished or is locked mid-scan; not fatal.
        }
      })
    }

    for (let i = 0; i < fileJobs.length; i += FILE_BATCH) {
      await Promise.all(fileJobs.slice(i, i + FILE_BATCH).map((job) => job()))
    }

    direct.set(dir, tally)
    dirsSeen++
    filesSeen += tally.count
    bytesSeen += tally.bytes
    report('walking', dir)
  }

  const schedule = (dir: string): Promise<void> => {
    const task: Promise<void> = (async () => {
      await visit(dir)
    })().then(() => {
      inFlight.delete(task)
    })
    inFlight.add(task)
    return task
  }

  while (queue.length > 0 || inFlight.size > 0) {
    if (opts.signal?.aborted) throw new Error('Scan aborted')

    while (queue.length > 0 && inFlight.size < concurrency) {
      schedule(queue.pop() as string)
    }

    if (inFlight.size > 0) {
      await Promise.race([...inFlight])
    }
  }

  report('totalling', '', true)

  // Post-order rollup. Sorting by descending path length guarantees every
  // child is folded into its parent before the parent itself is folded up.
  const paths = [...direct.keys()].sort((a, b) => b.length - a.length)
  const totals = new Map<string, Tally>()

  for (const p of paths) {
    const own = direct.get(p) as Tally
    const acc = totals.get(p) ?? { bytes: 0, count: 0, mtime: 0 }
    acc.bytes += own.bytes
    acc.count += own.count
    if (own.mtime > acc.mtime) acc.mtime = own.mtime
    totals.set(p, acc)

    const parent = path.dirname(p)
    if (parent !== p) {
      const up = totals.get(parent) ?? { bytes: 0, count: 0, mtime: 0 }
      up.bytes += acc.bytes
      up.count += acc.count
      if (acc.mtime > up.mtime) up.mtime = acc.mtime
      totals.set(parent, up)
    }
  }

  const dirs: DirEntry[] = paths.map((p) => {
    const t = totals.get(p) as Tally
    const own = direct.get(p) as Tally
    const entry: DirEntry = { p, s: t.bytes, c: t.count, m: Math.round(t.mtime) }
    if (own.pkg) entry.pkg = true
    if (own.git) entry.git = true
    return entry
  })

  topFiles.sort((a, b) => b.s - a.s)

  const result: ScanResult = {
    root,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    totalBytes: totals.get(root)?.bytes ?? 0,
    totalDirs: dirsSeen,
    totalFiles: filesSeen,
    skipped,
    dirs,
    topFiles: topFiles.slice(0, 5000)
  }

  report('done', '', true)
  return result
}

export async function saveScan(result: ScanResult, cachePath: string): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  await fs.writeFile(cachePath, JSON.stringify(result))
}

export async function loadScan(cachePath: string): Promise<ScanResult | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8')
    const parsed = JSON.parse(raw) as ScanResult
    return parsed && Array.isArray(parsed.dirs) ? parsed : null
  } catch {
    return null
  }
}

/** Free / total bytes for a drive letter like `C:`. */
export async function driveSpace(letter: string): Promise<{ free: number; total: number } | null> {
  try {
    const st = await fs.statfs(`${letter.replace(/[\\/]+$/, '')}\\`)
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }
  } catch {
    return null
  }
}
