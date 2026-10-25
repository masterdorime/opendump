import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { Tier } from './types'

export interface ExecItem {
  path: string
  tier: Tier
  ruleId: string
  size: number
}

export interface ExecOptions {
  /** Staging root. Must be on the same volume as the items — moves are renames, not copies. */
  quarantineRoot: string
  /**
   * Optional per-item staging root. Returning a root on the item's own volume is
   * what lets the tool clean a second drive: the default single root lives on
   * the system volume, so a `D:` item would otherwise be refused as cross-volume.
   */
  quarantineRootFor?: (srcPath: string) => string
  journalPath: string
  batchId?: string
  now?: () => Date
}

export type ExecStatus = 'quarantined' | 'restored' | 'purged' | 'skipped' | 'refused'

export interface ExecResultItem {
  path: string
  dst?: string
  status: ExecStatus
  reason?: string
  bytes: number
}

export interface BatchResult {
  batch: string
  items: ExecResultItem[]
  bytes: number
}

export type QuarantineStatus = 'quarantined' | 'restored' | 'purged' | 'missing' | 'interrupted'

export interface QuarantineItem {
  id: string
  src: string
  dst: string
  bytes: number
  batch: string
  ts: string
  status: QuarantineStatus
}

interface BeginEntry {
  op: 'begin'
  batch: string
  ts: string
  items: Array<{ id: string; src: string; dst: string; bytes: number }>
}

interface MoveEntry {
  op: 'quarantine' | 'restore' | 'purge'
  id: string
  ref?: string
  batch: string
  ts: string
  src: string
  dst?: string
  bytes: number
  status: 'ok' | 'failed'
  reason?: string
}

type JournalEntry = BeginEntry | MoveEntry

const PROTECTED: ReadonlySet<Tier> = new Set<Tier>(['KEEP', 'LOCKED'])

function isDriveRoot(p: string): boolean {
  return /^[a-z]:[\\/]?$/i.test(p)
}

function normalise(p: string): string {
  const resolved = path.resolve(p)
  return resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved
}

function isInside(child: string, parent: string): boolean {
  const c = normalise(child).toLowerCase()
  const p = normalise(parent).toLowerCase()
  return c === p || c.startsWith(p + path.sep.toLowerCase())
}

/**
 * Where a given source path will be staged.
 *
 * The original absolute path is mirrored beneath the batch folder, including the
 * drive letter, so a restore is a mechanical reverse-mapping and two files with
 * the same name from different folders can never collide.
 */
export function stagedPathFor(quarantineRoot: string, batchId: string, src: string): string {
  const parsed = path.parse(path.resolve(src))
  const drive = parsed.root.replace(/[\\/:]/g, '') || 'root'
  const segments = src
    .slice(parsed.root.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  return path.join(quarantineRoot, batchId, drive, ...segments)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

/** Never clobber an existing staged folder: `cache`, `cache (2)`, `cache (3)` … */
async function uniqueDestination(desired: string): Promise<string> {
  if (!(await exists(desired))) return desired
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired} (${i})`
    if (!(await exists(candidate))) return candidate
  }
  throw new Error(`Could not find a free destination for ${desired}`)
}

async function appendJournal(journalPath: string, entry: JournalEntry): Promise<void> {
  await fs.mkdir(path.dirname(journalPath), { recursive: true })
  await fs.appendFile(journalPath, JSON.stringify(entry) + '\n', 'utf8')
}

async function readJournal(journalPath: string): Promise<JournalEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(journalPath, 'utf8')
  } catch {
    return []
  }
  const out: JournalEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as JournalEntry)
    } catch {
      // A torn final line from a hard crash is skipped, not fatal.
    }
  }
  return out
}

function newBatchId(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('')
}

/**
 * Move approved folders into quarantine.
 *
 * Nothing is deleted. A same-volume move is a rename: instant, and it needs no
 * free space, which is what makes it usable on a drive that is already full.
 */
export async function quarantine(items: ExecItem[], opts: ExecOptions): Promise<BatchResult> {
  const now = opts.now?.() ?? new Date()
  const batch = opts.batchId ?? newBatchId(now)
  const results: ExecResultItem[] = []
  const rootFor = opts.quarantineRootFor ?? ((_src: string): string => opts.quarantineRoot)

  const planned = items.map((item) => ({
    id: randomUUID(),
    src: item.path,
    dst: stagedPathFor(rootFor(item.path), batch, item.path),
    bytes: item.size
  }))

  // Journal the intent before touching the filesystem. If the process dies
  // mid-batch, the next launch can tell that these items were *meant* to move.
  await appendJournal(opts.journalPath, {
    op: 'begin',
    batch,
    ts: now.toISOString(),
    items: planned
  })

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const plan = planned[i]
    const base = { path: item.path, bytes: item.size }

    if (PROTECTED.has(item.tier)) {
      results.push({ ...base, status: 'refused', reason: `${item.tier} folders cannot be quarantined` })
      continue
    }
    if (isDriveRoot(item.path)) {
      results.push({ ...base, status: 'refused', reason: 'Refusing to move a drive root' })
      continue
    }
    if (isInside(item.path, opts.quarantineRoot) || isInside(item.path, rootFor(item.path))) {
      results.push({ ...base, status: 'refused', reason: 'Path is inside the quarantine folder' })
      continue
    }

    // A move must be a rename. Across volumes it would silently become a copy,
    // consuming the free space this tool exists to reclaim.
    const srcRoot = path.parse(path.resolve(item.path)).root.toLowerCase()
    const dstRoot = path.parse(path.resolve(rootFor(item.path))).root.toLowerCase()
    if (srcRoot !== dstRoot) {
      results.push({
        ...base,
        status: 'refused',
        reason: `Quarantine is on ${dstRoot} but this item is on ${srcRoot}. Cross-drive moves would copy, not rename.`
      })
      continue
    }

    let stat
    try {
      stat = await fs.lstat(item.path)
    } catch {
      results.push({ ...base, status: 'skipped', reason: 'Path no longer exists' })
      continue
    }
    if (stat.isSymbolicLink()) {
      results.push({ ...base, status: 'refused', reason: 'Symbolic links and junctions are not moved' })
      continue
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      results.push({ ...base, status: 'skipped', reason: 'Not a file or folder' })
      continue
    }

    let dst: string
    try {
      dst = await uniqueDestination(plan.dst)
    } catch (err) {
      results.push({ ...base, status: 'skipped', reason: String(err) })
      continue
    }

    try {
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.rename(item.path, dst)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
      const reason =
        code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
          ? 'In use by another program — close it and retry'
          : `${code}: ${(err as Error).message}`
      await appendJournal(opts.journalPath, {
        op: 'quarantine',
        id: plan.id,
        batch,
        ts: new Date().toISOString(),
        src: item.path,
        dst,
        bytes: item.size,
        status: 'failed',
        reason
      })
      results.push({ ...base, status: 'skipped', reason })
      continue
    }

    await appendJournal(opts.journalPath, {
      op: 'quarantine',
      id: plan.id,
      batch,
      ts: new Date().toISOString(),
      src: item.path,
      dst,
      bytes: item.size,
      status: 'ok'
    })
    results.push({ ...base, status: 'quarantined', dst })
  }

  return { batch, items: results, bytes: results.filter((r) => r.status === 'quarantined').reduce((n, r) => n + r.bytes, 0) }
}

/** Replay the journal into the current state of every staged item. */
export async function listQuarantine(journalPath: string): Promise<QuarantineItem[]> {
  const entries = await readJournal(journalPath)

  const planned = new Map<string, { src: string; dst: string; bytes: number; batch: string }>()
  const quarantined = new Map<string, { entry: MoveEntry; ok: boolean }>()

  for (const entry of entries) {
    if (entry.op === 'begin') {
      for (const item of entry.items) {
        planned.set(item.id, { ...item, batch: entry.batch })
      }
      continue
    }
    if (entry.op === 'quarantine') {
      quarantined.set(entry.id, { entry, ok: entry.status === 'ok' })
    }
  }

  const outcomes = new Map<string, { status: QuarantineStatus; ts: string }>()
  for (const entry of entries) {
    if (entry.op === 'restore' || entry.op === 'purge') {
      if (entry.status !== 'ok' || !entry.ref) continue
      outcomes.set(entry.ref, {
        status: entry.op === 'restore' ? 'restored' : 'purged',
        ts: entry.ts
      })
    }
  }

  const items: QuarantineItem[] = []

  for (const [id, move] of quarantined) {
    if (!move.ok) continue
    const outcome = outcomes.get(id)
    const item: QuarantineItem = {
      id,
      src: move.entry.src,
      dst: move.entry.dst ?? '',
      bytes: move.entry.bytes,
      batch: move.entry.batch,
      ts: move.entry.ts,
      status: outcome?.status ?? 'quarantined'
    }
    if (item.status === 'quarantined' && !(await exists(item.dst))) {
      item.status = 'missing'
    }
    items.push(item)
  }

  // A planned move that never produced a result means the process died mid-batch.
  const finished = new Set<string>([...quarantined.keys(), ...outcomes.keys()])
  for (const [id, plan] of planned) {
    if (finished.has(id)) continue
    items.push({
      id,
      src: plan.src,
      dst: plan.dst,
      bytes: plan.bytes,
      batch: plan.batch,
      ts: '',
      status: 'interrupted'
    })
  }

  return items.sort((a, b) => a.ts.localeCompare(b.ts))
}

export interface JournalOptions {
  journalPath: string
}

/** Put quarantined folders back exactly where they came from. */
export async function restore(ids: string[], opts: JournalOptions): Promise<BatchResult> {
  const all = await listQuarantine(opts.journalPath)
  const byId = new Map(all.map((i) => [i.id, i]))
  const results: ExecResultItem[] = []

  for (const id of ids) {
    const item = byId.get(id)
    if (!item || item.status !== 'quarantined') {
      results.push({
        path: item?.src ?? id,
        status: 'skipped',
        reason: item ? `Item is ${item.status}` : 'Unknown item',
        bytes: item?.bytes ?? 0
      })
      continue
    }
    if (!(await exists(item.dst))) {
      results.push({ path: item.src, status: 'skipped', reason: 'Staged copy is missing', bytes: item.bytes })
      continue
    }
    if (await exists(item.src)) {
      results.push({
        path: item.src,
        status: 'skipped',
        reason: 'Something already exists at the original path',
        bytes: item.bytes
      })
      continue
    }

    try {
      await fs.mkdir(path.dirname(item.src), { recursive: true })
      await fs.rename(item.dst, item.src)
    } catch (err) {
      const reason = (err as Error).message
      await appendJournal(opts.journalPath, {
        op: 'restore',
        id: randomUUID(),
        ref: id,
        batch: item.batch,
        ts: new Date().toISOString(),
        src: item.src,
        dst: item.dst,
        bytes: item.bytes,
        status: 'failed',
        reason
      })
      results.push({ path: item.src, status: 'skipped', reason, bytes: item.bytes })
      continue
    }

    await appendJournal(opts.journalPath, {
      op: 'restore',
      id: randomUUID(),
      ref: id,
      batch: item.batch,
      ts: new Date().toISOString(),
      src: item.src,
      dst: item.dst,
      bytes: item.bytes,
      status: 'ok'
    })
    results.push({ path: item.src, status: 'restored', bytes: item.bytes })
  }

  return { batch: 'restore', items: results, bytes: results.filter((r) => r.status === 'restored').reduce((n, r) => n + r.bytes, 0) }
}

export interface StagedDetail {
  id: string
  src: string
  bytes: number
  fileCount: number
  topFiles: Array<{ name: string; bytes: number }>
  /** True when the folder was too large to enumerate fully. */
  truncated: boolean
}

const MAX_FILES_SCANNED = 20000
const TOP_FILES_KEPT = 5

/**
 * Read what is actually inside a staged folder before offering to destroy it.
 *
 * "Permanently delete 5.5 GB" is not a reminder — it is a number. This returns
 * the file count and the largest real filenames so the confirmation can say what
 * is about to stop existing.
 */
export async function inspectStaged(items: QuarantineItem[]): Promise<StagedDetail[]> {
  const out: StagedDetail[] = []

  for (const item of items) {
    let fileCount = 0
    let truncated = false
    const topFiles: Array<{ name: string; bytes: number }> = []
    const stack: string[] = [item.dst]

    while (stack.length > 0) {
      const dir = stack.pop() as string
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (fileCount >= MAX_FILES_SCANNED) {
          truncated = true
          break
        }
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const stat = await fs.stat(full)
          fileCount++
          topFiles.push({ name: entry.name, bytes: stat.size })
          topFiles.sort((a, b) => b.bytes - a.bytes)
          if (topFiles.length > TOP_FILES_KEPT) topFiles.length = TOP_FILES_KEPT
        } catch {
          /* vanished mid-read */
        }
      }
      if (truncated) break
    }

    out.push({
      id: item.id,
      src: item.src,
      bytes: item.bytes,
      fileCount,
      topFiles,
      truncated
    })
  }

  return out
}

/** Delete staged copies for good. This is the step that actually frees space. */
export async function purge(ids: string[], opts: JournalOptions): Promise<BatchResult> {
  const all = await listQuarantine(opts.journalPath)
  const byId = new Map(all.map((i) => [i.id, i]))
  const results: ExecResultItem[] = []

  for (const id of ids) {
    const item = byId.get(id)
    if (!item || item.status !== 'quarantined') {
      results.push({
        path: item?.src ?? id,
        status: 'skipped',
        reason: item ? `Item is ${item.status}` : 'Unknown item',
        bytes: item?.bytes ?? 0
      })
      continue
    }
    if (!(await exists(item.dst))) {
      results.push({ path: item.src, status: 'skipped', reason: 'Staged copy is missing', bytes: item.bytes })
      continue
    }

    try {
      await fs.rm(item.dst, { recursive: true, force: false, maxRetries: 2 })
    } catch (err) {
      const reason = (err as Error).message
      await appendJournal(opts.journalPath, {
        op: 'purge',
        id: randomUUID(),
        ref: id,
        batch: item.batch,
        ts: new Date().toISOString(),
        src: item.src,
        dst: item.dst,
        bytes: item.bytes,
        status: 'failed',
        reason
      })
      results.push({ path: item.src, status: 'skipped', reason, bytes: item.bytes })
      continue
    }

    await appendJournal(opts.journalPath, {
      op: 'purge',
      id: randomUUID(),
      ref: id,
      batch: item.batch,
      ts: new Date().toISOString(),
      src: item.src,
      dst: item.dst,
      bytes: item.bytes,
      status: 'ok'
    })
    results.push({ path: item.src, status: 'purged', bytes: item.bytes })
  }

  return { batch: 'purge', items: results, bytes: results.filter((r) => r.status === 'purged').reduce((n, r) => n + r.bytes, 0) }
}
