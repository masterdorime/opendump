export type Tier = 'SAFE_PURGE' | 'REVIEW' | 'KEEP' | 'LOCKED'

export interface DirEntry {
  /** Absolute path. */
  p: string
  /** Recursive size in bytes. */
  s: number
  /** Recursive file count. */
  c: number
  /** Newest mtime within the subtree, ms since epoch. */
  m: number
  /** True when this folder directly contains a package.json. */
  pkg?: boolean
  /** True when this folder directly contains a .git directory. */
  git?: boolean
}

export interface FileEntry {
  p: string
  s: number
  m: number
}

export interface ScanResult {
  root: string
  scannedAt: string
  durationMs: number
  totalBytes: number
  totalDirs: number
  totalFiles: number
  skipped: number
  dirs: DirEntry[]
  topFiles: FileEntry[]
}

export interface ScanProgress {
  phase: 'walking' | 'totalling' | 'done'
  dirs: number
  files: number
  bytes: number
  current: string
  elapsedMs: number
  /** Used bytes on the drive at scan start — lets the UI show a real percentage. */
  usedBytes?: number
}

export interface RuleMatch {
  /** Match a directory whose path starts with this prefix (env vars expanded, case-insensitive). */
  prefix?: string
  /** Match any directory whose final segment equals this name. */
  name?: string
  /** Match the full path against a regular expression (case-insensitive). */
  regex?: string
}

export interface Rule {
  id: string
  tier: Tier
  category: string
  reason: string
  /** Human-readable statement of what happens if this is removed. */
  impact?: string
  match: RuleMatch
  /** Only offer this rule when the directory is at least this large (bytes). */
  minBytes?: number
  /**
   * Only match when the PARENT folder contains this file. A `node_modules` is
   * only regenerable when a manifest sits beside it to regenerate from.
   */
  requiresSibling?: 'package.json'
  /**
   * Display-only rule: colours the map and labels the folder, but does not form
   * a protection boundary. Used for broad catch-alls like "the rest of Windows"
   * which must not block a more specific rule underneath them.
   */
  display?: boolean
}

export interface Candidate {
  path: string
  /** Bytes attributable to this folder *excluding* nested candidates, so totals never double-count. */
  size: number
  /** Recursive size of the whole folder, including nested candidates. */
  totalSize: number
  files: number
  mtime: number
  tier: Tier
  category: string
  reason: string
  impact?: string
  ruleId: string
  /** Nesting depth relative to scan root, used for tree grouping. */
  depth: number
  /** True when this folder contains KEEP/LOCKED data and must not be removed wholesale. */
  blocked: boolean
  /** Bytes of protected data inside this folder. */
  blockedBytes: number
  /** Paths of protected folders inside this one, for the explanation panel. */
  blockedBy: string[]
}

export interface TreeNode {
  path: string
  name: string
  size: number
  tier: Tier | null
  children: TreeNode[]
}

export interface ScanMeta {
  root: string
  scannedAt: string
  durationMs: number
  totalBytes: number
  totalDirs: number
  totalFiles: number
  skipped: number
}

export interface AppState {
  /** Drive the app is pointed at, e.g. `C:`. */
  drive: string
  meta: ScanMeta | null
  tree: TreeNode | null
  candidates: Candidate[]
  space: { free: number; total: number } | null
  rulesVersion: number
  /** Source paths currently held in quarantine — excluded from candidates. */
  quarantinedSrcs: string[]
  /** Large folders no rule could classify; the only useful target for the AI. */
  unclassified: number
}
