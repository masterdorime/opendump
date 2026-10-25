import { join } from 'node:path'
import { listQuarantine, restore } from '../src/shared/executor'

// Resolve the app's user-data journal from the environment rather than a
// hardcoded profile. Pass a path explicitly to inspect a portable profile.
const defaultJournal = join(process.env.APPDATA ?? '', 'Drive Size Audit', 'journal.jsonl')

async function main(): Promise<void> {
  const journalPath = process.argv[2] ?? defaultJournal
  if (!journalPath || !process.env.APPDATA) {
    console.error('usage: npx tsx scripts/restore-all.ts [journal.jsonl]')
    process.exit(1)
  }
  const all = await listQuarantine(journalPath)
  const active = all.filter((i) => i.status === 'quarantined')
  console.log(`journal: ${journalPath}`)
  console.log(`staged:  ${active.length}`)
  for (const item of active) console.log(`  ${(item.bytes / 1024 ** 3).toFixed(2)} GB  ${item.src}`)

  if (active.length === 0) return
  const result = await restore(
    active.map((i) => i.id),
    { journalPath }
  )
  for (const r of result.items) console.log(`  ${r.status.padEnd(10)} ${r.path}${r.reason ? ` — ${r.reason}` : ''}`)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
