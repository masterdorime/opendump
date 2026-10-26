export interface PullProgress {
  status: string
  completed: number
  total: number
  /** True once the pull has finished or failed. */
  done: boolean
  error?: string
}

/**
 * Ollama streams `/api/pull` as newline-delimited JSON. Chunks can arrive split,
 * so the caller buffers by newline; this parses exactly one line.
 */
export function parsePullLine(line: string): PullProgress | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  const obj = payload as Record<string, unknown>

  if (typeof obj.error === 'string' && obj.error.length > 0) {
    return { status: 'error', completed: 0, total: 0, done: true, error: obj.error }
  }

  const status = typeof obj.status === 'string' ? obj.status : ''
  if (!status) return null

  const completed = typeof obj.completed === 'number' ? obj.completed : 0
  const total = typeof obj.total === 'number' ? obj.total : 0

  return { status, completed, total, done: status === 'success' }
}
