import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadScan } from '../src/shared/scanner'
import { compileRules, findUnclassified } from '../src/shared/rules'
import type { Rule } from '../src/shared/types'
import { OllamaProvider, ollamaModels } from '../src/shared/ai/providers'
import { readHardware } from '../src/shared/ai/hardware'
import { checkRunFeasible } from '../src/shared/ai/catalogue'

const MODEL = process.argv[2] ?? 'qwen3.5:4b-q4_K_M'
const COUNT = Number(process.argv[3] ?? 12) || 12
const BATCH = 12

const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(2)} GB`

async function main(): Promise<void> {
  const scan = await loadScan(join(process.cwd(), '.cache', 'scan.json'))
  if (!scan) throw new Error('no cache — run `npm run scan -- C:\\ --save` first')

  const rules = (JSON.parse(readFileSync(join(process.cwd(), 'rules', 'rules.json'), 'utf8')) as { rules: Rule[] }).rules
  const compiled = compileRules(rules)

  const models = await ollamaModels()
  const installed = models.find((m) => m.name === MODEL || m.name === `${MODEL}:latest`)
  if (!installed) throw new Error(`${MODEL} not installed. Have: ${models.map((m) => m.name).join(', ')}`)

  const hardware = await readHardware()
  const refusal = checkRunFeasible(hardware, installed.sizeBytes)

  console.log(`model:  ${MODEL} (${gb(installed.sizeBytes)})`)
  console.log(`ram:    ${gb(hardware.ramFreeBytes)} free`)
  console.log(
    `vram:   ${hardware.vramFreeBytes === null ? 'unknown (CPU only)' : `${gb(hardware.vramFreeBytes)} free`}`
  )
  console.log(`fit:    ${refusal ?? 'OK'}\n`)
  if (refusal) process.exit(1)

  const targets = findUnclassified(scan, compiled, {
    minBytes: 200 * 1024 * 1024,
    excludeRoots: [process.env.WINDIR]
  }).slice(0, COUNT)

  const items = targets.map((t) => ({
    path: t.path,
    size: t.size,
    files: t.files,
    mtime: t.mtime,
    category: 'unclassified'
  }))

  console.log(`classifying ${items.length} unclassified folders in batches of ${BATCH}…\n`)
  const provider = new OllamaProvider({ model: MODEL })

  const started = Date.now()
  const verdicts: Array<Awaited<ReturnType<OllamaProvider['classify']>>[number]> = []

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH)
    const t0 = Date.now()
    const batchVerdicts = await provider.classify(batch)
    verdicts.push(...batchVerdicts)
    console.log(
      `  batch ${Math.floor(i / BATCH) + 1}: ${batch.length} folders in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    )
  }

  const elapsed = Date.now() - started
  console.log('')
  for (const v of verdicts.slice(0, 10)) {
    const item = items.find((i) => i.path.toLowerCase() === v.path.toLowerCase())
    console.log(`${(item ? item.size / 1024 ** 3 : 0).toFixed(1).padStart(6)} GB  ${v.tier.padEnd(6)} ${v.path}`)
    console.log(`              └─ ${v.reason}`)
  }

  console.log(`\n${verdicts.length}/${items.length} answered in ${(elapsed / 1000).toFixed(1)}s`)
  const perFolder = elapsed / 1000 / Math.max(1, verdicts.length)
  console.log(`~${perFolder.toFixed(2)}s per folder → ~${Math.round(perFolder * items.length)}s for all ${items.length}`)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
