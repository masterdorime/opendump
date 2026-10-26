# AGENTS.md

Orientation for any agent (or human) picking this up with **zero prior context**.
Read this file first, then `README.md` for the user-facing story.

Last updated: 2026-10-26 · version **0.5.0** · 72 tests · 80 rules · ~5,450 lines

---

## 1. What this is

**opendump** is a Windows desktop app (Electron + React + TypeScript) that audits a drive,
classifies every folder by how safe it is to delete, and reclaims space through a two-step
move-then-purge flow with an append-only journal.

- Repo: https://github.com/masterdorime/opendump (public, MIT)
- Releases: https://github.com/masterdorime/opendump/releases (portable `.exe` + NSIS installer)
- Local path: `C:\Users\TRISTAN\drive size audit`
- Git: `main`, working tree clean at `38410cc`

**The product exists because** `Get-ChildItem -Recurse` on a 400 GB drive takes ten minutes and
produces nothing actionable. This scans in ~172 s / 1.86M files and caches the result.

---

## 2. The one thing to internalise

> **Nothing deletes without an explicit, acknowledged confirmation. Only one module has write
> power, it refuses anything it did not classify as removable, and it journals intent before
> touching disk.**

Every design decision follows from that. If you are about to add a code path that removes files,
stop and check §4 first.

---

## 3. Run it

```bash
npm install          # Node 20+ (22 recommended), Windows only
npm run dev          # Electron + Vite, hot reload
npm run build        # → out/
npm start            # run the production build
npm test             # 72 vitest tests, no Electron needed
npm run typecheck
```

Headless tools (all `npx tsx`-able, genuinely useful when debugging rules):

```bash
npm run scan -- 'C:\'                 # scan + report to terminal
npm run scan -- 'C:\' --save          # write .cache/scan.json
npm run scan -- 'C:\' --cached        # re-classify the cache — sub-second, use this constantly
npx tsx scripts/rule-histogram.ts .cache/scan.json        # candidates by rule id
npx tsx scripts/unclassified.ts .cache/scan.json          # what the AI would be asked about
npx tsx scripts/restore-all.ts                            # restore everything staged
npx tsx scripts/ai-smoke.ts                               # hit Ollama with 8 real folders
```

> **`--cached` is the loop.** Rule edits re-classify in ~500 ms against `.cache/scan.json`.
> Only rescan when file sizes actually changed.

### Shipping a release

```bash
# 1. bump version in package.json (use Node, NOT PowerShell — see §9.1)
node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='0.6.0';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8')"
npm install --package-lock-only

# 2. build + package (~8–10 min, mostly LZMA compression)
npm run dist

# 3. publish
gh release create v0.6.0 "release\opendump-0.6.0-portable.exe" "release\opendump-0.6.0-setup.exe" \
  --title "v0.6.0 — <theme>" --notes-file <notes.md>
```

CI (`.github/workflows/ci.yml`) runs typecheck → test → build on `windows-latest` for every
push. **It has already caught two real breakages** — don't bypass it.

---

## 4. Architecture — four units

| Unit | Files | Write power | Job |
|---|---|---|---|
| **Scanner** | `src/shared/scanner.ts` | none | Walk the tree, emit recursive sizes per directory |
| **Classifier** | `src/shared/rules.ts` + `rules/rules.json` | none | Path → `{tier, category, reason, ruleId}` |
| **Executor** | `src/shared/executor.ts` | **yes** | quarantine / restore / purge, journal-first |
| **UI** | `src/main`, `src/preload`, `src/renderer` | none | Render, select, confirm |

`src/shared/*` has **no Electron imports** — it is testable standalone and used by the CLI.
Keep it that way.

```
src/shared/
  types.ts       DirEntry, Candidate, AppState, Rule, ScanProgress
  scanner.ts     parallel scan → DirEntry[] with recursive sizes, pkg/git flags
  rules.ts       rule matching, findCandidates, findUnclassified
  executor.ts    quarantine/restore/purge + journal replay + inspectStaged
  system.ts      SystemStats, memoryPressure thresholds, UiState
  ai/            verdict (ceiling), catalogue (models), hardware, pull, settings, providers
src/main/        Electron main: IPC, window, tree building, AI orchestration
src/preload/     contextBridge API — contextIsolation ON, nodeIntegration OFF
src/renderer/    React: App, Treemap, PlanModal, PurgeConfirm, QuarantineView, AiPanel, TourOverlay
```

### Data flow

```
scan → ScanResult (cache)  →  findCandidates(rules)  →  Candidate[]
                                        ↓
                             AI verdicts (optional) append REVIEW rows
                                        ↓
                    user ticks → PlanModal → executor.quarantine()
                                        ↓
                             journal + rename into quarantine
                                        ↓
                    PurgeConfirm (file listing + ack) → executor.purge()
```

---

## 5. Safety invariants — do not weaken these

These are enforced in code and covered by tests. A PR that breaks one needs an extraordinary
argument.

1. **Only the Executor writes.** Scanner/classifier/UI are read-only by construction.
2. **Protection is monotonic downward.** A `KEEP` or `LOCKED` folder protects its entire
   subtree, even if a broader rule would match a child. (`protectedAncestor` in `rules.ts`.)
3. **Sizes never double-count.** A candidate reports *exclusive* bytes: its own size minus
   nested candidate groups. Sum of exclusives ≤ total. (`findCandidates`.)
4. **The AI's ceiling is `REVIEW`.** `parseVerdicts` coerces anything else — including a model
   saying `SAFE_PURGE` — down to `REVIEW`. Only a deterministic rule may authorise deletion.
5. **Journal before act.** A `begin` record lists intended moves before the filesystem changes.
   A crash leaves `interrupted` items that the UI surfaces, not silent loss.
6. **No silent deletion.** Purge requires a ticked acknowledgement naming real filenames. Apps
   are never force-closed to unlock a folder (`EBUSY` → skipped with a reason).
7. **Refusals are explicit.** Drive roots, symlinks/junctions, paths inside quarantine,
   cross-volume moves, vanished paths, `KEEP`/`LOCKED` tiers.

### Tiers

| Tier | Meaning | Selectable |
|---|---|---|
| `SAFE_PURGE` | regenerates itself | yes |
| `REVIEW` | needs judgement | yes |
| `KEEP` | user data, or contains it | yes, never pre-ticked |
| `LOCKED` | system-critical | **no** |

---

## 6. Rule engine

`rules/rules.json` is the whole classifier — plain JSON, no build step, 80 rules today.

```json
{
  "id": "purge-node-modules",
  "tier": "SAFE_PURGE",
  "category": "Build artifact",
  "reason": "Installed JS dependencies. Run `npm install` to recreate.",
  "requiresSibling": "package.json",
  "match": { "name": "node_modules" },
  "minBytes": 10485760
}
```

### Three rules that are easy to get wrong

- **Matchers on one rule are ANDed.** `{ "prefix": "%PROGRAMFILES%", "name": "node_modules" }`
  means *both*. This was originally OR and it let installed apps' dependencies be offered for
  deletion (Adobe, mblock, Pinokio). Don't revert it.
- **Order is semantic.** First match wins. A specific rule must precede the general one it
  overrides. This is why the rules are **one ordered file** rather than split by topic — a
  category split silently breaks precedence (e.g. `keep-game-saves` must beat `review-tlauncher`).
- **`requiresSibling` asks about the PARENT.** `package.json` lives *beside* `node_modules`, not
  inside it. The scanner records a `pkg` flag on the folder that contains the manifest.

`display: true` = colours the map, is never a review item, and **protects nothing**. Used for
catch-alls like "the rest of `C:\Windows`" and `%USERPROFILE%`.

### Path tokens

`%LOCALAPPDATA% %APPDATA% %USERPROFILE% %PROGRAMDATA% %PROGRAMFILES% %PROGRAMFILES(X86)%
%PUBLIC% %WINDIR% %TEMP% %SYSTEMDRIVE%`

Shell folders resolve through the **Windows Known Folder API** at startup (`setPathOverrides`,
fed by `app.getPath()` in `main`), so OneDrive redirects and relocated folders are handled:
`%DOCUMENTS% %DESKTOP% %DOWNLOADS% %PICTURES% %MUSIC% %VIDEOS%`

### User overrides

`rules/overrides.json` (copy `rules/overrides.example.json`) is **prepended**, so user rules win
and survive app updates. It is gitignored — never commit someone's personal rules.

### `findUnclassified` — the AI's target set

Returns large folders no rule could explain. Two non-obvious behaviours:

- **Descends to the leaf.** `C:\Users\you` is technically unknown but useless to ask about;
  emit the most specific unknown folder with no unknown children.
- **Skips containers already covered by a classified child** (≥50% of bytes). Otherwise
  `.ollama` is offered alongside its own classified `models` folder, double-counting 12 GB.

Excludes `%WINDIR%`, the app's own profile folders, and the app install path.

---

## 7. Data on disk

Everything lives under `%APPDATA%\opendump` (renamed from `Drive Size Audit`; a one-time
migration copies cache + journal + quarantine on first launch).

| Path | Contents |
|---|---|
| `scan-cache.json` | last `ScanResult` (~58 MB for 375k dirs) |
| `journal.jsonl` | append-only `begin` / `quarantine` / `restore` / `purge` records |
| `quarantine\<batch>\<drive>\<full path>` | staged folders, mirrored paths |
| `ai-settings.json` | provider + model choice. **Never contains a key** |
| `ai-key.bin` | cloud API key, encrypted with Electron `safeStorage` (DPAPI) |
| `ui-state.json` | `{ tutorialSeen: boolean }` |

On non-system volumes, staging goes to `<drive>:\DriveSizeAuditQuarantine` — moves must be
renames, so the staging root has to share the item's volume.

Environment overrides (also used by the screenshot harness):

| Var | Purpose |
|---|---|
| `DSA_DRIVE` | drive to scan (default `%SYSTEMDRIVE%`) |
| `DSA_CACHE` | use a specific scan cache |
| `DSA_USERDATA` | isolated profile — skips legacy migration |

---

## 8. AI subsystem — current state

**Shipped and reachable from the UI.** Local Ollama only by default.

- `ai/hardware.ts` — real VRAM via `nvidia-smi`; **honest CPU-only fallback** for AMD/Intel
  (WMI's `AdapterRAM` is a 32-bit field and reported the 8 GB card as 4 GB).
- `ai/catalogue.ts` — 6 curated models, ranked by fit + quality. `checkRunFeasible` is the
  **last line of defence** and refuses when free RAM < 1.5 GB or the model exceeds free VRAM.
- `ai/providers.ts` — `OllamaProvider` (`think:false`, schema-constrained via `format`,
  `keep_alive:'0'`), `CloudProvider` (OpenAI-compatible), `classifyHybrid` (batches of 12).
- `AiPanel.tsx` — hardware card, live RAM/VRAM meters (2 s poll), fit badges, one-click pull
  with progress, free-text tag field, provider toggle.

### What was learned the hard way

- **Host RAM is the binding constraint, not VRAM.** A 4B model at 100% GPU offload still costs
  ~1.3 GB of host RAM. At 0.9 GB free, Windows couldn't even spawn `node`.
- **`think: false` is mandatory.** Qwen 3.5 thinks by default; that burns hundreds of tokens
  per folder for no accuracy gain on labelling.
- **`keep_alive: '0'`** so the runner unloads after each batch.
- **A 4B model's reasons are worse than the hand-written rules** on folders the rules already
  understand. That's why AI only targets `findUnclassified`. Don't "improve" it by pointing it
  at classified candidates.
- Cloud path is **wired but unverified against a live endpoint**. Treat as experimental.

---

## 9. Environment gotchas (cost hours already)

### 9.1 PowerShell corrupts source files

Two separate incidents:

- `Set-Content -Encoding utf8` writes a **BOM** (bytes `EF BB BF`). Vite/PostCSS then fails with
  `Unexpected token` when parsing `package.json`. It reached `main` and broke CI.
- A `Get-Content -Raw` + `Set-Content` round-trip reads as CP1252 and writes UTF-8, so an em dash
  (`U+2014`, bytes `E2 80 94`) is re-encoded as three garbage characters. This hit four files.

**Rule: never round-trip source through PowerShell.** Use the `edit`/`write` tools, or Node with
explicit `utf8`. Before committing, scan tracked files for a leading BOM and for the CP1252
mis-decode signature:

```bash
node -e "const fs=require('fs'),{execSync}=require('child_process');for(const f of execSync('git ls-files',{encoding:'utf8'}).split('\n').filter(f=>f!=='AGENTS.md'&&/\.(ts|tsx|json|md|css|yml)$/.test(f)&&fs.existsSync(f))){const b=fs.readFileSync(f);if(b[0]===0xef&&b[1]===0xbb)console.log('BOM',f);if(/\xC3\xA2\xE2\x82\xAC|\xC3\x83\xC2\xA9/.test(b.toString('latin1')))console.log('MOJIBAKE',f)}"
```

(`AGENTS.md` is skipped because it contains the detector pattern itself.)

### 9.2 Files that must never be committed

- `opencode.json` — sits in the repo root, is gitignored, and previously contained a **live API
  key** in plaintext. It now reads `{env:RIVER_API_KEY}`. Never `git add -f` it; never paste a
  key into it.
- `rules/overrides.json` — a user's personal classification rules. Gitignored; the committed
  example is `rules/overrides.example.json`.
- Any `scan-cache.json`, `journal.jsonl`, or `quarantine/` contents. Those live in
  `%APPDATA%\opendump`, never in the repo.

### 9.3 Defender locks `app.asar`

`npm run dist` can fail with `EBUSY: resource busy or locked, unlink 'release\win-unpacked\resources\app.asar'`.
Defender's real-time scanner holds the file. Fix: wait, delete `release/` with nothing running,
add an exclusion, or build to a fresh output dir (`--config.directories.output=release-0X`).

### 9.4 Power saving / long builds

NSIS compression takes ~8–10 minutes on this laptop. `release/` and `release-*/` are gitignored.

---

## 10. Testing

`npm test` — 72 tests, ~500 ms, no Electron, real filesystem in temp dirs.

| File | Covers |
|---|---|
| `tests/executor.test.ts` (19) | quarantine/restore/purge round-trips, refusals, collisions, journal replay, staged inspection |
| `tests/rules.test.ts` (13) | exclusive sizing, monotonic protection, AND matchers, `requiresSibling`, path tokens, `findUnclassified` |
| `tests/ai.test.ts` (19) | verdict ceiling, path validation, confidence clamp, hybrid routing/escalation, batching, prompts |
| `tests/ai-hardware.test.ts` (21) | `nvidia-smi` parsing, CPU fallback, model ranking, `checkRunFeasible`, pull NDJSON, settings merge |

**Not covered:** the scanner itself, IPC channel wiring, and every React component. UI changes
are verified by screenshot (below). If you touch the scanner, add the fixture test it deserves.

### Verifying UI without a human

The app has a built-in screenshot mode (dev-only, harmless in normal runs):

```bash
Start-Process "node_modules\electron\dist\electron.exe" `
  -ArgumentList ".", "--view=review", "--screenshot=C:\path\shot.png", `
                "--eval-file=C:\path\click.js", "--disable-gpu"
```

`--eval-file` runs JS before capture (used to click buttons). The PNG plus a `.log` appear at the
path. Capture uses CDP `Page.captureScreenshot` because `capturePage()` throws `UnknownVizError`
on this GPU. **Budget ~1.1 s between the last click and capture** — later timers never fire.

---

## 11. Current state — what exists vs what doesn't

**Works:** scan (172 s / 1.86M files), treemap, classification (80 rules), review list,
quarantine → restore → purge with journal, purge confirmation with real filenames and an
acknowledgement, multi-drive staging, OneDrive-aware shell folders, live RAM/VRAM meters,
local AI with hardware-gated model selection and one-click pull, spotlight tour, packaged
installer + portable build, CI, releases.

**Not built:**

- **Inspection layer** — the biggest gap. Rules judge folder *names*; nothing reads a folder's
  contents. This is what would have caught `CapCut\User Data\Cache` containing a human-named
  `UROCHECK VIDEO DEMO ... .mp4` before a rule was written wrong. It unlocks the 72 GB currently
  sitting in `Review`.
- **Elevated tier** — `hiberfil.sys` (4.7 GB), Windows Update cache (5–15 GB), DISM/WinSxS.
  Needs a separate UAC helper that re-validates paths itself.
- **Chat over the index** — planned as read-only tools (`search_index`, `list_files`,
  `size_summary`), not a general assistant.
- **Duplicates, verification reporting.**
- **Packaging polish** — code signing, auto-update, "reset rules to defaults".
- **Uninstall handling** — `deleteAppDataOnUninstall:false` keeps staged data, but nothing tells
  the user where it went.

**Dead / weak code to know about:**

- `ai/preflight.ts` (`canFit`) is now only used by tests and `scripts/ai-smoke.ts`;
  `catalogue.checkRunFeasible` supersedes it in production. Consolidate when convenient.
- Cloud provider has never been exercised against a real endpoint.
- `.scan-track` CSS may be orphaned after the scan bar rebuild.

### V2 (Rust) — a sibling repo, not a replacement

`https://github.com/masterdorime/opendump-v2` — pre-alpha Rust core + CLI, 24 tests.

- **Ported:** rule engine, scanner, executor (quarantine/restore/purge + journal), CLI, and a
  Tauri desktop shell (9.98 MB exe, 2.26 MB installer).
- **Not ported:** v0.5's treemap, spotlight tour, purge-confirmation screen, live memory meters,
  AI layer, `find_unclassified`, MFT reader.
- **It is now an app**, if a minimal one: scan → review → quarantine → restore → purge in a
  window. The v0.5 UI is still the richer product.
- Measured: full `C:\` scan in **102.8 s** (CLI) / 165 s through the Tauri window vs 172–299 s
  for this app. Classifications match v1 where they overlap.

Rules for working across the two:

- **Do not link v2 from this repo's user-facing README** until v2 can scan, classify, quarantine
  and purge. Pointing users at a pre-alpha undermines trust in the release that works.
- **Do not call v2 "built in Rust" as a product claim yet.** Only the core is Rust; there is no
  app. The v2 README states this explicitly — keep it that way until it ships.
- The measured motivation: this app is 366 MB installed and idles at 377 MB. The real prize for
  Rust is an **MFT scanner** that could cut the 172–299 s scan to seconds — not the UI shell.

---

## 12. Conventions

- **TypeScript strict**, no `any` in shared modules, no Electron imports below `src/shared`.
- **Tests first** for anything in `shared/` — especially `executor.ts`, which can lose data.
- **Comments explain *why*.** Every non-obvious guard has one; keep that standard.
- **Commits** are descriptive and explain the discovery, not just the change
  (`git log` reads like a lab notebook — that's deliberate).
- **Never weaken §5 to make a feature easier.**
- **Releases** follow §3; the repo is public, so assume every commit is visible.

---

## 13. If you have one hour

1. `npm test` + `npm run typecheck` — confirm the baseline is green.
2. `npm run scan -- 'C:\' --cached` — see the current classification in the terminal.
3. Read `src/shared/rules.ts` §`findCandidates` and `src/shared/executor.ts`.
4. Start on the **inspection layer** (§11) — it is the highest-value, lowest-risk next step.
