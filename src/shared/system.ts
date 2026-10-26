/** Live machine state for the header chip and the AI panel. */
export interface SystemStats {
  ramTotalBytes: number
  ramFreeBytes: number
  gpuName: string | null
  vramFreeBytes: number | null
  vramTotalBytes: number | null
}

/** Bytes the model runner needs on top of the weights, in practice. */
export const RAM_HEADROOM_BYTES = 1.5 * 1024 ** 3

export type MemoryPressure = 'ok' | 'tight' | 'low'

export function memoryPressure(freeBytes: number): MemoryPressure {
  if (freeBytes < RAM_HEADROOM_BYTES) return 'low'
  if (freeBytes < RAM_HEADROOM_BYTES * 1.7) return 'tight'
  return 'ok'
}

export interface UiState {
  tutorialSeen: boolean
}
