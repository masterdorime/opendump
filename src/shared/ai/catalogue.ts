import type { HardwareInfo } from './hardware'

const GiB = 1024 ** 3

export interface ModelSpec {
  id: string
  label: string
  params: string
  sizeBytes: number
  /** Rough capability score, used to order models that all fit. */
  quality: number
  note: string
}

/**
 * A short, known-good list rather than the whole registry: 20+ tags with sizes
 * from 1 GB to 20 GB is exactly the choice a normal user cannot make.
 */
export const CATALOGUE: ModelSpec[] = [
  {
    id: 'qwen3.5:4b-q4_K_M',
    label: 'Qwen 3.5 4B',
    params: '4B',
    sizeBytes: 3.3 * GiB,
    quality: 60,
    note: 'Fits an 8 GB laptop card. Multilingual, good on consumer apps.'
  },
  {
    id: 'qwen3.5:9b-q4_K_M',
    label: 'Qwen 3.5 9B',
    params: '9B',
    sizeBytes: 6.6 * GiB,
    quality: 80,
    note: 'Noticeably better reasoning. Wants a 10 GB+ card.'
  },
  {
    id: 'qwen3.5:2b-q4_K_M',
    label: 'Qwen 3.5 2B',
    params: '2B',
    sizeBytes: 1.9 * GiB,
    quality: 35,
    note: 'Small and quick. Shallow answers, fine for obvious caches.'
  },
  {
    id: 'qwen3.5:0.8b',
    label: 'Qwen 3.5 0.8B',
    params: '0.8B',
    sizeBytes: 1.2 * GiB,
    quality: 20,
    note: 'Runs almost anywhere. Use when memory is very tight.'
  },
  {
    id: 'llama3.1:8b-instruct-q4_K_M',
    label: 'Llama 3.1 8B',
    params: '8B',
    sizeBytes: 4.9 * GiB,
    quality: 58,
    note: 'Strictest JSON, weakest on non-English app names.'
  },
  {
    id: 'qwen2.5-coder:7b',
    label: 'Qwen 2.5 Coder 7B',
    params: '7B',
    sizeBytes: 4.7 * GiB,
    quality: 50,
    note: 'Strong on build artefacts, weak on consumer software.'
  }
]

export type FitVerdict = 'comfortable' | 'tight' | 'fits-cpu' | 'wont-fit'

export interface Recommendation {
  spec: ModelSpec
  fit: FitVerdict
  detail: string
}

const VRAM_OVERHEAD = 1.5 * GiB
const COMFORT_MARGIN = 1.0 * GiB
export const RUNNER_RAM_BYTES = 1.5 * GiB
const CPU_OVERHEAD = 2.0 * GiB

/**
 * Last line of defence before a run starts.
 *
 * The UI already disables the button, but the main process must not depend on
 * that: loading a model with too little free RAM is what makes a laptop appear
 * frozen. Returns a human-readable refusal, or null when the run is safe.
 */
export function checkRunFeasible(
  hardware: HardwareInfo,
  modelBytes: number
): string | null {
  if (hardware.ramFreeBytes < RUNNER_RAM_BYTES) {
    return `Only ${(hardware.ramFreeBytes / GiB).toFixed(
      1
    )} GB of RAM is free. The model runner needs about 1.5 GB on top of the model â€” close some apps and try again.`
  }

  if (hardware.vramFreeBytes !== null) {
    const needed = modelBytes + VRAM_OVERHEAD
    if (hardware.vramFreeBytes < needed) {
      return `This model needs about ${(needed / GiB).toFixed(1)} GB of VRAM but only ${(
        hardware.vramFreeBytes / GiB
      ).toFixed(1)} GB is free. Pick a smaller model.`
    }
  }

  return null
}

const gb = (bytes: number): string => `${(bytes / GiB).toFixed(1)} GB`

const FIT_ORDER: Record<FitVerdict, number> = {
  comfortable: 0,
  tight: 1,
  'fits-cpu': 2,
  'wont-fit': 3
}

/**
 * Decide what this specific machine can run.
 *
 * Two constraints, both measured rather than assumed: the weights plus KV cache
 * have to fit in free VRAM, and the runner process needs roughly 1.5 GB of free
 * system RAM regardless of how much is offloaded. On a laptop with 0.9 GB free
 * that second constraint is what actually fails first.
 */
export function recommendModels(
  hardware: HardwareInfo,
  catalogue: ModelSpec[] = CATALOGUE
): Recommendation[] {
  const ramOk = hardware.ramFreeBytes >= RUNNER_RAM_BYTES

  const recs: Recommendation[] = catalogue.map((spec) => {
    const neededVram = spec.sizeBytes + VRAM_OVERHEAD

    if (!ramOk) {
      return {
        spec,
        fit: 'wont-fit' as const,
        detail: `Only ${gb(hardware.ramFreeBytes)} RAM is free â€” the model runner needs about ${gb(
          RUNNER_RAM_BYTES
        )}. Close some apps and re-check.`
      }
    }

    if (hardware.vramFreeBytes !== null) {
      if (hardware.vramFreeBytes >= neededVram + COMFORT_MARGIN) {
        return {
          spec,
          fit: 'comfortable' as const,
          detail: `Needs about ${gb(neededVram)} of VRAM; ${gb(hardware.vramFreeBytes)} is free.`
        }
      }
      if (hardware.vramFreeBytes >= neededVram) {
        return {
          spec,
          fit: 'tight' as const,
          detail: `Needs ${gb(neededVram)} of VRAM and ${gb(
            hardware.vramFreeBytes
          )} is free â€” it may spill to RAM and slow down.`
        }
      }
    }

    if (hardware.ramFreeBytes >= spec.sizeBytes + CPU_OVERHEAD) {
      return {
        spec,
        fit: 'fits-cpu' as const,
        detail: `Too large for VRAM; would run on the CPU using about ${gb(
          spec.sizeBytes + CPU_OVERHEAD
        )} of RAM. Slow but usable.`
      }
    }

    return {
      spec,
      fit: 'wont-fit' as const,
      detail: `Needs about ${gb(neededVram)} of VRAM but only ${gb(
        hardware.vramFreeBytes ?? 0
      )} is free, and there is not enough RAM to fall back to the CPU.`
    }
  })

  return recs.sort((a, b) => {
    const byFit = FIT_ORDER[a.fit] - FIT_ORDER[b.fit]
    if (byFit !== 0) return byFit
    return b.spec.quality - a.spec.quality
  })
}

/** The best model that actually fits, so the default path needs no configuration. */
export function pickDefault(recs: Recommendation[]): Recommendation | null {
  return recs.find((r) => r.fit === 'comfortable') ?? recs.find((r) => r.fit === 'tight') ?? null
}
