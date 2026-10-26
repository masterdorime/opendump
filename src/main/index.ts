import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join, parse, dirname, resolve } from 'node:path'
import { existsSync, mkdirSync, copyFileSync, cpSync, promises as fs } from 'node:fs'
import { scanDrive, saveScan, loadScan, driveSpace } from '@shared/scanner'
import { compileRules, findCandidates, setPathOverrides } from '@shared/rules'
import { quarantine, listQuarantine, purge, restore, inspectStaged } from '@shared/executor'
import type { ExecItem, QuarantineItem, StagedDetail } from '@shared/executor'
import type {
  AppState,
  Rule,
  ScanProgress,
  ScanResult,
  Tier,
  TreeNode
} from '@shared/types'

const DRIVE = (process.env.DSA_DRIVE ?? process.env.SystemDrive ?? 'C:').replace(/[\\/]+$/, '')
const CACHE_OVERRIDE = process.env.DSA_CACHE

// Pin the user-data location so the cache path is predictable regardless of
// how Electron resolves the package name.
app.setName('opendump')

// Portable profile: lets a run use an isolated cache/journal/quarantine root.
if (process.env.DSA_USERDATA) {
  app.setPath('userData', process.env.DSA_USERDATA)
} else {
  migrateLegacyProfile()
}

let mainWindow: BrowserWindow | null = null
let cachedScan: ScanResult | null = null
let scanning = false

const cachePath = (): string => CACHE_OVERRIDE ?? join(app.getPath('userData'), 'scan-cache.json')
const defaultQuarantineRoot = (): string => join(app.getPath('userData'), 'quarantine')
const journalPath = (): string => join(app.getPath('userData'), 'journal.jsonl')

/**
 * One-time carry-over from the previous product name.
 *
 * Renaming the app moves `app.getPath('userData')`, which would otherwise orphan
 * the scan cache and the execution journal. Copy rather than move: a partial
 * migration must never be able to lose someone's journal.
 */
function migrateLegacyProfile(): void {
  const appData = process.env.APPDATA
  if (!appData) return

  const legacyDir = join(appData, 'Drive Size Audit')
  if (!existsSync(legacyDir)) return

  const current = app.getPath('userData')
  if (resolve(current).toLowerCase() === resolve(legacyDir).toLowerCase()) return

  const alreadyHasData =
    existsSync(join(current, 'scan-cache.json')) || existsSync(join(current, 'journal.jsonl'))
  if (alreadyHasData) return

  try {
    mkdirSync(current, { recursive: true })
    for (const name of ['scan-cache.json', 'journal.jsonl']) {
      const from = join(legacyDir, name)
      if (existsSync(from)) copyFileSync(from, join(current, name))
    }
    const legacyQuarantine = join(legacyDir, 'quarantine')
    if (existsSync(legacyQuarantine)) {
      cpSync(legacyQuarantine, join(current, 'quarantine'), { recursive: true })
    }
  } catch {
    // A failed carry-over leaves the app on a fresh profile; it must not crash startup.
  }
}

/**
 * Staging must live on the same volume as the item, because a move is a rename.
 * The system volume uses the app's own data folder; any other volume gets a
 * folder at its root, so cleaning a second drive works instead of being refused.
 */
function quarantineRootFor(srcPath: string): string {
  const srcRoot = parse(srcPath).root
  const appRoot = parse(app.getPath('userData')).root
  if (srcRoot.toLowerCase() === appRoot.toLowerCase()) return defaultQuarantineRoot()
  return join(srcRoot, 'DriveSizeAuditQuarantine')
}

function rulesPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'rules', 'rules.json')
    : join(app.getAppPath(), 'rules', 'rules.json')
}

/**
 * User rules live beside the shipped set and are prepended, so they win the
 * first-match race. Editing the shipped file works too, but `overrides.json`
 * survives an app update.
 */
function overridesPath(): string {
  return join(dirname(rulesPath()), 'overrides.json')
}

async function loadRules(): Promise<{ rules: Rule[]; version: number }> {
  const raw = await fs.readFile(rulesPath(), 'utf8')
  const parsed = JSON.parse(raw) as { version?: number; rules: Rule[] }
  let rules = parsed.rules ?? []

  try {
    const userRaw = await fs.readFile(overridesPath(), 'utf8')
    const user = JSON.parse(userRaw) as { rules?: Rule[] }
    if (Array.isArray(user.rules)) rules = [...user.rules, ...rules]
  } catch {
    /* no overrides file — the common case */
  }

  return { rules, version: parsed.version ?? 1 }
}

function parentPath(p: string): string | null {
  if (/^[a-z]:\\?$/i.test(p)) return null
  const i = p.lastIndexOf('\\')
  if (i === 2) return p.slice(0, 3)
  if (i < 2) return null
  return p.slice(0, i)
}

function baseName(p: string): string {
  const trimmed = p.replace(/\\+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('\\') + 1)
}

/**
 * Build a pruned tree for rendering.
 *
 * A 470 GB drive has ~100k directories; a treemap only needs the ones big
 * enough to occupy a pixel. Anything under ~0.02% of the drive is dropped,
 * which keeps the payload small enough to cross IPC instantly without
 * changing what the map communicates.
 */
function buildTree(scan: ScanResult, tiers: Map<string, Tier>): TreeNode {
  const byPath = new Map(scan.dirs.map((d) => [d.p, d]))
  const candTier = tiers

  const minNode = Math.max(25 * 1024 * 1024, scan.totalBytes * 0.0002)

  const childrenMap = new Map<string, string[]>()
  for (const d of scan.dirs) {
    if (d.p === scan.root) continue
    const parent = parentPath(d.p)
    if (!parent) continue
    const arr = childrenMap.get(parent) ?? []
    arr.push(d.p)
    childrenMap.set(parent, arr)
  }

  const build = (p: string, inherited: Tier | null): TreeNode => {
    const own = candTier.get(p) ?? null
    const tier = own ?? inherited
    const kids = (childrenMap.get(p) ?? [])
      .filter((k) => (byPath.get(k)?.s ?? 0) >= minNode)
      .sort((a, b) => (byPath.get(b)?.s ?? 0) - (byPath.get(a)?.s ?? 0))

    return {
      path: p,
      name: p === scan.root ? p.replace(/\\+$/, '') : baseName(p),
      size: byPath.get(p)?.s ?? 0,
      tier,
      children: kids.map((k) => build(k, tier))
    }
  }

  return build(scan.root, null)
}

async function buildState(scan: ScanResult): Promise<AppState> {
  const { rules, version } = await loadRules()
  const compiled = compileRules(rules)

  // Collected during the single classification pass: display-only rules never
  // become review candidates, but the map still needs their colour.
  const tierByPath = new Map<string, Tier>()
  const allCandidates = findCandidates(scan, compiled, {
    onMatched: (p, tier) => tierByPath.set(p, tier)
  })
  const space = await driveSpace(DRIVE)

  // Folders already sitting in quarantine must not be offered a second time.
  const staged = await listQuarantine(journalPath())
  const heldSrcs = staged
    .filter((s) => s.status === 'quarantined' || s.status === 'interrupted')
    .map((s) => s.src.toLowerCase())

  const candidates =
    heldSrcs.length === 0
      ? allCandidates
      : allCandidates.filter(
          (c) =>
            !heldSrcs.some(
              (held) => c.path.toLowerCase() === held || c.path.toLowerCase().startsWith(held + '\\')
            )
        )

  return {
    drive: DRIVE,
    meta: {
      root: scan.root,
      scannedAt: scan.scannedAt,
      durationMs: scan.durationMs,
      totalBytes: scan.totalBytes,
      totalDirs: scan.totalDirs,
      totalFiles: scan.totalFiles,
      skipped: scan.skipped
    },
    tree: buildTree(scan, tierByPath),
    candidates,
    space,
    rulesVersion: version,
    quarantinedSrcs: staged.filter((s) => s.status === 'quarantined').map((s) => s.src)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#080b10',
    title: 'opendump',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const viewArg = process.argv.find((a) => a.startsWith('--view='))
    const search = viewArg ? `view=${viewArg.slice('--view='.length)}` : ''
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { search })
  }

  const shotArg = process.argv.find((a) => a.startsWith('--screenshot='))
  if (shotArg) {
    const outPath = shotArg.slice('--screenshot='.length)
    const logPath = `${outPath}.log`
    const log = (m: string): void => {
      try {
        require('node:fs').appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
      } catch {
        /* nothing we can do */
      }
    }

    log(`screenshot mode -> ${outPath}`)
    mainWindow.show()

    // Failsafe: never leave a headless run hanging.
    setTimeout(() => {
      log('FAILSAFE timeout, exiting')
      app.exit(2)
    }, 25000)

    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log(`did-fail-load ${code} ${desc} ${url}`)
    })

    mainWindow.webContents.once('did-finish-load', () => {
      log('did-finish-load')
      setTimeout(() => {
        void (async () => {
          const win = mainWindow
          if (!win) return
          try {
            // Drive the UI from a script file before capturing. Used for
            // headless UI verification; harmless in normal runs because the
            // flag is only supplied by the screenshot harness.
            const evalArg = process.argv.find((a) => a.startsWith('--eval-file='))
            if (evalArg) {
              const script = await fs.readFile(evalArg.slice('--eval-file='.length), 'utf8')
              const dbg = win.webContents.debugger
              dbg.attach('1.3')
              await dbg.sendCommand('Runtime.evaluate', { expression: script, awaitPromise: true })
              log('eval done')
              await new Promise((r) => setTimeout(r, 1100))
            }

            const dbg = win.webContents.debugger
            if (!dbg.isAttached()) dbg.attach('1.3')
            // `webContents.capturePage()` throws UnknownVizError on some Windows
            // GPU/compositor combinations. CDP's Page.captureScreenshot goes
            // through the same renderer but does not depend on the compositor
            // handing back a surface, so it works reliably headless.
            const result = (await dbg.sendCommand('Page.captureScreenshot', {
              format: 'png',
              captureBeyondViewport: false
            })) as { data: string }
            const buf = Buffer.from(result.data, 'base64')
            await fs.writeFile(outPath, buf)
            log(`wrote ${buf.length} bytes (cdp)`)
          } catch (err) {
            log(`capture failed ${String(err)}`)
          }
          app.exit(0)
        })()
      }, 4500)
    })
  }
}

ipcMain.handle('state:get', async (): Promise<AppState> => {
  if (cachedScan) return buildState(cachedScan)

  const cached = await loadScan(cachePath())
  if (cached) {
    cachedScan = cached
    return buildState(cached)
  }

  return {
    drive: DRIVE,
    meta: null,
    tree: null,
    candidates: [],
    space: await driveSpace(DRIVE),
    rulesVersion: 0,
    quarantinedSrcs: []
  }
})

ipcMain.handle('scan:run', async (): Promise<AppState> => {
  if (scanning) throw new Error('A scan is already running')
  scanning = true

  try {
    const scan = await scanDrive(DRIVE + '\\', {
      onProgress: (p: ScanProgress) => {
        mainWindow?.webContents.send('scan:progress', p)
      }
    })

    cachedScan = scan
    await saveScan(scan, cachePath())
    return await buildState(scan)
  } finally {
    scanning = false
  }
})

ipcMain.handle('scan:clear', async (): Promise<void> => {
  cachedScan = null
  await fs.rm(cachePath(), { force: true })
})

ipcMain.handle('path:reveal', async (_e, p: string): Promise<void> => {
  shell.showItemInFolder(p)
})

ipcMain.handle('rules:open', async (): Promise<void> => {
  await shell.openPath(rulesPath())
})

ipcMain.handle('space:get', async () => driveSpace(DRIVE))

ipcMain.handle('exec:quarantine', async (_e, items: ExecItem[]) =>
  quarantine(items, {
    quarantineRoot: defaultQuarantineRoot(),
    quarantineRootFor,
    journalPath: journalPath()
  })
)

ipcMain.handle(
  'exec:list',
  async (): Promise<QuarantineItem[]> => listQuarantine(journalPath())
)

ipcMain.handle('exec:restore', async (_e, ids: string[]) => restore(ids, { journalPath: journalPath() }))

ipcMain.handle('exec:purge', async (_e, ids: string[]) => purge(ids, { journalPath: journalPath() }))

ipcMain.handle('exec:inspect', async (_e, ids: string[]): Promise<StagedDetail[]> => {
  const all = await listQuarantine(journalPath())
  const wanted = new Set(ids)
  const chosen = all.filter((i) => wanted.has(i.id) && i.status === 'quarantined')
  return inspectStaged(chosen)
})

app.whenReady().then(() => {
  // Resolve shell folders through the Windows Known Folder API. OneDrive can
  // redirect Documents/Desktop/Pictures, and Downloads can live on another
  // drive — string concatenation would silently mis-protect all of them.
  const known: Array<[string, Parameters<typeof app.getPath>[0]]> = [
    ['DOCUMENTS', 'documents'],
    ['DESKTOP', 'desktop'],
    ['DOWNLOADS', 'downloads'],
    ['PICTURES', 'pictures'],
    ['MUSIC', 'music'],
    ['VIDEOS', 'videos'],
    ['USERPROFILE', 'home']
  ]
  const overrides: Record<string, string> = {}
  for (const [token, key] of known) {
    try {
      overrides[token] = app.getPath(key)
    } catch {
      /* folder type unavailable on this system */
    }
  }
  setPathOverrides(overrides)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
