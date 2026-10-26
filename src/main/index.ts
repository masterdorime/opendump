import { app, BrowserWindow, ipcMain, shell, safeStorage } from 'electron'
import { join, parse, dirname, resolve } from 'node:path'
import { existsSync, mkdirSync, copyFileSync, cpSync, promises as fs } from 'node:fs'
import { scanDrive, saveScan, loadScan, driveSpace } from '@shared/scanner'
import { compileRules, findCandidates, findUnclassified, setPathOverrides } from '@shared/rules'
import { quarantine, listQuarantine, purge, restore, inspectStaged } from '@shared/executor'
import type { ExecItem, QuarantineItem, StagedDetail } from '@shared/executor'
import { readHardware } from '@shared/ai/hardware'
import { CATALOGUE, recommendModels, pickDefault } from '@shared/ai/catalogue'
import type { ModelSpec, Recommendation } from '@shared/ai/catalogue'
import { parsePullLine } from '@shared/ai/pull'
import type { PullProgress } from '@shared/ai/pull'
import { mergeSettings, DEFAULT_SETTINGS } from '@shared/ai/settings'
import type { AiSettings } from '@shared/ai/settings'
import { canFit } from '@shared/ai/preflight'
import { classifyHybrid, CloudProvider, OllamaProvider, ollamaModels } from '@shared/ai/providers'
import type { AiVerdict } from '@shared/ai/verdict'
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
let aiVerdicts = new Map<string, AiVerdict>()

const cachePath = (): string => CACHE_OVERRIDE ?? join(app.getPath('userData'), 'scan-cache.json')
const defaultQuarantineRoot = (): string => join(app.getPath('userData'), 'quarantine')
const journalPath = (): string => join(app.getPath('userData'), 'journal.jsonl')
const aiSettingsPath = (): string => join(app.getPath('userData'), 'ai-settings.json')
const aiKeyPath = (): string => join(app.getPath('userData'), 'ai-key.bin')

async function loadAiSettings(): Promise<AiSettings> {
  try {
    const raw = await fs.readFile(aiSettingsPath(), 'utf8')
    return mergeSettings(JSON.parse(raw))
  } catch {
    return mergeSettings(null)
  }
}

async function saveAiSettings(settings: AiSettings, apiKey?: string): Promise<void> {
  await fs.mkdir(dirname(aiSettingsPath()), { recursive: true })
  await fs.writeFile(aiSettingsPath(), JSON.stringify(settings, null, 2), 'utf8')

  if (apiKey === undefined) return
  if (apiKey.length === 0) {
    await fs.rm(aiKeyPath(), { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows credential encryption is unavailable; the key was not saved')
  }
  await fs.writeFile(aiKeyPath(), safeStorage.encryptString(apiKey))
}

async function readAiKey(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(await fs.readFile(aiKeyPath()))
  } catch {
    return null
  }
}

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

/** Subtrees the AI should never be asked about: Windows, our own profiles, our own install. */
function aiExclusionRoots(): Array<string | undefined> {
  const appData = process.env.APPDATA
  return [
    process.env.WINDIR,
    appData ? join(appData, 'opendump') : undefined,
    appData ? join(appData, 'Drive Size Audit') : undefined,
    app.getAppPath()
  ]
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

  // AI verdicts on folders no rule could classify become ordinary review rows,
  // so they flow through the same selection, quarantine and purge pipeline.
  if (aiVerdicts.size > 0) {
    const known = new Set(candidates.map((c) => c.path.toLowerCase()))
    const byPath = new Map(scan.dirs.map((d) => [d.p.toLowerCase(), d]))

    for (const [key, verdict] of aiVerdicts) {
      if (known.has(key)) continue
      if (heldSrcs.some((held) => key === held || key.startsWith(held + '\\'))) continue
      const dir = byPath.get(key)
      if (!dir) continue

      candidates.push({
        path: dir.p,
        size: dir.s,
        totalSize: dir.s,
        files: dir.c,
        mtime: dir.m,
        tier: verdict.tier,
        category: 'AI classification',
        reason: verdict.reason,
        ruleId: `ai:${verdict.model ?? 'model'}`,
        depth: dir.p.split('\\').length - 1,
        blocked: false,
        blockedBytes: 0,
        blockedBy: []
      })
    }
    candidates.sort((a, b) => b.size - a.size)
  }

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
    quarantinedSrcs: staged.filter((s) => s.status === 'quarantined').map((s) => s.src),
    unclassified: findUnclassified(scan, compiled, {
      minBytes: 200 * 1024 * 1024,
      excludeRoots: aiExclusionRoots()
    }).length
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
    quarantinedSrcs: [],
    unclassified: 0
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
    aiVerdicts = new Map()
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

async function pullModel(model: string, onProgress: (p: PullProgress) => void): Promise<void> {
  const response = await fetch('http://127.0.0.1:11434/api/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true })
  })
  if (!response.ok || !response.body) {
    throw new Error(`Ollama refused the download (HTTP ${response.status})`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const progress = parsePullLine(line)
      if (progress) onProgress(progress)
      index = buffer.indexOf('\n')
    }
  }

  const tail = parsePullLine(buffer)
  if (tail) onProgress(tail)
}

ipcMain.handle('ai:status', async () => {
  const hardware = await readHardware()
  const settings = await loadAiSettings()

  let installed: Array<{ name: string; sizeBytes: number }> = []
  let ollamaReachable = false
  try {
    installed = await ollamaModels()
    ollamaReachable = true
  } catch {
    ollamaReachable = false
  }

  const installedNames = new Set(installed.map((m) => m.name))
  const recommendations = recommendModels(hardware).map((r) => ({
    ...r,
    installed: installedNames.has(r.spec.id) || installedNames.has(`${r.spec.id}:latest`)
  }))

  return {
    hardware,
    ollamaReachable,
    installed,
    recommendations,
    catalogue: CATALOGUE,
    defaultModel: pickDefault(recommendations)?.spec.id ?? null,
    settings,
    keyPresent: (await readAiKey()) !== null
  }
})

ipcMain.handle('ai:settings:save', async (_e, settings: unknown, apiKey?: string) => {
  const merged = mergeSettings(settings)
  await saveAiSettings(merged, apiKey)
  return merged
})

ipcMain.handle('ai:pull', async (_e, model: string) => {
  const name = typeof model === 'string' ? model.trim() : ''
  if (!name) throw new Error('A model name is required')
  await pullModel(name, (progress) => {
    mainWindow?.webContents.send('ai:pull', { model: name, ...progress })
  })
  return true
})

ipcMain.handle('ai:run', async () => {
  if (!cachedScan) throw new Error('Scan a drive first')

  const settings = await loadAiSettings()
  const hardware = await readHardware()

  let installed: Array<{ name: string; sizeBytes: number }> = []
  try {
    installed = await ollamaModels()
  } catch {
    throw new Error('Ollama is not running. Start it, then try again.')
  }

  const model = installed.find(
    (m) => m.name === settings.localModel || m.name === `${settings.localModel}:latest`
  )
  if (!model) {
    throw new Error(`${settings.localModel} is not installed yet — download it first.`)
  }

  const fit = canFit(model.sizeBytes, hardware.vramFreeBytes ?? 0)
  if (!fit.ok && hardware.vramFreeBytes !== null) throw new Error(fit.reason)

  const { rules } = await loadRules()
  const compiled = compileRules(rules)
  const targets = findUnclassified(cachedScan, compiled, {
    minBytes: 200 * 1024 * 1024,
    excludeRoots: aiExclusionRoots()
  }).slice(0, 80)

  if (targets.length === 0) return buildState(cachedScan)

  const items = targets.map((t) => ({
    path: t.path,
    size: t.size,
    files: t.files,
    mtime: t.mtime,
    category: 'unclassified'
  }))

  const local = new OllamaProvider({ model: settings.localModel })
  let cloud: CloudProvider | null = null
  if (settings.provider === 'hybrid' && settings.cloud.model) {
    const key = await readAiKey()
    if (key) {
      cloud = new CloudProvider({
        baseUrl: settings.cloud.baseUrl,
        apiKey: key,
        model: settings.cloud.model
      })
    }
  }

  const result = await classifyHybrid(
    items,
    local,
    cloud,
    settings.confidenceThreshold,
    (stage, done, total) => mainWindow?.webContents.send('ai:progress', { stage, done, total })
  )

  for (const verdict of result.verdicts) {
    aiVerdicts.set(verdict.path.toLowerCase(), verdict)
  }

  return {
    state: await buildState(cachedScan),
    classified: result.verdicts.length,
    escalated: result.escalatedCount,
    cloudError: result.cloudError
  }
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
