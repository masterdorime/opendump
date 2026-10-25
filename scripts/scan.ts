import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanDrive, saveScan, driveSpace, loadScan } from '../src/shared/scanner'
import { compileRules, findCandidates } from '../src/shared/rules'
import type { Rule } from '../src/shared/types'

const root = process.argv[2] ?? 'C:\\'
const shouldSave = process.argv.includes('--save')
const useCache = process.argv.includes('--cached')

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

async function main(): Promise<void> {
  const rulesRaw = readFileSync(join(process.cwd(), 'rules', 'rules.json'), 'utf8')
  const rules = (JSON.parse(rulesRaw) as { rules: Rule[] }).rules
  const compiled = compileRules(rules)

  console.log(`scanning ${root} with ${rules.length} rules…\n`)
  const t0 = Date.now()
  let lastTick = 0

  const cached = useCache ? await loadScan(join(process.cwd(), '.cache', 'scan.json')) : null

  const scan =
    cached ??
    (await scanDrive(root, {
      onProgress: (p) => {
        const now = Date.now()
        if (now - lastTick < 1500) return
        lastTick = now
        process.stdout.write(
          `\r  ${p.dirs.toLocaleString()} dirs · ${p.files.toLocaleString()} files · ${gb(p.bytes)} · ${(
            p.elapsedMs / 1000
          ).toFixed(1)}s   `
        )
      }
    }))

  const elapsed = (Date.now() - t0) / 1000
  console.log(`\r${' '.repeat(90)}\r`)

  const space = await driveSpace(root.slice(0, 2))
  console.log(`scanned in ${elapsed.toFixed(1)}s`)
  console.log(`  dirs:    ${scan.totalDirs.toLocaleString()}`)
  console.log(`  files:   ${scan.totalFiles.toLocaleString()}`)
  console.log(`  bytes:   ${gb(scan.totalBytes)}`)
  console.log(`  skipped: ${scan.skipped.toLocaleString()} (access denied / reparse points)`)
  if (space) console.log(`  free:    ${gb(space.free)} of ${gb(space.total)}\n`)

  const classifyT0 = Date.now()
  const candidates = findCandidates(scan, compiled)
  const classifyMs = Date.now() - classifyT0
  console.log(`classification took ${classifyMs} ms`)
  const byTier = candidates.reduce<Record<string, { n: number; bytes: number }>>((acc, c) => {
    acc[c.tier] = acc[c.tier] ?? { n: 0, bytes: 0 }
    acc[c.tier].n++
    acc[c.tier].bytes += c.size
    return acc
  }, {})

  console.log('candidates by tier:')
  for (const [tier, v] of Object.entries(byTier)) {
    console.log(`  ${tier.padEnd(11)} ${String(v.n).padStart(4)} items  ${gb(v.bytes).padStart(10)}`)
  }

  console.log('\nall SAFE_PURGE:')
  for (const c of candidates.filter((c) => c.tier === 'SAFE_PURGE')) {
    console.log(`  ${gb(c.size).padStart(10)}  ${c.path}`)
  }

  console.log('\ntop 25:')
  for (const c of candidates.slice(0, 25)) {
    const flag = c.blocked ? ` [holds ${gb(c.blockedBytes)} protected]` : ''
    console.log(`  ${c.tier.padEnd(11)} ${gb(c.size).padStart(10)}  ${c.path}${flag}`)
  }

  if (shouldSave) {
    const out = join(process.cwd(), '.cache', 'scan.json')
    await saveScan(scan, out)
    console.log(`\ncache written to ${out}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
