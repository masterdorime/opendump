import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadScan } from '../src/shared/scanner'
import { compileRules, findCandidates } from '../src/shared/rules'
import type { Rule } from '../src/shared/types'
import { OllamaProvider, ollamaModels } from '../src/shared/ai/providers'
import { canFit } from '../src/shared/ai/preflight'

const MODEL = process.argv[2] ?? 'qwen3.5:4b-q4_K_M'

async function main(): Promise<void> {
  const scan = await loadScan(join(process.cwd(), '.cache', 'scan.json'))
  if (!scan) throw new Error('no cache — run `npm run scan -- C:\\ --save` first')

  const rules = (JSON.parse(readFileSync(join(process.cwd(), 'rules', 'rules.json'), 'utf8')) as { rules: Rule[] }).rules
  const candidates = findCandidates(scan, compileRules(rules))

  const models = await ollamaModels()
  const installed = models.find((m) => m.name === MODEL || m.name === `${MODEL}:latest`)
  if (!installed) throw new Error(`${MODEL} not installed. Have: ${models.map((m) => m.name).join(', ')}`)

  const gpuFree = 7.8 * 1024 ** 3
  const fit = canFit(installed.sizeBytes, gpuFree)
  console.log(`model:   ${MODEL} (${(installed.sizeBytes / 1024 ** 3).toFixed(1)} GB)`)
  console.log(`fit:     ${fit.ok ? 'OK' : 'WILL SPILL'} — ${fit.reason}\n`)

  const sample = candidates
    .filter((c) => c.tier === 'REVIEW')
    .sort((a, b) => b.size - a.size)
    .slice(0, 8)

  const items = sample.map((c) => ({
    path: c.path,
    size: c.size,
    files: c.files,
    mtime: c.mtime,
    category: c.category
  }))

  console.log(`classifying ${items.length} real folders…\n`)
  const provider = new OllamaProvider({ model: MODEL })

  const started = Date.now()
  const verdicts = await provider.classify(items)
  const elapsed = Date.now() - started

  for (const v of verdicts) {
    const item = items.find((i) => i.path.toLowerCase() === v.path.toLowerCase())
    const gb = item ? (item.size / 1024 ** 3).toFixed(1) : '?'
    console.log(`${gb.padStart(5)} GB  ${v.tier.padEnd(6)} ${v.confidence.toFixed(2)}  ${v.path}`)
    console.log(`             └─ ${v.reason}`)
  }

  console.log(`\n${verdicts.length}/${items.length} answered in ${(elapsed / 1000).toFixed(1)}s`)
  console.log(`~${(verdicts.length / (elapsed / 1000)).toFixed(2)} folders/sec → ~${Math.round(
    (150 / verdicts.length) * (elapsed / 1000)
  )}s for 150 folders`)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
