# Contributing

The most useful contribution is a **rule**. The classification engine is deliberately data,
not code: `rules/rules.json` decides every verdict, and you can change it without touching
TypeScript.

## Setup

```bash
npm install
npm run build
npm start          # or: npm run dev
npm test           # 46 unit tests, no Electron needed
npm run typecheck
```

The test suite moves, restores and purges **real folders inside a temporary directory**. It
never touches a real scan target.

## Adding a rule

1. Copy `rules/overrides.example.json` to `rules/overrides.json`.
2. Add your rule.
3. `npm run scan -- 'C:\' --cached` — classification re-runs in under a second against the
   cached scan, so you can iterate without rescanning.

If the rule looks generally useful, open a PR adding it to `rules/rules.json` instead.

### Rule shape

```json
{
  "id": "purge-npm-cache",
  "tier": "SAFE_PURGE",
  "category": "Package manager cache",
  "reason": "npm re-downloads packages on the next install.",
  "match": { "prefix": "%LOCALAPPDATA%\\npm-cache" }
}
```

| Field | Meaning |
| --- | --- |
| `tier` | `SAFE_PURGE`, `REVIEW`, `KEEP` or `LOCKED` |
| `reason` | Shown verbatim in the UI. Say **why**, not "cache folder". |
| `impact` | Optional. What breaks if it is removed. |
| `match.prefix` | Path prefix, tokens expanded |
| `match.name` | Final path segment |
| `match.regex` | Full-path regular expression |
| `requiresSibling` | `"package.json"` — only match when the *parent* contains it |
| `minBytes` | Ignore folders below this size |
| `display` | Colours the map but is never a review item, and protects nothing |

### Two things that trip people up

**Matchers are ANDed.** `{ "prefix": "%PROGRAMFILES%", "name": "node_modules" }` means *both*.
A rule with no matcher never fires.

**Order is semantic.** First match wins, so a specific rule must come before the general one it
should override. That is also why the shipped rules are a single ordered file rather than split
by topic: separating them by category would silently break precedence. If you want your rules
to win, `overrides.json` is prepended for exactly that reason.

### Tiers are not cosmetic

- `SAFE_PURGE` means *this regenerates itself and holds nothing you made*. Be strict.
- `REVIEW` is the correct answer when you are unsure. It still requires a human click.
- `KEEP` protects the folder **and everything inside it**. Use it for user content.
- `LOCKED` cannot be selected at all.

If a folder mixes cache and user data — the way `CapCut\User Data\Cache` mixes render scratch
files with human-named exports — do **not** mark it `SAFE_PURGE`. Mark it `REVIEW` and say why.

## Invariants that will not be merged away

These are the reason the tool is safe to run. A PR that weakens one needs an extremely good
argument:

1. **Scanning and classifying are read-only.** No writes outside the executor.
2. **Protection is monotonic downward.** A `KEEP` or `LOCKED` folder protects its whole subtree,
   even if a broader rule would match a child.
3. **Sizes never double-count.** A candidate reports its exclusive bytes; nested candidates are
   subtracted.
4. **The AI's maximum verdict is `REVIEW`.** Only a deterministic rule may say `SAFE_PURGE`.
5. **Journal before act.** Intent is written before the filesystem changes.
6. **No silent deletion.** Purging requires an explicit acknowledgement, and apps are never
   force-closed to unlock a folder.

## Pull requests

- `npm run typecheck && npm test` must pass.
- New behaviour needs a test. Rules are tested through `tests/rules.test.ts`.
- Keep changes focused; one concern per PR.
- Windows-only is fine — this is a Win32 tool — but say if you touched a path assumption.

## Reporting a misclassification

Use the **Misclassified folder** issue template. Do not paste paths containing your real
username; replace it with `%USERPROFILE%`.
