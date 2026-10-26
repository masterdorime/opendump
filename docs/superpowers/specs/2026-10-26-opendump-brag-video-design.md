# opendump launch video — design

**Date:** 2026-10-26
**Status:** approved for planning
**Deliverable:** a brag launch video for opendump, plus a vertical cut and share copy.

---

## 1. Why

opendump has no showcase. Its README opens on a screenshot and a warning; a visitor has to read
the whole thing to understand that the interesting part is not "it deletes files" but "it is
pathologically careful about it". A 22-second video communicates that in the time it takes
someone to decide whether to keep scrolling.

The video is aimed at three audiences at once, so the master must work without sound:

1. A public launch post (X, GitHub release notes).
2. A README embed — first thing a repo visitor sees, loops cleanly, silent-friendly.
3. A portfolio piece — communicates engineering depth, not just comedy.

## 2. Verified environment

Everything brag requires was checked on this machine, not assumed.

| Requirement | Status |
|---|---|
| Node.js 22+ | 24.19.0 |
| FFmpeg on PATH | 9.0.2 (gyan.dev full build) |
| Hyperframes CLI | 0.8.204 (latest), `doctor` passes |
| Chrome headless | cached, `152.0.7977.30` |
| Docker | **absent** — local Chrome renderer path only |
| whisper-cpp / Kokoro TTS / MusicGen | **absent** — see §7 |
| GPU | RTX 4060 Laptop, 8188 MiB |
| Host RAM | 11.7 GB total, ~2.5 GB free |
| Existing build | `out/`, `node_modules/`, `electron.exe` all present |
| Real scan data | `%APPDATA%\opendump\scan-cache.json`, 58 MB, 2026-10-26 |

## 3. Non-goals

- **No changes to application source.** `src/`, `rules/`, `tests/` are read-only for this work.
  The single documentation fix this required — the README's stale "AI is not reachable" claim —
  was approved and shipped separately as `b25b5f8`, before this spec.
- **No voiceover.** Kokoro is not installed (see §7).
- **No claim the video cannot substantiate.** If it is not captured UI or verifiable in code,
  it does not go on screen.
- **No committed build artifacts** unless explicitly requested afterwards. `brag-output/` stays
  out of git; embedding the final `brag.jpg` / `brag.mp4` into `docs/` is a separate decision.

## 4. Material pipeline

brag's creative law is "show the thing — no abstract filler". opendump's thing is a desktop
window, so two real sources feed the composition.

### 4.1 Real UI stills

Captured with the app's own existing harness (CDP `Page.captureScreenshot`, because
`capturePage()` throws `UnknownVizError` on this GPU):

```
node_modules\electron\dist\electron.exe . ^
  --view=<map|review|quarantine> ^
  --screenshot=<out.png> ^
  --eval-file=<click.js> ^
  --force-device-scale-factor=2 ^
  --disable-gpu
```

- The window is 1480×940 (min 1080×680), so `--force-device-scale-factor=2` is expected to
  yield **2960×1880** stills at identical layout, with headroom to push in and no softness. If
  the switch is not honoured, fall back to upscaling from 1480×940 and avoid camera moves that
  need more pixels than that.
- Valid `--view` values are `map`, `review`, `quarantine` (`App.tsx:62-64`).
- The AI panel, plan modal, purge confirmation and tour overlay have no `--view`; they are
  reached by clicking from an `--eval-file` script.
- Budget ~1.1 s between the last click and capture: later timers never fire.

| Shot | How it is reached | Used for |
|---|---|---|
| `map.png` | `--view=map` | beat 2 — treemap reveal |
| `review.png` | `--view=review` | beat 3a — real rows and reasons |
| `review-ticked.png` | `review` + click row checkboxes | beat 3a — selection state |
| `plan.png` | after ticking, click Quarantine selected | beat 3b — the plan |
| `purge.png` | from the plan, click through to confirm | beat 3b — real filenames |
| `quarantine.png` | `--view=quarantine` | beat 3c — staged, restorable |
| `ai.png` | click `[data-tour="ai"]` | beat 3d — the Local AI panel |
| `tour.png` | click `.help` (or a fresh profile, where the tour auto-opens) | spare |

**Isolation.** Captures run with `DSA_USERDATA` pointed at a throwaway profile and `DSA_CACHE`
pointed at the real cache. This gives a real 418 GB map without touching the user's actual
`ai-settings.json`, `journal.jsonl`, `ui-state.json` or `quarantine/`. The app is only ever
*read*: no scan is triggered, nothing is quarantined, no journal record is written.

### 4.2 Real scan data

The treemap in the video is drawn from a real drive rather than invented placeholders — the
tiles are this machine's actual folders and sizes.

- `scripts/rule-histogram.ts` and `scripts/unclassified.ts` run read-only against the cache.
- Top candidates by tier — real folder names, real sizes — drive the treemap tiles, the tier
  counts and the AI beat's headline figure.
- Extracted numbers are frozen into the composition as data, so the render is deterministic.

## 5. Storyboard — chaotic, 22 s, six beats

Chaotic tone: fast, loud, high cut rate. brag's readability law still applies — fast in, then
hold. Every line a viewer must read stays long enough to read it.

| # | Beat | Time | Content | SFX |
|---|---|---|---|---|
| 1 | Hook | 0–2.2 | A storm of real folder names and sizes rips across frame, slams to a stop. `Get-ChildItem -Recurse` → **ten minutes, nothing actionable.** Then: **172 seconds.** | whoosh, impact |
| 2 | Reveal | 2.2–4.6 | Real treemap erupts tile by tile, tier colours snap in, counters slam to **376,999 folders · 1,864,471 files · 418 GB** | riser, ticks |
| 3a | Review | 4.6–7.4 | Real rows, real reasons, tier chips ticking in rapid fire | rapid clicks |
| 3b | Purge confirm | 7.4–10.4 | Real filenames scroll past, then a hard stop: **every file named before anything dies** | scroll, thud |
| 3c | Quarantine | 10.4–12.8 | Rename animation, then the undo: **RESTORED** | swoosh, stamp |
| 3d | Local AI | 12.8–16.2 | The real panel. **95 folders no rule could explain · 44.4 GB · qwen3.5:4b fits.** Then the ceiling: **the model can only answer Review or Keep** | UI blips |
| 4 | Punchline | 16.2–19.4 | Rules as a stacked bar: **80 rules — 25 Safe / 26 Review / 24 Keep / 5 Locked.** **72 tests. One module can write.** | drum hits on each |
| 5 | Outro | 19.4–22 | Wordmark, `github.com/masterdorime/opendump`, Windows · MIT. Loops back to beat 1 | resolve |

Beat 3d exists because the first draft omitted it and that was wrong — the Local AI panel is
shipped and reachable, and its guarantee is the single strongest claim the product has.

## 6. Every on-screen claim, and its source

| Claim | Source |
|---|---|
| 172 s / 376,999 folders / 1,864,471 files / 418 GB | README §What it does, measured on a 474 GB drive |
| 80 rules — 25 / 26 / 24 / 5 by tier | counted from `rules/rules.json` |
| 72 tests | `npm test` — 72 passed, 4 files, 432 ms |
| 95 unknown folders, 44.4 GB | `scripts/unclassified.ts .cache/scan.json` |
| qwen3.5:4b fits; 3.3 GB | installed Ollama model + `ai-settings.json` default |
| AI can only answer REVIEW or KEEP | `verdict.ts:1` and the coercion at `verdict.ts:54` |
| Only one module can write | `src/shared/*` write-power table in AGENTS.md §4 |

Anything that cannot be sourced this way is cut from the video, not softened.

## 7. Audio

- **Music on.** brag bundles a CC BY 4.0 track ("Happy Beats / Business Moves", ende.app) with
  beat-syncable cues. Nothing is downloaded; the render stays licence-clean.
- **SFX on.** Kenney sound effects, bundled.
- **Voice off.** Kokoro is not installed, and pulling a Python TTS stack (torch et al.) in for a
  22-second clip is a large, fragile dependency. The chaotic tone carries on kinetic type and
  hits. `--voice` remains available if this decision is revisited.

## 8. Tooling

brag is an agent skill, not a CLI — this repo has no `brag` skill installed yet.

```
npx skills add https://github.com/latent-spaces/brag --skill brag
```

(falls back to copying `skills/brag/` into `~/.agents/skills/brag` if Windows symlink creation
fails, which the upstream README documents.) I then execute `skills/brag/SKILL.md` steps 1–4 in
order and respect its four gates:

1. `brag-plan.md` exists with a full storyboard; scene durations sum to 15–25 s.
2. `npx hyperframes check` passes with zero errors inside `composition/`.
3. `brag.mp4` exists, with a *chosen* best-frame poster baked as frame 0.
4. `share-copy.txt` is written.

Output lands in `brag-output/` (timestamped if it already exists).

## 9. Formats

- **Landscape 1920×1080** is the master and the primary deliverable.
- **Vertical 1080×1920** is a *re-composition*, not a centre crop: the treemap fills the frame
  and type stacks. A 16:9 desktop window cropped to 9:16 is unreadable, so the vertical cut
  reuses the same assets and data with a different layout.
- Square is not planned. It can be added from the same assets if wanted.

## 10. Verification

No "it rendered" claims. Each of these is run and its output inspected:

1. `npx hyperframes check` — zero errors, in `composition/`.
2. `ffprobe` on each output — resolution, duration, pixel format, and that an audio stream exists.
3. Extract a frame at every beat boundary and **look at it**, checking text is settled and
   legible rather than mid-transition.
4. Silent watch — the master must be understandable with audio muted.
5. Loop check — the outro settles into a frame that reads as a clean restart.
6. Poster is a deliberately chosen frame, not frame 0 of an animation.

## 11. Risks

| Risk | Mitigation |
|---|---|
| CDP capture throws `UnknownVizError` (has happened in this repo before) | reuse the existing harness path, which already uses CDP rather than `capturePage()` |
| RAM is tight (~2.5 GB free) and brag + Chrome + a Hyperframes render are heavy | render one format at a time with other apps closed; do **not** run an Ollama model concurrently |
| Running the 4B model on camera | **not done.** Showing the panel is truthful; claiming a run we did not perform is not |
| No Docker | stay on the local Chrome renderer; do not reach for container-based Hyperframes features |
| Chaotic density vs. readability | enforce the hold durations in §5; verify with step 3 of §10 |
| Capturing the user's live profile | `DSA_USERDATA` isolation, §4.1 |

## 12. Open follow-ups (not part of this work)

- `scripts/unclassified.ts` lists a stale `AppData\Roaming\Drive Size Audit\quarantine\...` path
  (pre-rename app name) as 2.58 GB of "unknown" — real dead weight in the unknown list.
- Whether the finished `brag.mp4` / `brag.jpg` should be committed into `docs/` and embedded at
  the top of the README.
