export type AiProvider = 'local' | 'cloud' | 'hybrid'

export interface AiSettings {
  enabled: boolean
  provider: AiProvider
  /** Any Ollama tag, including ones not in the curated catalogue. */
  localModel: string
  confidenceThreshold: number
  cloud: {
    baseUrl: string
    model: string
  }
}

export const DEFAULT_SETTINGS: AiSettings = {
  enabled: false,
  provider: 'local',
  localModel: 'qwen3.5:4b-q4_K_M',
  confidenceThreshold: 0.7,
  cloud: { baseUrl: 'https://api.openai.com/v1', model: '' }
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Settings come from a JSON file a user can edit, so every field is treated as
 * untrusted: unknown providers fall back to local, and the threshold is clamped.
 * A typo must never silently widen what the AI is allowed to decide.
 */
export function mergeSettings(raw: unknown): AiSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SETTINGS, cloud: { ...DEFAULT_SETTINGS.cloud } }
  }

  const r = raw as Record<string, unknown>
  const provider: AiProvider =
    r.provider === 'cloud' || r.provider === 'hybrid' ? r.provider : 'local'

  let threshold = typeof r.confidenceThreshold === 'number' ? r.confidenceThreshold : DEFAULT_SETTINGS.confidenceThreshold
  if (!Number.isFinite(threshold)) threshold = DEFAULT_SETTINGS.confidenceThreshold
  threshold = Math.min(1, Math.max(0, threshold))

  const cloudRaw = (r.cloud && typeof r.cloud === 'object' ? r.cloud : {}) as Record<string, unknown>

  return {
    enabled: bool(r.enabled, DEFAULT_SETTINGS.enabled),
    provider,
    localModel: str(r.localModel, DEFAULT_SETTINGS.localModel),
    confidenceThreshold: threshold,
    cloud: {
      baseUrl: str(cloudRaw.baseUrl, DEFAULT_SETTINGS.cloud.baseUrl),
      model: str(cloudRaw.model, DEFAULT_SETTINGS.cloud.model)
    }
  }
}
