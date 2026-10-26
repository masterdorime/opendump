import { describe, expect, it } from 'vitest'
import { parseNvidiaSmi, buildHardware, type HardwareInfo } from '../src/shared/ai/hardware'
import { recommendModels, pickDefault, CATALOGUE, checkRunFeasible } from '../src/shared/ai/catalogue'
import { parsePullLine } from '../src/shared/ai/pull'
import { mergeSettings, DEFAULT_SETTINGS } from '../src/shared/ai/settings'

const GiB = 1024 ** 3

function hw(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU',
    vramTotalBytes: 8188 * 1024 * 1024,
    vramFreeBytes: 7.6 * GiB,
    ramTotalBytes: 11.7 * GiB,
    ramFreeBytes: 2.2 * GiB,
    source: 'nvidia-smi',
    ...overrides
  }
}

describe('parseNvidiaSmi', () => {
  it('reads name, total and free memory', () => {
    const result = parseNvidiaSmi('NVIDIA GeForce RTX 4060 Laptop GPU, 8188, 7800')
    expect(result?.name).toContain('RTX 4060')
    expect(result?.totalBytes).toBe(8188 * 1024 * 1024)
    expect(result?.freeBytes).toBe(7800 * 1024 * 1024)
  })

  it('returns null when nvidia-smi is absent or unparseable', () => {
    expect(parseNvidiaSmi('')).toBeNull()
    expect(parseNvidiaSmi("'nvidia-smi' is not recognized as an internal command")).toBeNull()
    expect(parseNvidiaSmi('not, a, gpu, row')).toBeNull()
  })
})

describe('buildHardware', () => {
  it('uses the GPU when nvidia-smi answers', () => {
    const result = buildHardware('RTX 4060, 8188, 7800', 11.7 * GiB, 2.2 * GiB)
    expect(result.source).toBe('nvidia-smi')
    expect(result.vramFreeBytes).toBe(7800 * 1024 * 1024)
  })

  it('falls back to a CPU-only budget rather than guessing VRAM', () => {
    const result = buildHardware(null, 16 * GiB, 8 * GiB)
    expect(result.source).toBe('cpu-only')
    expect(result.vramFreeBytes).toBeNull()
    expect(result.vramTotalBytes).toBeNull()
  })
})

describe('recommendModels', () => {
  it('rates a 3.3 GB model comfortable on an 8 GB card with room to spare', () => {
    const recs = recommendModels(hw())
    const four = recs.find((r) => r.spec.id === 'qwen3.5:4b-q4_K_M')
    expect(four?.fit).toBe('comfortable')
  })

  it('refuses a 6.6 GB model that would spill on the same card', () => {
    const recs = recommendModels(hw())
    const nine = recs.find((r) => r.spec.id === 'qwen3.5:9b-q4_K_M')
    expect(nine?.fit).toBe('wont-fit')
    expect(nine?.detail).toMatch(/VRAM/i)
  })

  it('refuses everything when there is not enough RAM for the runner', () => {
    const recs = recommendModels(hw({ ramFreeBytes: 0.9 * GiB }))
    expect(recs.every((r) => r.fit === 'wont-fit')).toBe(true)
    expect(recs[0].detail).toMatch(/RAM|close/i)
  })

  it('offers a CPU path when there is no GPU but plenty of RAM', () => {
    const recs = recommendModels(
      buildHardware(null, 32 * GiB, 24 * GiB)
    )
    const small = recs.find((r) => r.spec.id === 'qwen3.5:2b-q4_K_M')
    expect(small?.fit).toBe('fits-cpu')
  })

  it('ranks every comfortable model above a tight one', () => {
    const recs = recommendModels(hw())
    const lastComfortable = recs.map((r) => r.fit).lastIndexOf('comfortable')
    const firstTight = recs.map((r) => r.fit).indexOf('tight')
    if (firstTight !== -1 && lastComfortable !== -1) {
      expect(lastComfortable).toBeLessThan(firstTight)
    }
  })

  it('preselects a model so the default path needs no configuration', () => {
    expect(pickDefault(recommendModels(hw()))).not.toBeNull()
    expect(pickDefault(recommendModels(hw({ ramFreeBytes: 0.9 * GiB })))).toBeNull()
  })

  it('ships a catalogue with sane, increasing sizes', () => {
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(4)
    for (const spec of CATALOGUE) expect(spec.sizeBytes).toBeGreaterThan(0.5 * GiB)
  })
})

describe('checkRunFeasible', () => {
  it('refuses when RAM is short even though VRAM is plentiful', () => {
    const reason = checkRunFeasible(hw({ ramFreeBytes: 0.7 * GiB }), 3.3 * GiB)
    expect(reason).toMatch(/RAM/i)
  })

  it('refuses a model too large for free VRAM', () => {
    expect(checkRunFeasible(hw(), 6.6 * GiB)).toMatch(/VRAM/i)
  })

  it('allows a model that fits both budgets', () => {
    expect(checkRunFeasible(hw(), 3.3 * GiB)).toBeNull()
  })
})

describe('parsePullLine', () => {
  it('reads a progress line', () => {
    const p = parsePullLine('{"status":"pulling 50cbab8a892c","total":3300000000,"completed":2100000000}')
    expect(p?.completed).toBe(2_100_000_000)
    expect(p?.total).toBe(3_300_000_000)
    expect(p?.done).toBe(false)
  })

  it('marks success as done', () => {
    expect(parsePullLine('{"status":"success"}')?.done).toBe(true)
  })

  it('surfaces an error payload', () => {
    const p = parsePullLine('{"error":"pull model manifest: file does not exist"}')
    expect(p?.error).toMatch(/does not exist/)
  })

  it('ignores blank and malformed chunks', () => {
    expect(parsePullLine('')).toBeNull()
    expect(parsePullLine('not json')).toBeNull()
    expect(parsePullLine('{"status":"pulling manifest"}')?.completed).toBe(0)
  })
})

describe('mergeSettings', () => {
  it('fills defaults from junk', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings('nope')).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps a user-chosen model and clamps the threshold', () => {
    const s = mergeSettings({ provider: 'hybrid', localModel: 'my-custom:7b', confidenceThreshold: 5 })
    expect(s.provider).toBe('hybrid')
    expect(s.localModel).toBe('my-custom:7b')
    expect(s.confidenceThreshold).toBe(1)
  })

  it('rejects an unknown provider instead of trusting it', () => {
    expect(mergeSettings({ provider: 'quantum' }).provider).toBe('local')
  })
})
