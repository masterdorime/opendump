# AGENTS.md — master handoff

Everything a fresh agent needs to continue without re-deriving it. Read this first, then
`README.md` (user-facing) and `CONTRIBUTING.md` (rules).

**Last updated:** 2026-10-27 · session ended mid-roadmap, both repos clean.

---

## 0. At a glance

| | **v1 — `opendump`** | **v2 — `opendump-v2`** |
| --- | --- | --- |
| Path | `C:\Users\TRISTAN\drive size audit` | `C:\Users\TRISTAN\opendump-v2` |
| Repo | https://github.com/masterdorime/opendump | https://github.com/masterdorime/opendump-v2 |
| Stack | Electron 45 · React 19 · TypeScript 5.8 | Rust (core + CLI + egui window) |
| Version | **0.5.0** (5 releases, latest `v0.5.0`) | 0.1.0, **no release yet** |
| Last code commit | `8d1a4f7` | `1bfd9ca` |
| Tests | **72** (vitest) | **73** (cargo) |
| Lines | ~5,450 TS/TSX | **7,865** Rust |
| Installed / binary | 366 MB installed, 116.6 MB installer | 6.93 MB exe, ~95 MB idle, ~130 MB with a map |
| Status | **the supported product** | pre-alpha; full shell, local AI, MFT, cache — no tour, no release |

> The SHAs above are the last **code** commits. Docs-only commits sit on top of them, and this
> file itself is one. If `git log --oneline` shows work beyond those SHAs, this document is
> describing an older state — read the new commits before trusting §3–§7.

Both working trees are clean. Both remotes are public and pushed. CI (GitHub Actions,
`windows-latest`) is green on both.

### Start here

1. Read §3 and §4 to learn what each binary actually does today.
2. **The shell matches v1** as of `806f258` — red dark theme, nested treemap, inspector,
   three peer views, free-space meter. `crates/opendump-core/src/layout.rs` holds the squarify
   maths and `hardware.rs` the probes; both are tested under `cargo test`. The next piece of
   work is the guided tour, then the scan cache.
3. Before touching anything that deletes, read §1 and §6. Those are constraints, not taste.
4. If you change `rules/rules.json`, remember it exists twice (§4) and that the native app
   bakes it in at compile time.

### Map the repo before you read it

**`graphify-out/` holds a knowledge graph of this repo.** Query it instead of opening files to
find your way around — reading six files to learn "where does classification happen" costs more
than asking the graph.

```bash
graphify query "where does classification happen?"     # BFS, broad
graphify query "path from rules to quarantine" --dfs   # trace one route
graphify explain "findCandidates"                      # one node, in plain language
graphify path "compileRules" "executor"                # shortest path between two concepts
```

Built 2026-10-29: **51 files · 411 nodes · 915 edges · 17 communities**, AST for code (free) plus
semantic extraction for 10 docs. `graphify-out/GRAPH_REPORT.md` is the readable summary;
`graph.html` opens in a browser with no server.

**Rebuild after structural change** — a new module, a moved file, a deleted feature:

```bash
/graphify .            # full rebuild, ~1 minute here
/graphify . --update   # only new and changed files
```

`graphify-out/` is generated and gitignored: a fresh clone rebuilds it in a minute. Do not hand
edit anything in it.

### Keep this file true

**Every change that alters behaviour, structure, a number, or a decision updates this file in the
same commit.** A handoff that describes a previous version is worse than none: the next agent
reads it as fact and rebuilds what already exists.

That covers, at minimum: test counts, line counts, binary sizes, the crate/component list, the
roadmap, and every "decisions" or "do not" entry a change contradicts. If a change is genuinely
undocumented when you stop — a half-finished experiment — say so in the last commit message and
here, so the gap is visible rather than assumed filled.

---

## 1. What this is

A Windows disk-audit tool. It scans a drive, classifies every folder by how safe it is to
remove, and reclaims space through a two-step **quarantine → purge** flow with an append-only
journal.

Built because `Get-ChildItem -Recurse` on 400 GB takes ten minutes and yields nothing
actionable. This scans in **92–172 s** for ~1.87 M files and caches the result.

**The one invariant everything serves:**

> Nothing deletes without an explicit, acknowledged confirmation. One module holds write power,
> it refuses what it did not classify as removable, and it journals intent before touching disk.

---

## 2. Why there are two repos

v1 is the working product: full UI, local AI, signed-off releases. v2 is a Rust rewrite of the
**engine**, started because:

- v1 installs **366 MB** and idles at **377 MB** — awkward for a disk/memory tool.
- The scan is the real bottleneck, and an MFT reader is a native-code problem.

v2 has not replaced v1. Nobody should be told to use v2 yet: it has no tour, no AI, no cache and
no signed build.

**A Tauri shell was built and then deleted.** It worked (9.98 MB exe, 2.26 MB installer) but
duplicated the native window for **316 MB of WebView2**. Do not re-add a webview front end
without a platform reason (macOS/Linux).

---

## 3. v1 state — Electron

```
src/shared/     scanner.ts · rules.ts · executor.ts · types.ts · system.ts · ai/
src/main/       IPC, window, tree building, AI orchestration
src/preload/    contextBridge (contextIsolation ON, nodeIntegration OFF)
src/renderer/   App, Treemap, PlanModal, PurgeConfirm, QuarantineView, AiPanel, TourOverlay
rules/          rules.json (80 rules) + overrides.example.json
tests/          72 vitest tests
```

**Works:** scan, treemap, classification, review list, quarantine → restore → purge + journal,
purge confirmation with filenames and an acknowledgement, multi-drive staging, OneDrive-aware
shell folders, live RAM/VRAM meters, local AI (Ollama, hardware-gated, one-click pull),
spotlight tour, packaging (portable + NSIS installer), CI, 5 releases.

**Not built:**

- **Inspection layer** — the biggest gap. Rules judge folder *names*; nothing reads contents.
  This is what would have caught `CapCut\User Data\Cache` holding a human-named
  `UROCHECK VIDEO DEMO … .mp4`. It unlocks the ~72 GB sitting in Review.
- **Elevated tier** — `hiberfil.sys` (4.7 GB), Windows Update cache (5–15 GB), DISM/WinSxS.
  Needs a UAC helper that re-validates paths itself.
- **Chat over the index**, duplicates, verification reporting.
- **Packaging polish** — code signing, auto-update, "reset rules to defaults".
- **Uninstall handling** — `deleteAppDataOnUninstall:false` keeps staged data but says nothing
  about where it went.

### How classification works — the part you will touch most

`rules/rules.json` is **one ordered list, first match wins**. 80 rules today. Every rule has:

| Field | Meaning |
| --- | --- |
| `id` | stable name; referenced by tests and by `overrides.json` |
| `match` | path fragments — **all must appear (AND)**, not any |
| `requiresSibling` | filename that must exist in the **parent** folder (`package.json` sits beside `node_modules`, not inside it) |
| `prefix` / name guards | pin a rule to a known parent so a same-named folder elsewhere is not matched |
| `tier` | `safe-purge` · `review` · `keep` · `locked` |
| `reason` | user-facing sentence shown in the UI — write it for a person, not a log |
| `display` | colour only; **protects nothing** |

Tier meaning: `SAFE_PURGE` = regenerable cache, offered for quarantine → purge. `REVIEW` =
probably disposable, the user decides. `KEEP` = protects its whole subtree. `LOCKED` =
protected and not selectable. A parent holding any `KEEP`/`LOCKED` child reports `blocked`
and is never removable as a whole.

`rules/overrides.json` is a user-level patch, gitignored, merged at load. Order matters more
than categorisation: `keep-game-saves` must beat `review-tlauncher`, which is why the file is
flat and ordered rather than split by topic.

**Adding a rule:** add it above the general rule it must outrank → `npm run scan -- 'C:\'
--cached` (500 ms, no rescan) → look at the counts in Review → add a vitest case in
`tests/rules.ts` that asserts the intended folder *and* the neighbouring folder it must not
match. Nearly every rule bug in §7 was an over-match, not an under-match.

### v1 commands

```bash
npm run dev / build / start
npm test / typecheck
npm run scan -- 'C:\' --cached      # re-classify the cache in ~500 ms — use constantly
npm run dist                        # ~8–10 min, mostly LZMA compression
```

### v1 release

Bump `version` in `package.json`, `npm run dist`, then attach both artefacts from `release/`:

```bash
gh release create v0.5.1 release/opendump-0.5.1-portable.exe \
  release/opendump-0.5.1-setup.exe --title "v0.5.1 — …" --notes "…"
```

Existing releases: v0.1.0 → v0.5.0, each with `-portable.exe` and `-setup.exe`. They are
**unsigned**; SmartScreen warns "Unknown publisher" and the user has been told.

### v1 data

`%APPDATA%\opendump\` — `scan-cache.json` (~58 MB), `journal.jsonl`, `quarantine\<batch>\…`,
`ai-settings.json` (never contains a key), `ai-key.bin` (DPAPI), `ui-state.json`.

---

## 4. v2 state — Rust

```
crates/opendump-core/   ~2,600 src + ~900 test lines
  types.rs      Tier, Rule, RuleMatch, DirEntry
  tokens.rs     %LOCALAPPDATA%-style expansion, injectable map
  rules.rs      compile, AND matchers, find_candidates, find_unclassified, parent_of/depth_of
  scan.rs       recursive walk + scan_any (MFT first, walk as fallback)
  mft.rs        NTFS Master File Table reader: boot sector, fixups, run lists, tree build
  executor.rs   quarantine/restore/purge + journal + inspect_staged
  layout.rs     squarified treemap over plain Box4 rects — no UI dependency
  hardware.rs   GlobalMemoryStatusEx RAM, nvidia-smi VRAM, GetDiskFreeSpaceEx
  inspect.rs    folder contents: extension mix, largest files, hashed-vs-human names
  ai.rs         localhost Ollama client, prompt, schema, parse_verdicts (REVIEW ceiling)
  cache.rs      versioned binary scan cache, front-coded paths, rules-hash invalidated
  format.rs     bytes(), thousands() — shared by every front end
crates/opendump-cli/    448 lines — opendump.exe (1.91 MB)
apps/native/            ~3,300 lines — opendump-native.exe (6.93 MB), egui + glow
```

`apps/native/src/main.rs` is one file, deliberately — everything about the window is in reach:

```
consts    Palette (dark/light) + INK; pal() reads a static flag
structs   NodeInfo · Pane (Map/Review/Quarantine/Ai/Rules) · Visual · MapCache · ScanView ·
          StagedView · ConfirmState · Message
helpers   base_dir · cache_path · settings_path · overrides_path · load_overrides ·
          save_overrides · rules · scan_any · exec_options · staged_snapshot · classify
impl App  logic:  start_scan · quarantine_picked · quarantine_path · restore_all · purge_ids ·
                   start_inspection · run_ai · drain
views     summary · review · quarantine_panel · tabs · map · inspector · ai_pane · rules_pane ·
          confirm_modal
helpers   build_visuals · tile_fill · size_fill · pressed · metric · space_meter · draw_inspection ·
          cell · legend_item · pretty · last_component · clamp_label · on_fill · stat · mft_probe ·
          mft_replay · selftest · main
```

Line numbers drift every session; grep the function name instead.

Work runs on `std::thread`; results return as `Message` over an `mpsc` channel and are drained at
the top of `update()`. There is no async runtime and no task graph.

**Ported and working:** rule engine, tokens, scanner (walk **and** MFT), executor
(quarantine/restore/purge/journal), `inspect_staged`, scan cache, squarified treemap, hardware
probe, inspection layer, local AI, rules editor, CLI (`scan|quarantine|list|restore|purge`),
native window with five views (Map / Review / Quarantine / AI / Rules) and the purge confirmation.

**Not ported:** spotlight tour, cloud AI provider, multi-drive, elevated tier, `--cached`
reclassify.

**Rules load differently in the two front ends — this bites.** The CLI reads `rules/rules.json`
from disk (searching cwd, beside the exe, and `--rules <path>`). The native app
`include_str!`s it at **compile time**, so editing `rules.json` shows up in the window only
after a rebuild; the CLI picks it up immediately. The v1 and v2 copies are byte-identical today
(SHA-256 `BFAC0CE9…`) and must stay that way until the repos merge.

### v2 commands

```bash
cargo test --workspace                 # 41 tests
cargo run --release                    # CLI
./target/release/opendump scan "C:\" --top 20
./target/release/opendump quarantine <path> --yes
./target/release/opendump list | restore --all | purge --all --yes

cd apps/native && cargo run --release            # window
cargo run --release -- --scan                    # window, scanning on open
cargo run --release -- --selftest                # headless scan + classify + print
cargo run --release -- --probe                   # RAM/VRAM only, no scan (fast)
```

### v2 data

`%APPDATA%\opendump-native\` — `journal.jsonl`, `quarantine\<batch>\…`. Deliberately separate
from v1's profile.

---

## 5. Measured numbers (do not re-guess these)

| Metric | v1 Electron | v2 native |
| --- | --- | --- |
| Full `C:\` scan | 172 s idle / 299 s loaded | **91.7–102.8 s** |
| Folders / files | 375,541 / 1.86 M | 368,204 / 1.73 M |
| Idle RAM | 377 MB (4 procs) | **89 MB (1 proc)** |
| After a scan | — | 107 MB |
| Installer | 116.6 MB | — (raw exe 6.29 MB) |
| Installed | 366 MB | ~6 MB |

Correctness: v2 was cross-checked against `robocopy /L` on `Users` (223.1 GB / 999,946 files —
exact), `Windows`, `ProgramData`, `Program Files` — all matched.

Two measurement traps already fallen into:

- **WebView2 baseline.** A "444 MB" Tauri measurement was wrong: 416 MB of `msedgewebview2` was
  already running before launch. Always subtract the baseline.
- **GB vs GiB.** v1's `fmtBytes` divides by 1024 but labels "GB". Full-drive totals differ from
  decimal-byte tools by ~7%. v2's `format::bytes` does the same, deliberately, for consistency.

---

## 6. Decisions and why (don't undo these by accident)

| Decision | Reason |
| --- | --- |
| **Rule matchers are ANDed** | Originally OR. That let installed apps' `node_modules` (Adobe, mblock, Pinokio) be offered for deletion. |
| **`requiresSibling` asks about the PARENT** | `package.json` sits *beside* `node_modules`, not inside. First attempt checked the wrong folder and matched 0 of 623. |
| **One ordered `rules.json`, no category split** | Splitting by topic silently breaks precedence (`keep-game-saves` must beat `review-tlauncher`). |
| **`display: true` = colour only, protects nothing** | Broad catch-alls (`keep-profile`, `keep-windows`) must not form protection boundaries, or they block every specific rule beneath them. |
| **Exclusive sizes** | Candidates report own bytes minus nested groups, so selecting parent + child never promises the same bytes twice. |
| **Protection is monotonic downward** | A `KEEP`/`LOCKED` folder protects its whole subtree; a parent holding one is `blocked`, never removable whole. |
| **AI ceiling is `REVIEW`** | `parseVerdicts` coerces anything else down. Only a deterministic rule may authorise deletion. |
| **AI targets `find_unclassified`, not classified folders** | A 4B model's reasons were *worse* than the hand-written rules on folders the rules already understood. |
| **RAM is the AI gate, not VRAM** | A 4B model at 100 % GPU offload still costs ~1.3 GB host RAM. At 0.9 GB free, Windows could not spawn `node`. |
| **`think:false`, `keep_alive:'0'`** | Qwen 3.5 thinks by default (hundreds of wasted tokens per folder); the runner must unload after a batch. |
| **Native over Tauri** | 89 MB vs 344 MB for the same window. Disk size is comparable; RAM is not. |

---

## 7. Bugs already fixed — regressions to watch for

1. **Exclusive sizing carried the child's remainder**, not its total → every nested folder was
   counted at each level. Fixed; `tests/rules.ts` asserts Σ candidates ≤ tree.
2. **`node_modules` matched installed apps** → AND matchers + prefix+name guards + parent
   `package.json` flag.
3. **Catch-all rules over-protected** → `display` flag excluded from protection.
4. **`findUnclassified` emitted `C:\Users\you`** as one blob, swallowing 211 GB → descend to the
   leaf, skip containers ≥50 % covered by a classified child.
5. **Forward-slash paths bypassed the "inside quarantine" check** in v2 → normalise separators
   in `normalize`/`parent_of`/`depth_of`.
6. **v2 display rules were emitted as candidates** → skip in the emit loop.
7. **egui dim overlay never painted** → an `Area`'s painter is clipped to its own content;
   use `ctx.layer_painter()`.
8. **`CapCut\Cache` was `SAFE_PURGE`** → now `REVIEW`; it mixes scratch files with human-named
   exports.

---

## 8. Environment gotchas

### PowerShell corrupts source (twice, hours lost)

- `Set-Content -Encoding utf8` writes a **BOM**. Vite/PostCSS then fails with
  `Unexpected token` parsing `package.json`. It reached `main` and broke CI.
- A `Get-Content -Raw` + `Set-Content` round-trip reads CP1252 and writes UTF-8, turning an em
  dash into mojibake across four files.

**Never round-trip source through PowerShell.** Use `edit`/`write`, or Node with explicit
`utf8`. Before committing, scan tracked files for a leading BOM and the mis-decode signature.

### Defender locks `app.asar`

`npm run dist` can fail `EBUSY: … unlink release\win-unpacked\resources\app.asar`. Wait, delete
`release/` with nothing running, or build to a fresh output dir.

### Node/npm install scripts are gated here

`npm install` warns that `esbuild`/`electron` postinstall scripts were blocked. Electron's
binary had to be fetched manually (`node node_modules/electron/install.js`).

### Secrets

`opencode.json` sits in the v1 repo root, is gitignored, and once held a live API key. It now
reads `{env:RIVER_API_KEY}`. **Never `git add -f` it.** The key was never rotated — the user
was told to.

---

## 9. How to verify anything

**v1 UI** — screenshot mode built into the app:

```powershell
Start-Process "node_modules\electron\dist\electron.exe" -ArgumentList ".", `
  "--view=review", "--screenshot=$out", "--eval-file=$clickJs", "--disable-gpu"
```

Capture uses CDP `Page.captureScreenshot` (`capturePage()` throws `UnknownVizError` on this
GPU). **Budget ~1.1 s between the last click and capture** — later timers never fire.
`--eval-file` runs JS first; the current suite of click scripts lives in `%TEMP%\opencode`.

**v2 engine** — `opendump-native --selftest` prints folders/files/size/duration/tier counts
without opening a window. `--cached`-equivalent in Rust does not exist yet; rescan takes ~100 s.

**v2 window** — egui has no debug port, so it is driven with Win32:

```powershell
SetWindowPos($h, 0, 0, 0, 1240, 820, 0x0040)   # known origin
SetForegroundWindow($h)
SetCursorPos(1180, 198); mouse_event(LEFTDOWN…); mouse_event(LEFTUP…)
# then Graphics.CopyFromScreen over the window rect
```

The quarantine "Purge all" button sits at ≈(1180, 198) with the window at (0,0) 1240×820 and one
item staged.

### What has actually been verified

Be precise about this when reporting status — the user checks.

**Proven, by real use on this machine**

- v1 scan → classify → quarantine → restore → purge, on the user's actual `C:\`. 74 folders
  purged, 9.86 GB reclaimed (free space 36.6 → 46.78 GB). A pip-cache quarantine was restored
  and nothing was lost.
- v1 purge confirmation lists real filenames and blocks the button until acknowledged.
- v2 totals match `robocopy /L` exactly on `Users` (223.1 GB / 999,946 files), `Windows`,
  `ProgramData`, `Program Files`.
- v2 native window: scan, review, quarantine, restore, and the purge confirmation — driven with
  real Win32 clicks and captured (§9).
- RAM and scan times in §5 were measured here with `Get-Process` and wall clock.

**Not verified — say so rather than implying otherwise**

- **The cloud AI provider has never been tested against a live endpoint.** Local Ollama is the
  only path with real runs behind it.
- v2 native has only run on this machine, at this DPI, with this GPU. No other display scaling,
  no 4K, no second monitor.
- v1 has only been exercised on Windows 11. Windows 10 is untested.
- Rules are verified against the folders that exist here. Folders the user has never opened are
  classified on name evidence alone — which is exactly what §11's inspection layer is for.
- Nothing is code-signed. Every release warns "Unknown publisher".

---

## 10. Working with this user

- **Momentum over ceremony.** "go", "yes", "y" mean implement now. They have said "don't ask me
  again" — do not gate progress on approval rounds.
- **They check claims.** Several turns were spent correcting numbers I asserted instead of
  measured (WebView2 RAM, Tauri installer size, "100× lighter"). Measure first, then state.
- **They will push back with a better idea** (Qwen 3.5, native over Tauri, ponytail). Take it,
  verify it, and say plainly when they are right.
- **They want the honest ceiling**, not marketing: "4× lighter, not 100×" landed better than the
  optimistic version.

---

## 11. Roadmap — ordered, with first actions

### Shipped (do not rebuild these)

| Item | Commit | Note |
|---|---|---|
| Treemap, nested, Status/Size colouring | `171017e` → `fed1366` | `layout.rs` holds the maths, 5 tests |
| Memory meters (RAM + free VRAM) | `502734b` | `hardware.rs`, never guesses |
| Scan cache (0.64 MB, instant open) | `498bb04` | `cache.rs`, rules-hash invalidated |
| Local AI via Ollama, ceiling REVIEW | `80a484a` | `ai.rs`, 8 tests, evaluated at 43.8% on rule-protected folders |
| Inspection layer (contents, not names) | `d026648` | `inspect.rs`, the CapCut lesson |
| Rules editor with `overrides.json` | `d026648` | order-preserving merge |
| Light/dark, mono chrome, red accent | `a7f0572` | `Palette` + `pal()` |
| MFT scanner, walk as fallback | `9bb29e4` → `731e7b2` | `mft.rs`; 423.6 GB in 4.9 s vs the walk's 410.7 GB in 75 s |
| Purge dialog, press feedback | `f945c5c`, `1bfd9ca` | card, not a stock window |

### v2 — what is actually next

**1. Release v0.1.0 — the only item that changes who can use this.** There is still no installer:
a stranger needs Rust. `cargo build --release` already produces both binaries; a zip plus release
notes is an hour. Decide the honour-system question at the same time: unsigned means SmartScreen
says "Unknown publisher", exactly as v1 does.

**2. Guided tour.** v1's `TourOverlay.tsx` is the reference: steps with a target `Rect`, heading
and copy, everything else dimmed. In egui the dim is a `layer_painter` fill plus a hole — and note
§7.7, an `Area`'s painter is clipped to its own content rect.

**3. Cloud AI provider.** Wired in v1, never tested against a live endpoint. Do not port an
unverified path; test first.

**4. Exclude from Scan.** Needs the scanner to take an exclusion list *and* the cache to
invalidate on it — the one small feature with real plumbing.

**5. Multi-drive, elevated tier.** Neither repo has the elevated tier (`hiberfil.sys`, Windows
Update cache, DISM). It needs a UAC helper that re-validates paths itself.

### v1 (maintenance)

1. **Ship the inspection layer here too** — v2 has it (`inspect.rs`), v1 does not, and v1 is the
   product people download. The CapCut case is still only half solved on the supported branch.
2. Elevated tier, code signing, auto-update, uninstall prompt.

---

## 12. Do not

- Do not weaken §1, §6 or the executor refusals to make a feature easier.
- Do not ship a build that claims "built in Rust" while it is still the Electron app.
- Do not add a second GUI shell.
- Do not commit `opencode.json`, `rules/overrides.json`, scan caches, journals, or quarantine.
- Do not trust a size/RAM/time number that was not measured on this machine in this session.
- **Do not run `purge` against the user's live profile while testing.** `%APPDATA%\opendump\`
  and `%APPDATA%\opendump-native\` hold folders the user staged and has not decided about yet.
  Point the CLI at a throwaway location (`--journal` / `--quarantine`) or delete the demo entry
  afterwards, as the last session did.
- Do not rename the app-data directories. Staged data lives at absolute paths inside the
  journal; moving the profile orphans every quarantine batch.
- Do not edit `rules.json` in only one repo — the two copies are byte-identical and must stay so.
- Do not round-trip source files through PowerShell (§8). Use the editor tools or Node with
  explicit `utf8`.
- **Do not leave a behaviour change undocumented.** Counts, crate lists, roadmap items and
  decisions change with the code; update them in the same commit (§0). A handoff that describes
  a previous version gets rebuilt by the next agent.
- **Do not hand-edit `graphify-out/`.** It is generated: rebuild it with `/graphify .`.
- Do not run `restore --all` against the user's live profile as "cleanup" — that is how a
  deliberately quarantined 4.7 GB folder came back on 2026-10-28. List first, act on your own
  staging only.
