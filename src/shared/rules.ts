import type { Candidate, Rule, ScanResult, Tier } from './types'

const ENV_MAP: Record<string, string | undefined> = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  APPDATA: process.env.APPDATA,
  USERPROFILE: process.env.USERPROFILE,
  PROGRAMDATA: process.env.PROGRAMDATA,
  PROGRAMFILES: process.env.ProgramFiles,
  'PROGRAMFILES(X86)': process.env['ProgramFiles(x86)'],
  PUBLIC: process.env.PUBLIC,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  SYSTEMDRIVE: process.env.SystemDrive ?? 'C:'
}

/**
 * Known-folder resolution.
 *
 * Shell folders are not always under the user profile: OneDrive can redirect
 * Documents/Desktop/Pictures, and users move Downloads to another drive. String
 * concatenation misses those. Electron's `app.getPath()` uses the Windows Known
 * Folder API, so the host injects the real paths here at startup; these defaults
 * are the fallback for CLI and tests.
 */
export function setPathOverrides(overrides: Record<string, string>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value) ENV_MAP[key.toUpperCase()] = value
  }
}

const HOME = process.env.USERPROFILE
if (HOME) {
  setPathOverrides({
    DOCUMENTS: `${HOME}\\Documents`,
    DESKTOP: `${HOME}\\Desktop`,
    DOWNLOADS: `${HOME}\\Downloads`,
    PICTURES: `${HOME}\\Pictures`,
    MUSIC: `${HOME}\\Music`,
    VIDEOS: `${HOME}\\Videos`
  })
}

/** Expand `%LOCALAPPDATA%`-style tokens against the current environment. */
export function expandPath(input: string): string {
  return input.replace(/%([A-Z0-9_()]+)%/gi, (whole, name: string) => ENV_MAP[name.toUpperCase()] ?? whole)
}

function normalize(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

interface CompiledRule extends Rule {
  _prefix?: string
  _name?: string
  _regex?: RegExp
}

export function compileRules(rules: Rule[]): CompiledRule[] {
  return rules.map((r) => ({
    ...r,
    _prefix: r.match.prefix ? normalize(expandPath(r.match.prefix)) : undefined,
    _name: r.match.name ? normalize(r.match.name) : undefined,
    _regex: r.match.regex ? new RegExp(r.match.regex, 'i') : undefined
  }))
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('\\') + 1).toLowerCase()
}

export interface MatchFlags {
  /** True when the folder's PARENT directly contains a package.json. */
  parentPkg?: boolean
}

/**
 * Every matcher on a rule must pass — they are ANDed, not ORed.
 *
 * This is what makes "name `node_modules`, but only under Program Files"
 * expressible. With OR semantics a rule could only ever say "either", which is
 * exactly the gap that let installed applications' node_modules be offered for
 * deletion.
 */
export function matchRule(
  dir: string,
  size: number,
  rules: CompiledRule[],
  flags: MatchFlags = {}
): CompiledRule | null {
  const d = normalize(dir)

  for (const r of rules) {
    if (r.minBytes !== undefined && size < r.minBytes) continue
    if (r.requiresSibling === 'package.json' && flags.parentPkg !== true) continue

    let hasMatcher = false
    let ok = true

    if (r._prefix) {
      hasMatcher = true
      ok = d === r._prefix || d.startsWith(r._prefix + '\\')
    }
    if (ok && r._name) {
      hasMatcher = true
      ok = baseName(d) === r._name
    }
    if (ok && r._regex) {
      hasMatcher = true
      ok = r._regex.test(dir)
    }

    if (hasMatcher && ok) return r
  }

  return null
}

function depthOf(p: string): number {
  let n = 0
  for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) === 92) n++
  return n
}

/** True if this path is a drive root like `C:\`. */
function isDriveRoot(p: string): boolean {
  return /^[a-z]:\\?$/i.test(p)
}

function parentOf(p: string): string | null {
  if (isDriveRoot(p)) return null
  const i = p.lastIndexOf('\\')
  if (i === 2) return p.slice(0, 3)
  if (i < 2) return null
  return p.slice(0, i)
}

export interface CandidateOptions {
  /** Ignore candidates that contribute less than this many bytes on their own. */
  minBytes?: number
  /**
   * Fired for every classified folder, including display-only rules that never
   * become review candidates. Used to colour the map without a second pass.
   */
  onMatched?: (path: string, tier: Tier) => void
}

/**
 * Resolve review candidates from a scan.
 *
 * Two problems this solves that a naive "match every path" approach gets wrong:
 *
 * 1. **Double counting.** A folder's recursive size already contains its
 *    subfolders. If both `CapCut` and `CapCut\Cache` are listed with their
 *    recursive sizes, selecting both would promise bytes that only exist once.
 *    Each candidate therefore reports an *exclusive* size: its own bytes minus
 *    any nested candidate groups.
 *
 * 2. **Protected data inside removable data.** `CapCut\Projects` (your drafts)
 *    sits inside `CapCut` (a big reviewable folder). Removing the parent would
 *    destroy the child. Such parents are flagged `blocked` with the exact bytes
 *    and paths that must not be swept up.
 */
export function findCandidates(
  scan: ScanResult,
  compiled: CompiledRule[],
  opts: CandidateOptions = {}
): Candidate[] {
  const minExclusive = opts.minBytes ?? 1024 * 1024

  // Folders smaller than the reporting floor can never become candidates, so
  // they are excluded before rule matching. On a 377k-folder drive this is the
  // difference between a 6-second stall and a sub-second one, and it changes
  // nothing the user can see or select.
  const relevant = scan.dirs.filter((d) => d.s >= minExclusive)

  // `requiresSibling` asks about the folder that CONTAINS the candidate:
  // package.json lives next to node_modules, not inside it.
  const pkgDirs = new Set<string>()
  for (const d of scan.dirs) if (d.pkg) pkgDirs.add(d.p)

  const matched = new Map<string, CompiledRule>()
  const byDepthAsc = [...relevant].sort((a, b) => depthOf(a.p) - depthOf(b.p))

  for (const d of byDepthAsc) {
    const parent = parentOf(d.p)
    const rule = matchRule(d.p, d.s, compiled, { parentPkg: parent ? pkgDirs.has(parent) : false })
    if (!rule) continue

    // A prefix rule matches every descendant too. Registering each one as its
    // own candidate shreds a single cache folder into hundreds of unreadable
    // rows (pip\cache\http-v2\8\7\0\0\b …). Only the highest folder in the run
    // becomes a candidate; everything below belongs to that group.
    let cur = parentOf(d.p)
    let sameRuleAbove = false
    while (cur) {
      const above = matched.get(cur)
      if (above) {
        sameRuleAbove = above.id === rule.id
        break
      }
      cur = parentOf(cur)
    }
    if (sameRuleAbove) continue

    matched.set(d.p, rule)
    opts.onMatched?.(d.p, rule.tier)
  }

  const ancestorCache = new Map<string, string | null>()
  const nearestMatchedAncestor = (p: string): string | null => {
    if (ancestorCache.has(p)) return ancestorCache.get(p) as string | null
    let cur = parentOf(p)
    let found: string | null = null
    while (cur) {
      if (matched.has(cur)) {
        found = cur
        break
      }
      cur = parentOf(cur)
    }
    ancestorCache.set(p, found)
    return found
  }

  /**
   * Protection is monotonic downward: if any ancestor is KEEP or LOCKED, every
   * folder beneath it is protected too. Without this, a `KEEP` game-save folder
   * inside a `REVIEW` game launcher would be re-listed as removable by the
   * launcher's own broader rule - which is exactly how a tool deletes someone's
   * world while showing a green tick.
   */
  const protectedAncestor = (p: string): string | null => {
    let cur = nearestMatchedAncestor(p)
    while (cur) {
      const rule = matched.get(cur)
      if (rule && !rule.display && (rule.tier === 'KEEP' || rule.tier === 'LOCKED')) return cur
      cur = nearestMatchedAncestor(cur)
    }
    return null
  }

  // Deepest first: every child is accounted for before its parent is folded up.
  const ordered = [...relevant].sort((a, b) => depthOf(b.p) - depthOf(a.p))

  // `sizeCarry` collects the RECURSIVE size of immediate matched children, so a
  // parent's exclusive size is "everything not accounted for by a child group".
  // Carrying the child's *exclusive* size instead would leave the child's own
  // subfolders counted twice - once at the child, once again at the parent.
  const sizeCarry = new Map<string, number>()
  const protCarry = new Map<string, number>()
  const exclusive = new Map<string, number>()
  const protectedBytes = new Map<string, number>()
  const blockedBy = new Map<string, Set<string>>()

  for (const dir of ordered) {
    const rule = matched.get(dir.p)
    if (!rule) continue

    const own = Math.max(0, dir.s - (sizeCarry.get(dir.p) ?? 0))
    exclusive.set(dir.p, own)

    const isProtected = !rule.display && (rule.tier === 'KEEP' || rule.tier === 'LOCKED')
    // A protected folder protects its whole subtree, so its full size counts.
    const prot = (isProtected ? dir.s : 0) + (protCarry.get(dir.p) ?? 0)
    protectedBytes.set(dir.p, prot)

    if (isProtected) {
      let cur = nearestMatchedAncestor(dir.p)
      while (cur) {
        const set = blockedBy.get(cur) ?? new Set<string>()
        set.add(dir.p)
        blockedBy.set(cur, set)
        cur = nearestMatchedAncestor(cur)
      }
    }

    const ancestor = nearestMatchedAncestor(dir.p)
    if (ancestor) {
      sizeCarry.set(ancestor, (sizeCarry.get(ancestor) ?? 0) + dir.s)
      protCarry.set(ancestor, (protCarry.get(ancestor) ?? 0) + prot)
    }
  }

  const out: Candidate[] = []
  for (const dir of relevant) {
    const rule = matched.get(dir.p)
    if (!rule) continue
    // Display-only catch-alls colour the map but are not review items.
    if (rule.display) continue
    if (isDriveRoot(dir.p)) continue
    if (protectedAncestor(dir.p)) continue

    const own = exclusive.get(dir.p) ?? 0
    const prot = protectedBytes.get(dir.p) ?? 0

    if (own < minExclusive) continue
    if (rule.tier === 'LOCKED' && dir.s < 1024 * 1024 * 1024) continue

    const blocked = prot > 0 && (rule.tier === 'SAFE_PURGE' || rule.tier === 'REVIEW')
    const protectedList = [...(blockedBy.get(dir.p) ?? [])].sort()

    out.push({
      path: dir.p,
      size: own,
      totalSize: dir.s,
      files: dir.c,
      mtime: dir.m,
      tier: blocked ? 'KEEP' : rule.tier,
      category: rule.category,
      reason: blocked
        ? `${rule.reason} — but this folder also contains ${
            protectedList.length
          } protected item${protectedList.length === 1 ? '' : 's'}, so it cannot be removed as a whole.`
        : rule.reason,
      impact: rule.impact,
      ruleId: rule.id,
      depth: depthOf(dir.p),
      blocked,
      blockedBytes: prot,
      blockedBy: protectedList
    })
  }

  return out.sort((a, b) => b.size - a.size)
}

export const TIER_ORDER: Record<Tier, number> = {
  SAFE_PURGE: 0,
  REVIEW: 1,
  KEEP: 2,
  LOCKED: 3
}
