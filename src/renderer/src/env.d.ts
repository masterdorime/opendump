/// <reference types="vite/client" />
import type { AppState, ScanProgress } from '@shared/types'
import type { BatchResult, ExecItem, QuarantineItem, StagedDetail } from '@shared/executor'

declare global {
  interface Window {
    dsa: {
      getState(): Promise<AppState>
      runScan(): Promise<AppState>
      clearScan(): Promise<void>
      reveal(p: string): Promise<void>
      openRules(): Promise<void>
      getSpace(): Promise<{ free: number; total: number } | null>
      quarantine(items: ExecItem[]): Promise<BatchResult>
      listQuarantine(): Promise<QuarantineItem[]>
      restore(ids: string[]): Promise<BatchResult>
      purge(ids: string[]): Promise<BatchResult>
      inspectQuarantine(ids: string[]): Promise<StagedDetail[]>
      onProgress(cb: (p: ScanProgress) => void): () => void
    }
  }
}

export {}
