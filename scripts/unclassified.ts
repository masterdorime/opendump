import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadScan } from '../src/shared/scanner'
import { compileRules, findUnclassified } from '../src/shared/rules'
import type { Rule } from '../src/shared/types'

const cachePath = process.argv[2] ?? join(process.cwd(), '.cache', 'scan.json')

async function main(): Promise<void> {
  const scan = await loadScan(cachePath)
  if (!scan) throw new Error(`no cache at ${cachePath}`)

  const rules = (JSON.parse(readFileSync(join(process.cwd(), 'rules', 'rules.json'), 'utf8')) as { rules: Rule[] }).rules
  const found = findUnclassified(scan, compileRules(rules), {
    minBytes: 200 * 1024 * 1024,
    excludeRoots: [process.env.WINDIR]
  })

  const total = found.reduce((n, f) => n + f.size, 0)
  console.log(`${found.length} unknown folders, ${(total / 1024 ** 3).toFixed(1)} GB total\n`)
  for (const f of found.slice(0, 25)) {
    console.log(`  ${(f.size / 1024 ** 3).toFixed(2).padStart(7)} GB  ${f.path}`)
  }
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
