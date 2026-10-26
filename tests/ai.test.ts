import { describe, expect, it } from 'vitest'
import { parseVerdicts, needsEscalation, type AiVerdict } from '../src/shared/ai/verdict'
import { canFit } from '../src/shared/ai/preflight'
import { buildMessages, classifyHybrid, type Classifier, type ClassifyItem } from '../src/shared/ai/providers'

const PATHS = new Set([
  'c:\\users\\Example\\downloads\\thing',
  'c:\\users\\Example\\appdata\\local\\claude-3p'
])

function payload(results: unknown[]): string {
  return JSON.stringify({ results })
}

describe('parseVerdicts', () => {
  it('accepts a well-formed verdict', () => {
    const out = parseVerdicts(
      payload([
        {
          path: 'C:\\Users\\Example\\Downloads\\thing',
          tier: 'REVIEW',
          reason: 'Looks like an archived source dump.',
          confidence: 0.82
        }
      ]),
      PATHS
    )

    expect(out).toHaveLength(1)
    expect(out[0].tier).toBe('REVIEW')
    expect(out[0].confidence).toBeCloseTo(0.82)
  })

  /**
   * The single most important test in this file. A model that decides a folder
   * is definitely deletable must not be able to say so â€” the ceiling is REVIEW.
   */
  it('downgrades a model that tries to authorise deletion', () => {
    const out = parseVerdicts(
      payload([
        {
          path: 'C:\\Users\\Example\\Downloads\\thing',
          tier: 'SAFE_PURGE',
          reason: 'Definitely a cache, delete it.',
          confidence: 0.99
        }
      ]),
      PATHS
    )

    expect(out[0].tier).toBe('REVIEW')
  })

  it('downgrades unknown tier strings rather than trusting them', () => {
    const out = parseVerdicts(
      payload([{ path: 'C:\\Users\\Example\\Downloads\\thing', tier: 'DELETE_NOW', reason: 'x', confidence: 0.9 }]),
      PATHS
    )

    expect(out[0].tier).toBe('REVIEW')
  })

  it('keeps a KEEP verdict, because that is the safe direction', () => {
    const out = parseVerdicts(
      payload([{ path: 'C:\\Users\\Example\\Downloads\\thing', tier: 'KEEP', reason: 'partial project', confidence: 0.6 }]),
      PATHS
    )

    expect(out[0].tier).toBe('KEEP')
  })

  it('drops verdicts for paths that were never sent', () => {
    const out = parseVerdicts(
      payload([
        { path: 'C:\\Users\\Example\\Downloads\\thing', tier: 'REVIEW', reason: 'ok', confidence: 0.8 },
        { path: 'C:\\Windows\\System32', tier: 'KEEP', reason: 'invented', confidence: 0.9 }
      ]),
      PATHS
    )

    expect(out).toHaveLength(1)
    expect(out.some((v) => v.path.includes('System32'))).toBe(false)
  })

  it('clamps a confidence outside 0..1', () => {
    const out = parseVerdicts(
      payload([
        { path: 'C:\\Users\\Example\\Downloads\\thing', tier: 'REVIEW', reason: 'a', confidence: 42 },
        { path: 'C:\\Users\\Example\\AppData\\Local\\Claude-3p', tier: 'REVIEW', reason: 'b', confidence: -3 }
      ]),
      PATHS
    )

    expect(out[0].confidence).toBe(1)
    expect(out[1].confidence).toBe(0)
  })

  it('fills in a reason when the model omits one', () => {
    const out = parseVerdicts(
      payload([{ path: 'C:\\Users\\Example\\Downloads\\thing', tier: 'REVIEW', confidence: 0.5 }]),
      PATHS
    )

    expect(out[0].reason.length).toBeGreaterThan(0)
  })

  it('throws a typed error on malformed output so the caller can fall back', () => {
    expect(() => parseVerdicts('not json at all', PATHS)).toThrowError(/malformed/i)
    expect(() => parseVerdicts(JSON.stringify({ nope: [] }), PATHS)).toThrowError(/malformed/i)
  })
})

describe('needsEscalation', () => {
  it('escalates a low-confidence local verdict', () => {
    expect(needsEscalation({ tier: 'REVIEW', confidence: 0.62 })).toBe(true)
  })

  it('does not escalate a confident verdict', () => {
    expect(needsEscalation({ tier: 'REVIEW', confidence: 0.88 })).toBe(false)
  })
})

describe('canFit', () => {
  const GiB = 1024 ** 3

  it('accepts a 3.3 GB model on a GPU with 7.8 GB free', () => {
    const result = canFit(3.3 * GiB, 7.8 * GiB)
    expect(result.ok).toBe(true)
  })

  it('rejects a 6.6 GB model on the same GPU once overhead is counted', () => {
    const result = canFit(6.6 * GiB, 7.8 * GiB)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/VRAM/i)
  })

  it('reports how much would be needed', () => {
    const result = canFit(6.6 * GiB, 7.8 * GiB)
    expect(result.neededBytes).toBeGreaterThan(6.6 * GiB)
  })
})

describe('classifyHybrid', () => {
  const ITEMS: ClassifyItem[] = [
    { path: 'C:\\a\\cache', size: 5 * 1024 ** 3, files: 10, mtime: 0, category: 'cache' },
    { path: 'C:\\b\\mystery', size: 2 * 1024 ** 3, files: 4, mtime: 0, category: 'unknown' },
    { path: 'C:\\c\\stuff', size: 1 * 1024 ** 3, files: 3, mtime: 0, category: 'unknown' }
  ]

  function localReturning(verdicts: AiVerdict[]): Classifier {
    return { id: 'local', model: 'fake-local', classify: async () => verdicts }
  }

  it('sends only the low-confidence folders to the cloud', async () => {
    const sent: string[][] = []
    const local = localReturning([
      { path: 'C:\\a\\cache', tier: 'REVIEW', reason: 'cache', confidence: 0.95 },
      { path: 'C:\\b\\mystery', tier: 'REVIEW', reason: 'unclear', confidence: 0.4 },
      { path: 'C:\\c\\stuff', tier: 'KEEP', reason: 'unclear', confidence: 0.3 }
    ])
    const cloud: Classifier = {
      id: 'cloud',
      model: 'fake-cloud',
      classify: async (items) => {
        sent.push(items.map((i) => i.path))
        return items.map((i) => ({
          path: i.path,
          tier: 'REVIEW' as const,
          reason: 'cloud says review',
          confidence: 0.9,
          source: 'cloud' as const
        }))
      }
    }

    const result = await classifyHybrid(ITEMS, local, cloud)

    expect(sent).toEqual([['C:\\b\\mystery', 'C:\\c\\stuff']])
    expect(result.escalatedCount).toBe(2)
    expect(result.verdicts.find((v) => v.path === 'C:\\b\\mystery')?.source).toBe('cloud')
    expect(result.verdicts.find((v) => v.path === 'C:\\a\\cache')?.source).toBeUndefined()
  })

  it('does not call the cloud at all when every verdict is confident', async () => {
    let called = false
    const local = localReturning([
      { path: 'C:\\a\\cache', tier: 'REVIEW', reason: 'cache', confidence: 0.95 },
      { path: 'C:\\b\\mystery', tier: 'REVIEW', reason: 'ok', confidence: 0.9 },
      { path: 'C:\\c\\stuff', tier: 'KEEP', reason: 'ok', confidence: 0.88 }
    ])
    const cloud: Classifier = {
      id: 'cloud',
      model: 'fake-cloud',
      classify: async () => {
        called = true
        return []
      }
    }

    await classifyHybrid(ITEMS, local, cloud)

    expect(called).toBe(false)
  })

  it('falls back to local verdicts when the cloud call fails', async () => {
    const local = localReturning([
      { path: 'C:\\a\\cache', tier: 'REVIEW', reason: 'cache', confidence: 0.95 },
      { path: 'C:\\b\\mystery', tier: 'REVIEW', reason: 'unclear', confidence: 0.4 },
      { path: 'C:\\c\\stuff', tier: 'KEEP', reason: 'unclear', confidence: 0.3 }
    ])
    const cloud: Classifier = {
      id: 'cloud',
      model: 'fake-cloud',
      classify: async () => {
        throw new Error('401 unauthorized')
      }
    }

    const result = await classifyHybrid(ITEMS, local, cloud)

    expect(result.cloudError).toContain('401')
    expect(result.verdicts).toHaveLength(3)
    expect(result.verdicts.every((v) => v.source !== 'cloud')).toBe(true)
  })

  it('escalates folders the local model skipped entirely', async () => {
    const sent: string[][] = []
    const local = localReturning([
      { path: 'C:\\a\\cache', tier: 'REVIEW', reason: 'cache', confidence: 0.95 }
    ])
    const cloud: Classifier = {
      id: 'cloud',
      model: 'fake-cloud',
      classify: async (items) => {
        sent.push(items.map((i) => i.path))
        return []
      }
    }

    await classifyHybrid(ITEMS, local, cloud)

    expect(sent[0]).toEqual(['C:\\b\\mystery', 'C:\\c\\stuff'])
  })
})

describe('buildMessages', () => {
  it('includes every path and instructs the model that it cannot authorise deletion', () => {
    const messages = buildMessages([
      { path: 'C:\\one', size: 1024, files: 1, mtime: 0, category: 'cache' },
      { path: 'C:\\two', size: 2048, files: 2, mtime: 0, category: 'unknown' }
    ])

    expect(messages[0].content).toMatch(/never assert that something is safe to delete/i)
    expect(messages[1].content).toContain('C:\\\\one')
    expect(messages[1].content).toContain('C:\\\\two')
  })
})
