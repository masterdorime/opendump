import { contextBridge, ipcRenderer } from 'electron'
import type { ScanProgress } from '@shared/types'
import type { BatchResult, ExecItem, QuarantineItem, StagedDetail } from '@shared/executor'
import type { AiSettings } from '@shared/ai/settings'
import type { PullProgress } from '@shared/ai/pull'
import type { SystemStats, UiState } from '@shared/system'

const api = {
  getState: () => ipcRenderer.invoke('state:get'),
  runScan: () => ipcRenderer.invoke('scan:run'),
  clearScan: () => ipcRenderer.invoke('scan:clear'),
  reveal: (p: string) => ipcRenderer.invoke('path:reveal', p),
  openRules: () => ipcRenderer.invoke('rules:open'),
  getSpace: () => ipcRenderer.invoke('space:get'),
  quarantine: (items: ExecItem[]): Promise<BatchResult> => ipcRenderer.invoke('exec:quarantine', items),
  listQuarantine: (): Promise<QuarantineItem[]> => ipcRenderer.invoke('exec:list'),
  restore: (ids: string[]): Promise<BatchResult> => ipcRenderer.invoke('exec:restore', ids),
  purge: (ids: string[]): Promise<BatchResult> => ipcRenderer.invoke('exec:purge', ids),
  inspectQuarantine: (ids: string[]): Promise<StagedDetail[]> => ipcRenderer.invoke('exec:inspect', ids),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSaveSettings: (settings: AiSettings, apiKey?: string): Promise<AiSettings> =>
    ipcRenderer.invoke('ai:settings:save', settings, apiKey),
  aiPull: (model: string): Promise<boolean> => ipcRenderer.invoke('ai:pull', model),
  aiRun: () => ipcRenderer.invoke('ai:run'),
  systemStats: (): Promise<SystemStats> => ipcRenderer.invoke('system:stats'),
  uiStateGet: (): Promise<UiState> => ipcRenderer.invoke('ui:state:get'),
  uiStateSet: (patch: Partial<UiState>): Promise<UiState> => ipcRenderer.invoke('ui:state:set', patch),
  onPullProgress: (cb: (p: PullProgress & { model: string }) => void): (() => void) => {
    const listener = (_e: unknown, payload: PullProgress & { model: string }): void => cb(payload)
    ipcRenderer.on('ai:pull', listener)
    return () => ipcRenderer.removeListener('ai:pull', listener)
  },
  onAiProgress: (cb: (p: { stage: string; done: number; total: number }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { stage: string; done: number; total: number }): void =>
      cb(payload)
    ipcRenderer.on('ai:progress', listener)
    return () => ipcRenderer.removeListener('ai:progress', listener)
  },
  onProgress: (cb: (p: ScanProgress) => void): (() => void) => {
    const listener = (_e: unknown, payload: ScanProgress): void => cb(payload)
    ipcRenderer.on('scan:progress', listener)
    return () => ipcRenderer.removeListener('scan:progress', listener)
  }
}

contextBridge.exposeInMainWorld('dsa', api)

export type DsaApi = typeof api
