# opendump brag video — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a 22-second, animation-dense launch video for opendump from real captured UI and real scan data, plus a vertical cut and share copy.

**Architecture:** Capture stills from the existing Electron build through its own CDP screenshot harness, extract a real slice of the scan cache, then build the video as a Hyperframes composition in `brag-output/composition/` with one file per act. Audio is brag's bundled music and Kenney SFX. Nothing in `src/`, `rules/` or `tests/` is modified.

**Tech Stack:** Electron harness, Hyperframes 0.8.204, FFmpeg 9.0.2, Node 24, `npx tsx` for data extraction.

**Spec:** `docs/superpowers/specs/2026-10-26-opendump-brag-video-design.md`

## Global Constraints

- Master is **1920×1080**; vertical is **1080×1920**. Duration **22 s** (brag's window is 15–25 s).
- **No voiceover.** Bundled music and SFX only; nothing downloaded.
- **No edits to `src/`, `rules/`, `tests/`.** The app is read-only throughout.
- **`brag-output/` is never committed.** Add it to `.gitignore` in Task 1.
- Every on-screen number must match the spec's §6 source table. No exceptions.
- Captures use `DSA_USERDATA=<temp>\profile` and `DSA_CACHE=%APPDATA%\opendump\scan-cache.json`.
- No Docker is available: local Chrome renderer only.
- Do not run an Ollama model during this work; RAM headroom is ~2.5 GB.
- Rapid pacing must never flash text: every readable line settles before it leaves.

## Review Focus

- **Beat-boundary frames.** Text caught mid-transition is unreadable; every beat must be checked at its boundary, not just mid-scene.
- **Treemap tiles from real data.** Real folder sizes are highly skewed — a 60 GB folder will flatten the rest to slivers. Tiles must stay legible at 1080p.
- **Empty capture states.** `quarantine` and `purge` screens render nothing without staged items. Beat 3c has no visual if the isolation profile has an empty quarantine.
- **Missing audio stream.** A silent `brag.mp4` still passes a naive `ffprobe` glance; the stream must be asserted explicitly.
- **Vertical overflow.** Copy sized for 1920 wide will clip at 1080 wide; check every text element at 1080×1920.

---

### Task 1: Install brag and keep its output untracked

**Files:**
- Modify: `.gitignore`
- Create (outside repo): `~/.agents/skills/brag/`

**Interfaces:**
- Produces: `<skill-dir>` = `C:\Users\TRISTAN\.agents\skills\brag`, with `SKILL.md`, `references/`, `assets/music/`, `assets/sfx/`.

- [ ] **Step 1: Install globally**

Run: `npx --yes skills add https://github.com/latent-spaces/brag --skill brag -g`
Expected: `~/.agents/skills/brag/SKILL.md` exists.

- [ ] **Step 2: Fallback if the installer fails**

If Step 1 fails (Windows symlink privileges are a known issue), clone to temp and copy the skill folder:

```powershell
git clone --depth 1 https://github.com/latent-spaces/brag "$env:TEMP\brag-src"
Copy-Item "$env:TEMP\brag-src\skills\brag" "$env:USERPROFILE\.agents\skills\brag" -Recurse -Force
```

- [ ] **Step 3: Verify bundled assets exist**

Run: `Get-ChildItem "$env:USERPROFILE\.agents\skills\brag\assets" -Recurse -File | Measure-Object`
Expected: a non-zero music file and SFX files present. If `assets/` is missing, stop — the audio plan in Task 9 is impossible as specified.

- [ ] **Step 4: Ignore the output directory**

Append to `.gitignore`:

```
# brag video output — deliverable, not source
brag-output*/
```

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "Ignore brag video output directories"
```

---

### Task 2: Capture the real UI stills

**Files:**
- Create: `%TEMP%\opendump-brag\clicks\*.js`
- Create: `%TEMP%\opendump-brag\captures\*.png`
- Create: `brag-output\composition\assets\ui\*.png` (only the stills actually used)

**Interfaces:**
- Produces: named stills — `map`, `review`, `review-ticked`, `plan`, `purge`, `quarantine`, `ai` — each at 2960×1880 (or 1480×940 if the scale switch is ignored).

- [ ] **Step 1: Prepare an isolated profile**

```powershell
$work = "$env:TEMP\opendump-brag"
New-Item -ItemType Directory -Force "$work\profile","$work\clicks","$work\captures" | Out-Null
'{"tutorialSeen":true}' | Set-Content "$work\profile\ui-state.json" -Encoding utf8NoBOM
```

`tutorialSeen` must be true or the spotlight tour opens on top of every shot.

- [ ] **Step 2: Capture the three `--view` screens**

For each of `map`, `review`, `quarantine`:

```powershell
$env:DSA_USERDATA="$work\profile"
$env:DSA_CACHE="$env:APPDATA\opendump\scan-cache.json"
Start-Process "node_modules\electron\dist\electron.exe" -Wait -ArgumentList `
  ".", "--view=$v", "--screenshot=$work\captures\$v.png", `
  "--force-device-scale-factor=2", "--disable-gpu"
```

Expected: three PNGs. Read each one and confirm it shows populated data (the real 418 GB map), not an empty state.

- [ ] **Step 3: Capture the panel and modal states with click scripts**

Write `clicks\ai.js` that clicks `[data-tour="ai"]`; `clicks\quarantine-plan.js` that ticks the first three review rows and clicks the quarantine button; `clicks\purge.js` that continues from the plan to the purge confirmation. Run each with `--eval-file=`.

Expected: `ai.png`, `plan.png`, `purge.png`. `purge.png` must show real filenames — if it is empty, the plan step did not tick any rows.

**Do not click the final confirm.** The purge screen is captured, never executed.

- [ ] **Step 4: Record actual dimensions**

Run: `node -e "…png width/height…"` (or `magick identify`) over `captures\*.png`.
Expected: one consistent size. Note it in `brag-output\capture-notes.md`; if it is 1480×940, the composition must avoid tight push-ins.

- [ ] **Step 5: Copy only the used stills into the composition assets**

Cover `ai`, `map`, `purge`, `quarantine`, `review`, `review-ticked` (drop `plan` if unused).

---

### Task 3: Extract the real data slice

**Files:**
- Create: `brag-output\composition\assets\data\scan-slice.json`

**Interfaces:**
- Produces: `{ totals: { folders, files, bytes }, byTier: Record<Tier, number>, unknown: { count, bytes }, candidates: Array<{ name, bytes, tier }> }` — top ~40 candidates by size for the treemap, plus tier counts.

- [ ] **Step 1: Derive counts from the cache**

Run `npx tsx scripts/rule-histogram.ts .cache/scan.json` for tier counts, and `npx tsx scripts/unclassified.ts .cache/scan.json` for the unknown set.
Expected: `SAFE_PURGE 25 / REVIEW 26 / KEEP 24 / LOCKED 5` is the *rule* split; the on-screen tier split comes from candidate counts — record whichever the composition uses and keep the label honest.

- [ ] **Step 2: Write the extractor**

Small `npx tsx` script reading `.cache/scan.json`, emitting the JSON above. Use exclusive sizes (the same rule `findCandidates` applies) so the treemap cannot double-count.

- [ ] **Step 3: Verify against known figures**

Run the extractor, then assert: unknown count is **95**, unknown bytes ≈ **44.4 GB**, total folders ≈ **376,999**, total bytes ≈ **418 GB**.
Expected: all four match. A mismatch means the cache changed since the spec was written — update the video's numbers to the new truth rather than forcing the old ones.

---

### Task 4: Write brag's plan document

**Files:**
- Create: `brag-output\brag-plan.md`

**Interfaces:**
- Produces: the storyboard that Task 5–8 implement, with exact per-beat copy and timings from the spec §5.

- [ ] **Step 1: Read `skills/brag/SKILL.md` step 2 and its rubric**

- [ ] **Step 2: Write `brag-plan.md`**

Must include the 6-beat table with timings, the exact on-screen copy for each beat, SFX cues, and a `Music cue guidance` section. Durations must sum to 22 s.

- [ ] **Step 3: Check the 9-question rubric is answerable**

If any answer is "unknown", the brief is not ready; resolve it before Task 5.

---

### Task 5: Scaffold the composition and its design tokens

**Files:**
- Create: `brag-output\composition\` per Hyperframes' documented layout
- Create: `brag-output\composition\styles\tokens.css`

**Interfaces:**
- Produces: `--ink`, `--paper`, `--safe`, `--review`, `--keep`, `--locked` plus the beat container the later tasks fill.

- [ ] **Step 1: Read the Hyperframes contract**

Read `hyperframes` `SKILL.md` and `references/format.md`, `references/motion.md`, `references/look.md`. Follow the documented project layout and render entry, not an invented one.

- [ ] **Step 2: Pull the app's real palette**

Read the tier colours from the renderer CSS so the video matches the product, rather than inventing four colours.

- [ ] **Step 3: Scaffold, then prove it renders**

`npx hyperframes check` → zero errors. Render a single still frame → confirm it is 1920×1080 and non-blank.

---

### Task 6: Act 1 — hook and treemap reveal (0–4.6 s)

**Files:**
- Create: `brag-output\composition\beats\01-hook.*`, `02-map.*`

- [ ] **Step 1: Build the hook** — folder-name storm, hard stop, `ten minutes, nothing actionable`, then **172 seconds**.

- [ ] **Step 2: Build the reveal** — real treemap tiles erupting, tier colours snapping, counters to 376,999 / 1,864,471 / 418 GB.

- [ ] **Step 3: Prove tile legibility with real sizes** — the largest real candidate will dominate. Assert the smallest rendered tile is at least ~24 px on its short edge at 1080p; if it is not, group tail folders into an `other` tile rather than drawing invisible slivers.

- [ ] **Step 4: Check, then inspect boundary frames at 2.2 s and 4.6 s** — text must be settled and legible, not mid-transition.

---

### Task 7: Act 2 — review, purge, undo (4.6–12.8 s)

**Files:**
- Create: `brag-output\composition\beats\03-review.*`, `04-purge.*`, `05-undo.*`

- [ ] **Step 1: Review** — real rows and reasons, checkboxes ticking in rapid fire.

- [ ] **Step 2: Purge** — real filenames scrolling, hard stop on `every file named before anything dies`.

- [ ] **Step 3: Undo** — rename animation and a `RESTORED` stamp.

- [ ] **Step 4: Verify the empty-state risk** — if `quarantine.png` shows nothing staged, substitute the review screen's restore affordance rather than showing an empty table.

- [ ] **Step 5: Check, then inspect frames at 7.4 s, 10.4 s, 12.8 s.**

---

### Task 8: Act 3 — AI, punchline, outro (12.8–22 s)

**Files:**
- Create: `brag-output\composition\beats\06-ai.*`, `07-rules.*`, `08-outro.*`

- [ ] **Step 1: Local AI** — the real panel; `95 folders no rule could explain · 44.4 GB`; then the ceiling: **the model can only answer Review or Keep**.

- [ ] **Step 2: Punchline** — stacked bar of 80 rules by tier, `72 tests`, `one module can write`.

- [ ] **Step 3: Outro** — wordmark, `github.com/masterdorime/opendump`, `Windows · MIT`, settling into a frame that reads as a loop restart.

- [ ] **Step 4: Check, then inspect frames at 16.2 s, 19.4 s, 22 s.**

---

### Task 9: Audio — music and SFX cues

**Files:**
- Modify: composition audio track

- [ ] **Step 1: Place the bundled track** on brag's cue guidance; no track substitution or download.

- [ ] **Step 2: Place SFX** at the cue points named in `brag-plan.md` (impact at 2.2 s, ticks in beat 2, thud at 10.4 s, stamp at 12.8 s, hits in beat 4).

- [ ] **Step 3: Verify no clipping** — render the audio, check peak level is below 0 dBFS.

---

### Task 10: Render the master, poster and share copy

**Files:**
- Create: `brag-output\brag.mp4`, `brag-output\brag.jpg`, `brag-output\share-copy.txt`

- [ ] **Step 1: Render** at 1920×1080, 22 s.

- [ ] **Step 2: Assert with ffprobe** — 1920×1080, ~22 s, yuv420p, and **an audio stream is present**.

- [ ] **Step 3: Choose the poster frame deliberately** — a settled, representative frame — and bake it as frame 0.

- [ ] **Step 4: Write share copy** — grounded in the same claims as the video; no numbers that are not in the spec's source table.

---

### Task 11: Vertical cut (1080×1920)

**Files:**
- Create: `brag-output\composition-vertical\`, `brag-output\brag-vertical.mp4`

- [ ] **Step 1: Re-compose, do not crop** — treemap fills the frame, type stacks.

- [ ] **Step 2: Check every text element for overflow at 1080 wide.**

- [ ] **Step 3: Render and assert with ffprobe** — 1080×1920, ~22 s, audio present.

---

### Task 12: Final verification

- [ ] **Step 1: `npx hyperframes check`** in both compositions → zero errors.

- [ ] **Step 2: Frame sweep** — extract one frame per second and look at all 22. Text legible, nothing clipped, no beat boundary caught mid-transition.

- [ ] **Step 3: Silent watch** — the master must make sense muted.

- [ ] **Step 4: Loop check** — last frame settles into a clean restart.

- [ ] **Step 5: Claim audit** — every number on screen traced to the spec's §6 table. Anything untraceable is cut.

- [ ] **Step 6: Commit** any remaining docs (this plan) and confirm `git status` shows no `brag-output/` files.
