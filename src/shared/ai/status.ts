import type { AiSettings } from './settings'
import type { HardwareInfo } from './hardware'
import type { ModelSpec, Recommendation } from './catalogue'

export interface AiStatus {
  hardware: HardwareInfo
  ollamaReachable: boolean
  installed: Array<{ name: string; sizeBytes: number }>
  recommendations: Array<Recommendation & { installed: boolean }>
  catalogue: ModelSpec[]
  defaultModel: string | null
  settings: AiSettings
  keyPresent: boolean
}

export interface AiRunResult {
  state: unknown
  classified: number
  escalated: number
  cloudError?: string
}
