import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanDrive } from '../src/shared/scanner'
import { compileRules, findCandidates, matchRule } from '../src/shared/rules'
import type { Rule } from '../src/shared/types'

const root = process.argv[2]

async function main(): Promise<void> {
  if (!root) {
    console.error('usage: npx tsx scripts/debug.ts <folder-to-scan>')
    process.exit(1)
  }
  const rules = (JSON.parse(readFileSync(join(process.cwd(), 'rules', 'rules.json'), 'utf8')) as { rules: Rule[] }).rules
  const compiled = compileRules(rules)
  const scan = await scanDrive(root)
  const byPath = new Map(scan.dirs.map((d) => [d.p.toLowerCase(), d]))
  const gb = (n: number): string => (n / 1024 ** 3).toFixed(3)

  const cands = findCandidates(scan, compiled)
  console.log('total scan bytes:', gb(scan.totalBytes), 'GB')
  console.log('candidates:', cands.length, 'sum exclusive:', gb(cands.reduce((n, c) => n + c.size, 0)), 'GB')
  console.log('')

  const probes = [
    root,
    root + '\\extensions',
    root + '\\extensions\\anthropic.claude-code-2.1.309-win32-x64',
    root + '\\extensions\\anthropic.claude-code-2.1.309-win32-x64\\resources',
    root + '\\extensions\\anthropic.claude-code-2.1.309-win32-x64\\resources\\native-binary'
  ]

  for (const p of probes) {
    const d = byPath.get(p.toLowerCase())
    const c = cands.find((x) => x.path.toLowerCase() === p.toLowerCase())
    const rule = d ? matchRule(p, d.s, compiled) : null
    console.log(
      `${gb(d?.s ?? 0).padStart(8)} GB real | ${gb(c?.size ?? 0).padStart(8)} excl | rule=${rule?.id ?? 'none'} | ${p}`
    )
  }
}

void main()
