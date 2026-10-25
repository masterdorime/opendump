import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { quarantine, listQuarantine, purge, restore, stagedPathFor, inspectStaged } from '../src/shared/executor'
import type { ExecItem } from '../src/shared/executor'

let workspace: string
let quarantineRoot: string
let journalPath: string
let opts: { quarantineRoot: string; journalPath: string; batchId: string }

async function makeFolder(relative: string, contents: Record<string, string> = {}): Promise<string> {
  const full = path.join(workspace, relative)
  await fs.mkdir(full, { recursive: true })
  for (const [name, body] of Object.entries(contents)) {
    await fs.writeFile(path.join(full, name), body)
  }
  return full
}

function item(p: string, tier: ExecItem['tier'] = 'SAFE_PURGE'): ExecItem {
  return { path: p, tier, ruleId: 'test-rule', size: 1024 }
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dsa-exec-'))
  quarantineRoot = path.join(workspace, 'quarantine')
  journalPath = path.join(workspace, 'journal.jsonl')
  opts = { quarantineRoot, journalPath, batchId: 'b1' }
})

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
})

describe('quarantine', () => {
  it('moves a folder out of its original location', async () => {
    const target = await makeFolder('data/cache', { 'a.bin': 'x'.repeat(100) })

    const result = await quarantine([item(target)], opts)

    expect(result.items[0].status).toBe('quarantined')
    expect(existsSync(target)).toBe(false)
    expect(existsSync(result.items[0].dst as string)).toBe(true)
  })

  it('preserves the contents it moved', async () => {
    const target = await makeFolder('data/cache', { 'a.bin': 'hello' })

    const result = await quarantine([item(target)], opts)

    const body = await fs.readFile(path.join(result.items[0].dst as string, 'a.bin'), 'utf8')
    expect(body).toBe('hello')
  })

  it('records the move so it can be listed later', async () => {
    const target = await makeFolder('data/cache')

    await quarantine([item(target)], opts)
    const staged = await listQuarantine(journalPath)

    expect(staged).toHaveLength(1)
    expect(staged[0].src).toBe(target)
    expect(staged[0].status).toBe('quarantined')
  })

  it('reports a skipped item instead of failing the batch when the path is gone', async () => {
    const present = await makeFolder('data/present')
    const missing = path.join(workspace, 'data', 'missing')

    const result = await quarantine([item(missing), item(present)], opts)

    expect(result.items[0].status).toBe('skipped')
    expect(result.items[0].reason).toBeTruthy()
    expect(result.items[1].status).toBe('quarantined')
  })

  it('refuses a drive root', async () => {
    const result = await quarantine([item('C:\\')], opts)

    expect(result.items[0].status).toBe('refused')
    expect(existsSync('C:\\')).toBe(true)
  })

  it('refuses to quarantine its own quarantine folder', async () => {
    const inner = await makeFolder('quarantine/b1/loop')

    const result = await quarantine([item(inner)], opts)

    expect(result.items[0].status).toBe('refused')
    expect(existsSync(inner)).toBe(true)
  })

  it('refuses an item on a different volume than the quarantine folder', async () => {
    const target = await makeFolder('data/cache')
    const otherRoot = path.parse(workspace).root.toLowerCase() === 'z:\\' ? 'y:\\elsewhere' : 'z:\\elsewhere'

    const result = await quarantine([item(target)], { ...opts, quarantineRoot: otherRoot })

    expect(result.items[0].status).toBe('refused')
    expect(result.items[0].reason).toBeTruthy()
    expect(existsSync(target)).toBe(true)
  })

  it('stages onto the item volume when a root resolver is supplied', async () => {
    const target = await makeFolder('data/cache')
    const altRoot = path.join(workspace, 'quarantine-alt')

    const result = await quarantine([item(target)], { ...opts, quarantineRootFor: () => altRoot })

    expect(result.items[0].status).toBe('quarantined')
    expect((result.items[0].dst as string).toLowerCase().startsWith(altRoot.toLowerCase())).toBe(true)
    expect((await listQuarantine(journalPath))[0].status).toBe('quarantined')
  })

  it('refuses protected tiers even if the UI sends them', async () => {
    const target = await makeFolder('data/precious')

    const keep = await quarantine([item(target, 'KEEP')], opts)
    const locked = await quarantine([item(target, 'LOCKED')], opts)

    expect(keep.items[0].status).toBe('refused')
    expect(locked.items[0].status).toBe('refused')
    expect(existsSync(target)).toBe(true)
  })

  it('does not overwrite an existing staged folder', async () => {
    const target = await makeFolder('data/cache', { 'a.bin': 'new' })

    const occupied = stagedPathFor(quarantineRoot, 'b1', target)
    await fs.mkdir(occupied, { recursive: true })
    await fs.writeFile(path.join(occupied, 'a.bin'), 'older')

    const result = await quarantine([item(target)], opts)

    expect(result.items[0].status).toBe('quarantined')
    expect(result.items[0].dst).not.toBe(occupied)
    expect(await fs.readFile(path.join(occupied, 'a.bin'), 'utf8')).toBe('older')
  })
})

describe('restore', () => {
  it('puts a quarantined folder back where it came from', async () => {
    const target = await makeFolder('data/cache', { 'a.bin': 'hello' })

    const result = await quarantine([item(target)], opts)
    const staged = await listQuarantine(journalPath)
    const restored = await restore(staged.map((s) => s.id), { journalPath })

    expect(restored.items[0].status).toBe('restored')
    expect(await fs.readFile(path.join(target, 'a.bin'), 'utf8')).toBe('hello')
    expect(existsSync(result.items[0].dst as string)).toBe(false)
  })

  it('marks the item restored so it is no longer offered for purge', async () => {
    const target = await makeFolder('data/cache')

    await quarantine([item(target)], opts)
    const staged = await listQuarantine(journalPath)
    await restore(staged.map((s) => s.id), { journalPath })

    const after = await listQuarantine(journalPath)
    expect(after[0].status).toBe('restored')
  })

  it('refuses to overwrite something that reappeared at the original path', async () => {
    const target = await makeFolder('data/cache', { 'a.bin': 'original' })

    await quarantine([item(target)], opts)
    await makeFolder('data/cache', { 'a.bin': 'recreated' })

    const staged = await listQuarantine(journalPath)
    const restored = await restore(staged.map((s) => s.id), { journalPath })

    expect(restored.items[0].status).toBe('skipped')
    expect(await fs.readFile(path.join(target, 'a.bin'), 'utf8')).toBe('recreated')
  })
})

describe('purge', () => {
  it('deletes the staged copy', async () => {
    const target = await makeFolder('data/cache', { 'a.bin': 'x' })

    const result = await quarantine([item(target)], opts)
    const staged = await listQuarantine(journalPath)
    const purged = await purge(staged.map((s) => s.id), { journalPath })

    expect(purged.items[0].status).toBe('purged')
    expect(existsSync(result.items[0].dst as string)).toBe(false)
  })

  it('marks the item purged and stops offering it', async () => {
    const target = await makeFolder('data/cache')

    await quarantine([item(target)], opts)
    const staged = await listQuarantine(journalPath)
    await purge(staged.map((s) => s.id), { journalPath })

    const after = await listQuarantine(journalPath)
    expect(after[0].status).toBe('purged')
  })

  it('reports missing when the staged folder was removed by hand', async () => {
    const target = await makeFolder('data/cache')

    const result = await quarantine([item(target)], opts)
    await fs.rm(result.items[0].dst as string, { recursive: true, force: true })

    const staged = await listQuarantine(journalPath)
    const purged = await purge(staged.map((s) => s.id), { journalPath })

    expect(purged.items[0].status).toBe('skipped')
    expect(purged.items[0].reason).toBeTruthy()
  })
})

describe('inspectStaged', () => {
  it('reports how many files are inside the staged copy and which are biggest', async () => {
    const target = await makeFolder('data/cache', {
      'small.bin': 'x'.repeat(512),
      'big.bin': 'x'.repeat(4096)
    })

    await quarantine([item(target)], opts)
    const staged = await listQuarantine(journalPath)
    const [detail] = await inspectStaged(staged)

    expect(detail.fileCount).toBe(2)
    expect(detail.topFiles[0].name).toBe('big.bin')
    expect(detail.topFiles[0].bytes).toBe(4096)
  })

  it('reports zero files when the staged copy is already gone', async () => {
    const target = await makeFolder('data/cache')
    const result = await quarantine([item(target)], opts)
    await fs.rm(result.items[0].dst as string, { recursive: true, force: true })

    const staged = await listQuarantine(journalPath)
    const [detail] = await inspectStaged(staged)

    expect(detail.fileCount).toBe(0)
  })
})

describe('journal', () => {
  it('survives being reread and keeps history order', async () => {
    const a = await makeFolder('data/a')
    const b = await makeFolder('data/b')

    await quarantine([item(a)], opts)
    await quarantine([item(b)], { ...opts, batchId: 'b2' })

    const staged = await listQuarantine(journalPath)
    expect(staged.map((s) => s.src)).toEqual([a, b])
  })
})
