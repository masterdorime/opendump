import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadScan } from '../src/shared/scanner'
import { compileRules, findCandidates } from '../src/shared/rules'
import type { Rule } from '../src/shared/types'

const cachePath = process.argv[2] ?? join(process.cwd(), '.cache', 'scan.json')
const rulesPath = process.argv[3] ?? join(process.cwd(), 'rules', 'rules.json')

async function main(): Promise<void> {
  const scan = await loadScan(cachePath)
  if (!scan) throw new Error(`no cache at ${cachePath}`)

  const rules = (JSON.parse(readFileSync(rulesPath, 'utf8')) as { rules: Rule[] }).rules
  const candidates = findCandidates(scan, compileRules(rules))

  const byRule = new Map<string, { n: number; bytes: number }>()
  for (const c of candidates) {
    const acc = byRule.get(c.ruleId) ?? { n: 0, bytes: 0 }
    acc.n++
    acc.bytes += c.size
    byRule.set(c.ruleId, acc)
  }

  console.log(`cache: ${cachePath}`)
  console.log(`dirs: ${scan.totalDirs.toLocaleString()}  bytes: ${(scan.totalBytes / 1024 ** 3).toFixed(2)} GB`)
  console.log(`candidates: ${candidates.length}\n`)

  for (const [id, v] of [...byRule.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${String(v.n).padStart(4)}  ${(v.bytes / 1024 ** 3).toFixed(2).padStart(8)} GB  ${id}`)
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
