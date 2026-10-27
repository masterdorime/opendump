/**
 * Evaluate the local model's judgement against ground truth we can defend.
 *
 * What this measures, and what it does not:
 *
 * - PROTECTED set: folders the deterministic rules mark KEEP. The dangerous
 *   failure for this app is a protected folder being offered for removal, so
 *   "did the model also say KEEP" is a real safety number.
 * - UNCLASSIFIED set: folders the rules do not know. This is the model's actual
 *   job, but there is no ground truth for them, so we only report how often it
 *   protects vs reviews, and whether it is stable.
 * - Ceiling: the raw response is inspected before parsing, to see whether the
 *   model ever TRIES to say something stronger than REVIEW. parseVerdicts would
 *   coerce it, but an attempt is still worth knowing about.
 *
 * Run: npx tsx scripts/ai-eval.ts --items 16 --batch 8
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { loadScan } from '../src/shared/scanner'
import { compileRules, findCandidates, findUnclassified } from '../src/shared/rules'
import { OllamaProvider } from '../src/shared/ai/providers'
import type { ClassifyItem } from '../src/shared/ai/providers'
import type { Rule } from '../src/shared/types'

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) ? value : fallback
}

function model(): string {
  const index = process.argv.indexOf('--model')
  return index === -1 ? 'qwen3.5:4b-q4_K_M' : String(process.argv[index + 1])
}

function pct(part: number, whole: number): string {
  if (whole === 0) return 'n/a'
  return `${((part / whole) * 100).toFixed(1)}%`
}

/** Take `count` items spread across the list, not just the largest. */
function sample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items
  const step = items.length / count
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)])
}

async function main(): Promise<void> {
  const itemsPerSet = arg('items', 16)
  const batchSize = arg('batch', 8)
  const modelName = model()

  const cachePath = join(
    process.env.APPDATA ?? '',
    'opendump',
    'scan-cache.json'
  )
  if (!existsSync(cachePath)) {
    console.error(`no scan cache at ${cachePath} — run a scan in v1 first`)
    process.exit(1)
  }

  const scan = await loadScan(cachePath)
  if (!scan) {
    console.error('scan cache could not be parsed')
    process.exit(1)
  }

  const document = JSON.parse(
    readFileSync(join(process.cwd(), 'rules', 'rules.json'), 'utf8')
  ) as { rules: Rule[] }
  const compiled = compileRules(document.rules)

  const candidates = findCandidates(scan, compiled)
  const protectedFolders = sample(
    candidates.filter((candidate) => candidate.tier === 'KEEP'),
    itemsPerSet
  )
  const unclassified = sample(
    findUnclassified(scan, compiled, { minBytes: 500 * 1024 * 1024 }),
    itemsPerSet
  )

  if (protectedFolders.length === 0 || unclassified.length === 0) {
    console.error('not enough folders in one of the sets')
    process.exit(1)
  }

  const toItem = (entry: {
    path: string
    totalSize: number
    files: number
    mtime: number
    category: string
  }): ClassifyItem => ({
    path: entry.path,
    size: entry.totalSize,
    files: entry.files,
    mtime: entry.mtime,
    category: entry.category
  })

  const protectedItems = protectedFolders.map((candidate) => toItem(candidate))
  const unclassifiedItems: ClassifyItem[] = unclassified.map((entry) => ({
    path: entry.path,
    size: entry.size,
    files: entry.files,
    mtime: entry.mtime,
    category: 'unclassified'
  }))

  console.log(`model      ${modelName}`)
  console.log(`cache      ${scan.root} · ${scan.totalDirs.toLocaleString()} folders`)
  console.log(
    `sets       ${protectedItems.length} rule-protected · ${unclassifiedItems.length} unclassified`
  )

  // Capture the raw model output before parseVerdicts coerces anything.
  const rawResponses: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await realFetch(input, init)
    try {
      const body = (await response.clone().json()) as {
        message?: { content?: string }
      }
      if (body.message?.content) rawResponses.push(body.message.content)
    } catch {
      // A non-JSON body is a failure the provider will report itself.
    }
    return response
  }) as typeof fetch

  const provider = new OllamaProvider({ model: modelName, timeoutMs: 300_000 })

  const started = Date.now()
  let parsedBatches = 0
  let failedBatches = 0
  let latencyMs = 0
  let asked = 0

  const verdicts = new Map<string, 'KEEP' | 'REVIEW'>()

  async function runSet(label: string, items: ClassifyItem[]): Promise<void> {
    for (let at = 0; at < items.length; at += batchSize) {
      const batch = items.slice(at, at + batchSize)
      const before = Date.now()
      try {
        const result = await provider.classify(batch)
        latencyMs += Date.now() - before
        parsedBatches += 1
        asked += batch.length
        for (const verdict of result) {
          verdicts.set(verdict.path.toLowerCase(), verdict.tier)
        }
      } catch (error) {
        failedBatches += 1
        console.error(`  ${label} batch ${at / batchSize} failed: ${String(error).slice(0, 160)}`)
      }
    }
  }

  console.log('\nrunning…')
  await runSet('protected', protectedItems)
  await runSet('unclassified', unclassifiedItems)

  // Determinism: ask the first protected batch a second time.
  let repeat = 0
  let repeatSame = 0
  const firstBatch = protectedItems.slice(0, batchSize)
  try {
    const again = await provider.classify(firstBatch)
    for (const verdict of again) {
      repeat += 1
      if (verdicts.get(verdict.path.toLowerCase()) === verdict.tier) repeatSame += 1
    }
  } catch {
    // Counted as no evidence.
  }

  globalThis.fetch = realFetch

  // Raw-ceiling scan: did the model ever TRY to say something stronger?
  let rawEntries = 0
  let rareOverreach = 0
  for (const raw of rawResponses) {
    try {
      const body = JSON.parse(raw) as { results?: Array<{ tier?: unknown }> }
      for (const entry of body.results ?? []) {
        rawEntries += 1
        if (entry.tier !== 'KEEP' && entry.tier !== 'REVIEW') rareOverreach += 1
      }
    } catch {
      rareOverreach += 0
    }
  }

  const keptProtected = protectedItems.filter(
    (item) => verdicts.get(item.path.toLowerCase()) === 'KEEP'
  ).length
  const keptUnclassified = unclassifiedItems.filter(
    (item) => verdicts.get(item.path.toLowerCase()) === 'KEEP'
  ).length
  const answered = protectedItems.length + unclassifiedItems.length
  const withVerdict = [...protectedItems, ...unclassifiedItems].filter((item) =>
    verdicts.has(item.path.toLowerCase())
  ).length

  console.log('\n──────────────────────────── results ────────────────────────────')
  console.log(`items asked            ${asked} in ${parsedBatches} batches (${failedBatches} failed)`)
  console.log(`answered               ${withVerdict}/${answered}  ${pct(withVerdict, answered)}`)
  console.log(
    `PROTECTED → KEEP       ${keptProtected}/${protectedItems.length}  ${pct(keptProtected, protectedItems.length)}   ← safety number`
  )
  console.log(
    `unclassified → KEEP    ${keptUnclassified}/${unclassifiedItems.length}  ${pct(keptUnclassified, unclassifiedItems.length)}   (no ground truth; conservatism)`
  )
  console.log(
    `ceiling attempts       ${rareOverreach} of ${rawEntries} raw entries tried to exceed REVIEW  ${pct(rawEntries - rareOverreach, rawEntries)} respected`
  )
  console.log(
    `determinism           ${repeatSame}/${repeat} identical on a repeat run  ${pct(repeatSame, repeat)}`
  )
  console.log(
    `latency                ${(latencyMs / Math.max(1, parsedBatches)).toFixed(0)} ms per batch · ${((Date.now() - started) / 1000).toFixed(1)} s total`
  )

  const misses = protectedItems.filter(
    (item) => verdicts.get(item.path.toLowerCase()) !== 'KEEP'
  )
  if (misses.length > 0) {
    console.log('\nprotected folders the model did NOT keep:')
    for (const miss of misses.slice(0, 8)) {
      const said = verdicts.get(miss.path.toLowerCase()) ?? 'no answer'
      console.log(`  ${said.padEnd(10)} ${miss.path}`)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
