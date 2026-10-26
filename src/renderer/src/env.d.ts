/// <reference types="vite/client" />
import type { AppState, ScanProgress } from '@shared/types'
import type { BatchResult, ExecItem, QuarantineItem, StagedDetail } from '@shared/executor'
import type { AiSettings } from '@shared/ai/settings'
import type { PullProgress } from '@shared/ai/pull'
import type { AiStatus } from '@shared/ai/status'
import type { SystemStats, UiState } from '@shared/system'

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
      aiStatus(): Promise<AiStatus>
      aiSaveSettings(settings: AiSettings, apiKey?: string): Promise<AiSettings>
      aiPull(model: string): Promise<boolean>
      aiRun(): Promise<{ state: AppState; classified: number; escalated: number; cloudError?: string }>
      systemStats(): Promise<SystemStats>
      uiStateGet(): Promise<UiState>
      uiStateSet(patch: Partial<UiState>): Promise<UiState>
      onPullProgress(cb: (p: PullProgress & { model: string }) => void): () => void
      onAiProgress(cb: (p: { stage: string; done: number; total: number }) => void): () => void
      onProgress(cb: (p: ScanProgress) => void): () => void
    }
  }
}

export {}
