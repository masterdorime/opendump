import { contextBridge, ipcRenderer } from 'electron'
import type { ScanProgress } from '@shared/types'
import type { BatchResult, ExecItem, QuarantineItem, StagedDetail } from '@shared/executor'

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
  onProgress: (cb: (p: ScanProgress) => void): (() => void) => {
    const listener = (_e: unknown, payload: ScanProgress): void => cb(payload)
    ipcRenderer.on('scan:progress', listener)
    return () => ipcRenderer.removeListener('scan:progress', listener)
  }
}

contextBridge.exposeInMainWorld('dsa', api)

export type DsaApi = typeof api
