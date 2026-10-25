const DEFAULT_OVERHEAD_BYTES = Math.round(1.5 * 1024 ** 3)

export interface FitResult {
  ok: boolean
  /** Bytes required on the GPU: weights plus room for KV cache and CUDA context. */
  neededBytes: number
  freeBytes: number
  reason: string
}

const GB = 1024 ** 3

/**
 * Can this model actually live in VRAM?
 *
 * Models that only *mostly* fit are worse than models that clearly don't: a
 * couple of spilled layers puts the rest of the model through system RAM, and on
 * a laptop with ~1.6 GB free that means paging to disk. Refusing up front with a
 * number is kinder than a machine that appears frozen.
 */
export function canFit(
  weightsBytes: number,
  freeVramBytes: number,
  overheadBytes: number = DEFAULT_OVERHEAD_BYTES
): FitResult {
  const neededBytes = weightsBytes + overheadBytes
  const ok = freeVramBytes >= neededBytes

  const reason = ok
    ? `Fits: needs ~${(neededBytes / GB).toFixed(1)} GB of VRAM, ${(freeVramBytes / GB).toFixed(1)} GB free.`
    : `Needs ~${(neededBytes / GB).toFixed(1)} GB of VRAM but only ${(freeVramBytes / GB).toFixed(
        1
      )} GB is free. It would spill layers to system RAM and crawl — pick a smaller model.`

  return { ok, neededBytes, freeBytes: freeVramBytes, reason }
}

export interface GpuInfo {
  name: string
  totalBytes: number
  freeBytes: number
}
