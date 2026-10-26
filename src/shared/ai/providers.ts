import { AiParseError, parseVerdicts, needsEscalation, type AiVerdict } from './verdict'

export interface ClassifyItem {
  path: string
  size: number
  files: number
  mtime: number
  category: string
}

export interface Classifier {
  readonly id: 'local' | 'cloud'
  readonly model: string
  classify(items: ClassifyItem[], signal?: AbortSignal): Promise<AiVerdict[]>
}

/**
 * The model is asked for `results` as an object root rather than a bare array,
 * because several runtimes only support object-rooted schemas.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          tier: { type: 'string', enum: ['REVIEW', 'KEEP'] },
          reason: { type: 'string' },
          confidence: { type: 'number' }
        },
        required: ['path', 'tier', 'reason', 'confidence']
      }
    }
  },
  required: ['results']
} as const

const SYSTEM_PROMPT = `You help a Windows user decide which folders are safe to remove to free disk space.

For each folder you receive: its path, size, file count, last-modified date and the rule category that matched it.

Answer with a tier and a short factual reason:
- "REVIEW" — this might be removable, but a human must confirm. Use this when you are unsure.
- "KEEP" — this is user data, or you cannot establish what it is.

You must never assert that something is safe to delete. You cannot authorise deletion; the maximum you can say is REVIEW.

Reasoning guidance:
- Build caches, package manager caches, shader caches, crash dumps, temporary files and compiled artefacts regenerate automatically.
- Application data that contains user-created content (project files, saves, documents, media) must be KEEP.
- Emulator images, VM disks, model weights and downloaded toolchains are re-downloadable but expensive; that is REVIEW, not removal.
- If the folder name suggests a person, a client, a document or a project, prefer KEEP.
- If you do not recognise the application, say so and use low confidence.

Confidence is 0..1 and must reflect how certain you are that your *reason* is accurate, not how strong your opinion is.

Give one entry per input path, using the exact path string you were given.`

function describe(item: ClassifyItem): Record<string, unknown> {
  return {
    path: item.path,
    sizeGB: Number((item.size / 1024 ** 3).toFixed(2)),
    files: item.files,
    lastModified: item.mtime ? new Date(item.mtime).toISOString().slice(0, 10) : 'unknown',
    matchedCategory: item.category
  }
}

export function buildMessages(items: ClassifyItem[]): Array<{ role: string; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Classify these ${items.length} folders.\n\n${JSON.stringify(items.map(describe), null, 1)}`
    }
  ]
}

export interface OllamaOptions {
  baseUrl?: string
  model?: string
  timeoutMs?: number
}

export class OllamaProvider implements Classifier {
  readonly id = 'local' as const
  readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
    this.model = opts.model ?? 'qwen3.5:4b-q4_K_M'
    this.timeoutMs = opts.timeoutMs ?? 180_000
  }

  async classify(items: ClassifyItem[], signal?: AbortSignal): Promise<AiVerdict[]> {
    if (items.length === 0) return []
    const allowed = new Set(items.map((i) => i.path))

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages: buildMessages(items),
        stream: false,
        // Qwen 3.5 thinks by default. For labelling, thinking costs hundreds of
        // tokens per folder and buys nothing — turn it off explicitly.
        think: false,
        format: VERDICT_SCHEMA,
        options: { temperature: 0, num_ctx: 4096 },
        // Unload immediately after the batch. Even at 100% GPU offload the
        // runner costs ~1.3 GB of host RAM, and on an 11.7 GB laptop that is
        // the difference between the machine being usable and not.
        keep_alive: '0'
      })
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Ollama returned ${response.status}: ${body.slice(0, 200)}`)
    }

    const payload = (await response.json()) as { message?: { content?: string } }
    const content = payload.message?.content
    if (!content) throw new AiParseError('malformed output: Ollama returned no message content')

    return parseVerdicts(content, allowed).map((v) => ({
      ...v,
      source: 'local' as const,
      model: this.model
    }))
  }
}

export interface CloudOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
}

/**
 * Any OpenAI-compatible endpoint. Uses `json_object` mode plus the schema in the
 * prompt rather than `json_schema`, because strict schema mode is not universally
 * supported — and the response is validated on this side regardless.
 */
export class CloudProvider implements Classifier {
  readonly id = 'cloud' as const
  readonly model: string
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(opts: CloudOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.timeoutMs = opts.timeoutMs ?? 120_000
  }

  async classify(items: ClassifyItem[], signal?: AbortSignal): Promise<AiVerdict[]> {
    if (items.length === 0) return []
    const allowed = new Set(items.map((i) => i.path))

    const messages = buildMessages(items)
    messages[0] = {
      role: 'system',
      content:
        messages[0].content +
        `\n\nReply with a single JSON object shaped exactly like:\n${JSON.stringify(VERDICT_SCHEMA)}`
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' }
      })
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Cloud provider returned ${response.status}: ${body.slice(0, 200)}`)
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new AiParseError('malformed output: cloud provider returned no content')

    return parseVerdicts(content, allowed).map((v) => ({
      ...v,
      source: 'cloud' as const,
      model: this.model
    }))
  }
}

export interface HybridResult {
  verdicts: AiVerdict[]
  localCount: number
  escalatedCount: number
  cloudError?: string
}

/**
 * Local first, cloud only for the folders the local model was unsure about.
 * A cloud failure degrades to the local verdicts rather than failing the run.
 */
export async function classifyHybrid(
  items: ClassifyItem[],
  local: Classifier,
  cloud: Classifier | null,
  threshold = 0.7,
  onProgress?: (stage: string, done: number, total: number) => void,
  batchSize = 12
): Promise<HybridResult> {
  const localVerdicts: AiVerdict[] = []

  // Batched rather than one giant request: a single call gives the UI nothing to
  // show for minutes, and one slow folder would hold up the whole run.
  onProgress?.('local', 0, items.length)
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    localVerdicts.push(...(await local.classify(batch)))
    onProgress?.('local', Math.min(i + batchSize, items.length), items.length)
  }

  if (!cloud) return { verdicts: localVerdicts, localCount: localVerdicts.length, escalatedCount: 0 }

  const weak = localVerdicts.filter((v) => needsEscalation(v, threshold))
  const byPath = new Map(localVerdicts.map((v) => [v.path.toLowerCase(), v]))
  const missing = items.filter((i) => !byPath.has(i.path.toLowerCase()))

  const toEscalate = new Set([...weak.map((v) => v.path.toLowerCase()), ...missing.map((i) => i.path.toLowerCase())])
  if (toEscalate.size === 0) {
    return { verdicts: localVerdicts, localCount: localVerdicts.length, escalatedCount: 0 }
  }

  const escalateItems = items.filter((i) => toEscalate.has(i.path.toLowerCase()))
  onProgress?.('cloud review', 0, escalateItems.length)

  try {
    const cloudVerdicts = await cloud.classify(escalateItems)
    onProgress?.('cloud review', escalateItems.length, escalateItems.length)

    const merged = new Map(byPath)
    for (const v of cloudVerdicts) merged.set(v.path.toLowerCase(), v)

    return {
      verdicts: [...merged.values()],
      localCount: localVerdicts.length,
      escalatedCount: escalateItems.length
    }
  } catch (err) {
    return {
      verdicts: localVerdicts,
      localCount: localVerdicts.length,
      escalatedCount: escalateItems.length,
      cloudError: (err as Error).message
    }
  }
}

export async function ollamaReachable(baseUrl = 'http://127.0.0.1:11434'): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2500)
    })
    return res.ok
  } catch {
    return false
  }
}

export interface InstalledModel {
  name: string
  sizeBytes: number
}

export async function ollamaModels(baseUrl = 'http://127.0.0.1:11434'): Promise<InstalledModel[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
    signal: AbortSignal.timeout(4000)
  })
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`)
  const body = (await res.json()) as { models?: Array<{ name: string; size: number }> }
  return (body.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size }))
}
