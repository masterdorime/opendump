import { describe, expect, it } from 'vitest'
import { compileRules, findCandidates, findUnclassified, matchRule, setPathOverrides } from '../src/shared/rules'
import type { Rule, ScanResult } from '../src/shared/types'

const MB = 1024 * 1024

function scanTree(sizes: Record<string, number>): ScanResult {
  const dirs = Object.entries(sizes).map(([p, s]) => ({ p, s, c: 1, m: 0 }))
  const total = sizes['C:\\'] ?? 0
  return {
    root: 'C:\\',
    scannedAt: new Date(0).toISOString(),
    durationMs: 0,
    totalBytes: total,
    totalDirs: dirs.length,
    totalFiles: dirs.length,
    skipped: 0,
    dirs,
    topFiles: []
  }
}

const RULES: Rule[] = [
  {
    id: 'purge-cache',
    tier: 'SAFE_PURGE',
    category: 'cache',
    reason: 'rebuilds',
    match: { prefix: 'C:\\A\\cache' }
  },
  {
    id: 'keep-keep',
    tier: 'KEEP',
    category: 'data',
    reason: 'yours',
    match: { prefix: 'C:\\A\\keep' }
  },
  {
    id: 'review-a',
    tier: 'REVIEW',
    category: 'app',
    reason: 'look inside',
    match: { prefix: 'C:\\A' }
  },
  {
    id: 'purge-b',
    tier: 'SAFE_PURGE',
    category: 'cache',
    reason: 'rebuilds',
    match: { prefix: 'C:\\B' }
  }
]

/**
 * Sizes are deliberately overlapping: A (600) fully contains cache (400) and
 * keep (150), and the drive root (1000) contains all of it.
 */
const SCAN = scanTree({
  'C:\\': 1000 * MB,
  'C:\\A': 600 * MB,
  'C:\\A\\cache': 400 * MB,
  'C:\\A\\keep': 150 * MB,
  'C:\\B': 300 * MB
})

describe('findCandidates', () => {
  const candidates = findCandidates(SCAN, compileRules(RULES))
  const byPath = new Map(candidates.map((c) => [c.path.toLowerCase(), c]))

  it('never reports more reclaimable bytes than the scan contains', () => {
    const sum = candidates.reduce((n, c) => n + c.size, 0)
    expect(sum).toBeLessThanOrEqual(SCAN.totalBytes)
    // A(50) + cache(400) + keep(150) + B(300) = 900; the 100 MB of root-level
    // bytes are unclassified, so nothing else is offered.
    expect(sum).toBe(900 * MB)
  })

  it('gives a parent only the bytes its children do not already account for', () => {
    expect(byPath.get('c:\\a')?.size).toBe(50 * MB)
    expect(byPath.get('c:\\a')?.totalSize).toBe(600 * MB)
  })

  it('does not double count a nested folder', () => {
    expect(byPath.get('c:\\a\\cache')?.size).toBe(400 * MB)
    expect(byPath.get('c:\\a\\keep')?.size).toBe(150 * MB)
  })

  it('blocks a removable parent that contains protected data', () => {
    const a = byPath.get('c:\\a')
    expect(a?.blocked).toBe(true)
    expect(a?.blockedBytes).toBe(150 * MB)
    expect(a?.tier).toBe('KEEP')
    expect(a?.blockedBy).toEqual(['C:\\A\\keep'])
  })

  it('leaves a parent untouched by protection when it has none', () => {
    const b = byPath.get('c:\\b')
    expect(b?.blocked).toBe(false)
    expect(b?.tier).toBe('SAFE_PURGE')
  })

  it('never offers a folder smaller than the reporting floor on its own', () => {
    // C:\ contributes 100 MB of unclassified files and matches no rule at all.
    expect(byPath.has('c:\\')).toBe(false)
  })
})

describe('findUnclassified', () => {
  const MB = 1024 * 1024
  const SCAN = scanTree({
    'C:\\': 1000 * MB,
    'C:\\A': 600 * MB,
    'C:\\A\\cache': 400 * MB,
    'C:\\mystery': 420 * MB,
    'C:\\mystery\\inner': 300 * MB,
    'C:\\solo': 260 * MB
  })

  it('descends to the most specific unknown folder instead of the container', () => {
    const found = findUnclassified(SCAN, compileRules(RULES), { minBytes: 100 * MB })
    const paths = found.map((f) => f.path.toLowerCase())
    expect(paths).toContain('c:\\mystery\\inner')
    expect(paths).not.toContain('c:\\mystery')
  })

  it('emits an unknown folder that has no unknown children', () => {
    const found = findUnclassified(SCAN, compileRules(RULES), { minBytes: 100 * MB })
    expect(found.map((f) => f.path.toLowerCase())).toContain('c:\\solo')
  })

  it('never returns something a rule already classified', () => {
    const found = findUnclassified(SCAN, compileRules(RULES), { minBytes: 100 * MB })
    const paths = found.map((f) => f.path.toLowerCase())
    expect(paths).not.toContain('c:\\a\\cache')
  })

  it('honours excluded roots such as the Windows directory', () => {
    const found = findUnclassified(SCAN, compileRules(RULES), {
      minBytes: 100 * MB,
      excludeRoots: ['C:\\mystery']
    })
    expect(found.map((f) => f.path.toLowerCase())).not.toContain('c:\\mystery\\inner')
  })
})

describe('AND matching', () => {
  const MB = 1024 * 1024

  const RULES: Rule[] = [
    {
      id: 'keep-installed-modules',
      tier: 'KEEP',
      category: 'installed app',
      reason: 'shipped inside an application',
      match: { prefix: 'C:\\Program Files', name: 'node_modules' }
    },
    {
      id: 'purge-modules',
      tier: 'SAFE_PURGE',
      category: 'build artifact',
      reason: 'rebuildable',
      requiresSibling: 'package.json',
      match: { name: 'node_modules' }
    }
  ]
  const compiled = compileRules(RULES)

  it('requires every matcher on a rule to pass', () => {
    const inside = matchRule('C:\\Program Files\\Adobe\\js\\node_modules', 100 * MB, compiled, { parentPkg: true })
    expect(inside?.id).toBe('keep-installed-modules')

    const project = matchRule('C:\\work\\proj\\node_modules', 100 * MB, compiled, { parentPkg: true })
    expect(project?.id).toBe('purge-modules')
  })

  it('does not let a name-only rule fire when the package.json requirement is unmet', () => {
    expect(matchRule('C:\\work\\proj\\node_modules', 100 * MB, compiled, { parentPkg: false })).toBeNull()
    expect(matchRule('C:\\work\\proj\\node_modules', 100 * MB, compiled, {})).toBeNull()
  })

  it('resolves shell folders through injected known-folder paths', () => {
    setPathOverrides({ DOCUMENTS: 'D:\\OneDrive\\Documents' })
    const docs = compileRules([
      { id: 'docs', tier: 'KEEP', category: 'docs', reason: 'x', match: { prefix: '%DOCUMENTS%' } }
    ])
    expect(matchRule('D:\\OneDrive\\Documents\\tax', 2 * MB, docs)?.id).toBe('docs')
    expect(matchRule('C:\\Users\\Someone\\Documents\\tax', 2 * MB, docs)).toBeNull()
  })
})
