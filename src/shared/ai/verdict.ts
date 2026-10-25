export type AiTier = 'REVIEW' | 'KEEP'

export interface AiVerdict {
  path: string
  tier: AiTier
  reason: string
  confidence: number
  source?: 'local' | 'cloud'
  model?: string
}

export class AiParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiParseError'
  }
}

/**
 * Parse a model response into verdicts.
 *
 * Three safety properties, all enforced here rather than trusted to the model:
 *
 * 1. The tier ceiling is REVIEW. Anything else — `SAFE_PURGE`, `DELETE`, an
 *    invented string — is coerced to REVIEW. A model cannot authorise deletion.
 * 2. Paths the model was never given are discarded. This blocks invented paths
 *    and protects against a prompt-injected listing naming something outside
 *    the batch.
 * 3. Confidence is clamped, and a missing reason gets a visible placeholder
 *    rather than silently rendering an empty explanation.
 */
export function parseVerdicts(raw: string, allowed: Set<string>): AiVerdict[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AiParseError('malformed JSON: model did not return parseable output')
  }

  const container = parsed as { results?: unknown }
  if (!container || typeof container !== 'object' || !Array.isArray(container.results)) {
    throw new AiParseError('malformed output: expected an object with a "results" array')
  }

  const canonical = new Map<string, string>()
  for (const p of allowed) canonical.set(p.toLowerCase(), p)

  const out: AiVerdict[] = []
  for (const item of container.results as Array<Record<string, unknown>>) {
    if (!item || typeof item.path !== 'string') continue
    const resolved = canonical.get(item.path.toLowerCase())
    if (!resolved) continue

    const tier: AiTier = item.tier === 'KEEP' ? 'KEEP' : 'REVIEW'

    let confidence = typeof item.confidence === 'number' ? item.confidence : Number(item.confidence)
    if (!Number.isFinite(confidence)) confidence = 0.5
    confidence = Math.min(1, Math.max(0, confidence))

    const reason =
      typeof item.reason === 'string' && item.reason.trim().length > 0
        ? item.reason.trim()
        : 'No reason given by the model.'

    out.push({ path: resolved, tier, reason, confidence })
  }

  return out
}

/**
 * Local verdicts below this confidence go to the cloud provider when hybrid
 * mode is on. Above it, the local model's opinion is taken at face value.
 */
export function needsEscalation(verdict: Pick<AiVerdict, 'confidence'>, threshold = 0.7): boolean {
  return verdict.confidence < threshold
}
