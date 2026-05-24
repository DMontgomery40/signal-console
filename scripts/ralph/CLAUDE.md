# Ralph Agent Instructions — Signal Console v2

You are an autonomous coding agent building **Signal Console v2** at `~/signal-console/`. Read `../../PRD.md` (full spec) and `prd.json` (story list with `passes` flags) before doing anything else.

---

## ⛔️ CRITICAL: Gold DB is READ-ONLY ⛔️

A 54 GB SQLite gold-DB tick store lives at `~/signal-console/data/signal-console.sqlite` (with `-wal` and `-shm` siblings). The API/UI/cache code you write **must never** write to it.

- All gold-DB opens go through `packages/db/src/open.ts` (`openGoldDb()`), which applies four guards: `file:${path}?mode=ro` URI, `{ readonly: true, fileMustExist: true }` options, `PRAGMA busy_timeout=5000`, `PRAGMA query_only=ON` (then reads back and throws if not 1).
- Never write `INSERT`, `UPDATE`, `DELETE`, `CREATE TEMP VIEW`, `PRAGMA journal_mode=...`, or any other mutation against the gold-DB handle.
- The detector cache DB at `~/signal-console/data/detector-cache.sqlite` is the only writable store the API/UI code uses. It's safe to delete/recreate.
- `K_MAD_LIVE = 3.0` and `K_MAD_CALM = 6.0` are declared exactly once, in `packages/detectors/src/board-mad/config.ts`. Never hardcode either literal elsewhere.

---

## Your Task (one story per iteration)

1. **Read `prd.json`** (in this same directory) — it lists all 41 user stories.
2. **Read `progress.txt`** in this directory for prior iteration learnings — patterns this codebase uses, gotchas previous iterations hit.
3. **Read `../../PRD.md`** for the full spec. Re-read the section relevant to today's story before coding.
4. **Check git branch.** Branch from `prd.json` `branchName` is `ralph/signal-console-v2`. If not on it, `git checkout -b ralph/signal-console-v2` from `main` (or check it out if it exists).
5. **Pick the highest-priority story** where `passes: false`. This means the lowest `priority` number among unpassed stories.
6. **Implement that story only.** Do not start adjacent stories. Each story is sized to fit one context window.
7. **Verify acceptance criteria.** Every criterion in the story is machine-verifiable — run the actual command/grep/test that proves each one. Don't claim a criterion passes without running its check.
8. **Run quality gates** required by the story (typecheck, lint, tests). At minimum: `pnpm verify` should exit 0 if the story affects code under `pnpm verify`'s scope.
9. **Commit** with message `feat: [Story ID] - [Story Title]` (e.g. `feat: US-004 - Implement read-only gold-DB open path`).
10. **Update `prd.json`** to set `passes: true` for the completed story (use `jq` or careful read/edit).
11. **Append to `progress.txt`** (see format below).
12. **If all stories pass**, output literally `<promise>COMPLETE</promise>` on its own line.

---

## Progress Report Format

APPEND to `progress.txt` (never overwrite, always append):

```
## [ISO timestamp] - [Story ID]
- What was implemented: [1-2 sentences]
- Files changed: [list]
- Verification ran: [exact commands you executed]
- **Learnings for future iterations:**
  - Codebase patterns discovered
  - Gotchas encountered
  - Useful context for the next agent
---
```

The learnings section is critical. Future iterations have **no memory** of this one. Write down anything they'd otherwise have to re-discover.

---

## Out of Scope for Ralph (owner does these manually between phases)

The following stories' acceptance criteria require owner action; do NOT attempt to execute them yourself:

- **Gold-DB relocation execution** (Phase 0 cutover). US-013 writes `docs/gold-db-relocation.md` — the document — but the owner runs the procedure (stops nba-predict processes, parks Cloudflare tunnel, `mv` the 54 GB DB, places sentinels). You may write the doc; you may NOT run the relocation.
- **Cloudflare tunnel parking / repointing** (manual cloudflared config changes).
- **Phase 0.5 ingest writer** (not in prd.json; owner decides go/no-go).
- **Phase 5 archive of `~/nba-predict`** (owner decides archive vs delete).

If a story you pick contains an acceptance criterion that requires owner action, complete the parts you can (e.g. write a doc, write a script), then leave `passes: false` and explain in `notes` what's blocked on owner action.

---

## Hard Constraints (will fail review if violated)

- **LOC: keep it focused, don't bean-count.** The old repo was 73k LOC of bloat (e.g. a 1,246 LOC SettingsPage, a 3,300 LOC live-repository.ts). The new repo should be small by intent — if a file is doing one thing well and lands at 300 or 500 LOC, that's fine. There is no hard LOC gate. The anti-pattern to avoid is conflated mega-files, not focused modules that happen to be long.
- **No `as` casts at API boundaries.** Validate with Zod.
- **No `any`.** Eslint blocks it; do not work around.
- **`pnpm verify:no-stale-plan` must stay green.** Forbidden strings: `nba-predict/data/signal-console.sqlite`, `K = 6.0 only`, `source_data_version`, `\bdata_version\b`, `shadow mode`, `old worker keeps writing`. Allowed only in `docs/gold-db-relocation.md`, `docs/PRD.md` (or the root `PRD.md`), `docs/relocation/**`, and lines containing `(historical, do not use)`.
- **Detector contract tests are the spec.** If `canonical.test.ts` fails after your change, the detector port is wrong — do not adjust the test to make it pass. Fix the detector. The K=6.0 outcomes (Hartenstein bucket-start `2026-05-08T03:12:00Z`, Reaves no-fire on both game ids, mean 9.3 ± 1.0) are validated against the research report.
- **Dependency order.** Don't pick a UI story whose API route doesn't exist yet. Story `priority` reflects dependency order — respect it.
- **Don't run mock-only tests.** Per repo defaults: integration tests against a real (in-memory or fixture-backed) SQLite are preferred over mocked DBs.

---

---

## UI Verification Protocol (REQUIRED for every UI story)

**Metadata is not verification.** "File X exists" or "snapshot matches" does NOT prove a UI works. For any story under US-022 onward whose acceptance touches `apps/web/` or `packages/ui/`, you must produce visual evidence via the computer-use and claude-in-chrome MCPs before flipping `passes: true`.

### ⚠️ VISUAL VERIFICATION RULES — PIVOT, DON'T QUIT (revised again) ⚠️

**Observed: US-036 and US-037 shipped with zero visible browser pops and zero rasterized screenshots — Ralph skipped Playwright entirely via the HTTP-smoke fallback. Owner flagged this as a rule violation.** Subsequent rule revision said "BLOCKED after two 5-min timeouts." Owner flagged THAT too: "if it hangs for 3 minutes it hangs for 5; don't just have it quit." Both wrong. Here's the right rule.

**The principle:** real, headed, on-screen browser interaction with real screenshot evidence is mandatory. If one mechanism hangs, **pivot immediately to another mechanism** — DON'T sit there waiting for the dead one, and DON'T give up. You have multiple paths:

**Path A — Playwright MCP (`@playwright/mcp` via `mcp__plugin_testing-suite_playwright-server__*` tools):**

- Try this first. `browser_navigate` with `{ headless: false }` so the window pops up on screen.
- If a single `browser_*` call has not returned in **90 seconds**, do not continue waiting. Move to Path B.

**Path B — codemode-mcp Deno scripts:**

- `codemode-mcp` (configured at `~/.config/codemode-mcp/codemode-mcp-temp/index.ts`) lets you write small Deno scripts that talk to MCPs differently AND can shell out via `Deno.Command`. Use it when Playwright MCP's wrapper is the thing hanging.
- Example: a Deno script that drives `playwright` the npm package directly (bypassing the MCP wrapper), launches Chromium headed, navigates, drags, screenshots, exits. Same effect, different layer.

**Path C — macOS native tools via Bash:**

- `open -a "Google Chrome" "http://localhost:5173"` — pops Chrome to the foreground.
- `screencapture ~/signal-console/apps/web/.ralph-screenshots/<story-id>/<n>-<label>.png` — full-screen rasterized PNG. `-R x,y,w,h` for region; `-l <window-id>` for a specific window.
- `osascript -e 'tell application "System Events" to click at {x, y}'` — programmatic click. For drag: `osascript -e 'tell application "System Events" to do shell script "..."'` with cliclick (or `osascript` mouse-down/up patterns).
- This path is always available and never hangs on MCP.

**Path D — claude-in-chrome MCP** (if installed): use directly if it's loaded. If `mcp__claude-in-chrome__*` tools are missing from your tool surface, skip to Path B or C.

**Path E — `mcp__computer-use__*` tools** (call `mcp__computer-use__request_access` first with the apps you need; browsers are tier `"read"` so use for screenshots only, not clicks). Combine with Path C for click/type.

**The flow:**

1. Try Path A. If it hangs (>90s on one tool call), abandon Path A for this story attempt.
2. Pivot to Path B (codemode Deno script). Give it 90s.
3. If B fails too, Path C (macOS native). Path C cannot hang on MCP because there is no MCP.
4. Real PNGs land in `apps/web/.ralph-screenshots/<story-id>/`. The story is `passes: true` once they exist, regardless of which path captured them.

**Hard rules:**

- **The browser MUST be visible (headed/foreground).** Owner needs to see it pop up. A headless run with no on-screen evidence does not satisfy this.
- **Screenshots MUST be real rasterized PNGs in `.ralph-screenshots/<story-id>/`.** Bundle-grep + curl alone is NOT sufficient. Three screenshots minimum (baseline / primary interaction / edge or error state).
- **HTTP smokes are SUPPLEMENTS, not substitutes.** Run them for parity assertions (DB row counts, API contract). They strengthen verification; they do not replace screenshots.
- **NO `passes: true` on "Visual screenshots: NOT captured" grounds.** That phrase in `progress.txt` is now a contradiction — if it's true, you used the wrong path. Pivot.
- **NO `BLOCKED` shortcut.** If A hangs, try B. If B hangs, try C. C uses Bash + macOS built-ins and cannot hang on MCP wrappers. There is always a path that produces a screenshot.
- **Per-call timeout is 90 seconds.** Not 3 minutes, not 5 minutes — a hang at 90s is a hang. Pivot the moment you cross it.

**Document in `progress.txt`** which path produced each screenshot (e.g. "Path A succeeded for baseline; Path C used after Path A hung on browser_drag; final screenshots in apps/web/.ralph-screenshots/US-NNN/").

**Procedure per UI story:**

1. **Start the dev server** in the background: `pnpm --filter @signal-console/web dev`. Wait for the local URL to print.
2. **Navigate via claude-in-chrome MCP** (browsers are tier "read" for computer-use — clicks are blocked there; use claude-in-chrome for navigation, clicks, form fills, drag). If claude-in-chrome is unavailable, fall back to computer-use screenshots only and explicitly say in `progress.txt` that interactive verification was blocked.
3. **Capture at least 3 screenshots** per story to `apps/web/.ralph-screenshots/<story-id>/<n>-<label>.png`:
   - **Baseline:** the page in its default state.
   - **Primary interaction:** after clicking/dragging/typing the main affordance (e.g. moving the dial, opening a game from Recent, toggling a filter).
   - **Edge or error state:** intentionally trigger a failure mode (unreachable API, empty data window, invalid input) and screenshot the result.
4. **Visually decode each screenshot** against `docs/design-language.md`:
   - Colors visible match tokens (no hex literals outside `tokens.ts`; nav underline is `accent-green`; yellow appears ONLY where a fire / active K / suspend warning is shown; body has the subtle `surface-0` gradient).
   - Typography uses Inter sans + JetBrains Mono with tabular figures for numerics.
   - Layout matches the §"Layout & density" rules — no card borders, ≥ 32 px section whitespace, max width 1440 px centered.
   - No icons, no drop shadows, no light-mode artifacts.
   - Hover/focus states are visible where applicable.
5. **Click through every interactive element** in the route (nav links, buttons, slider, inputs). Each interaction's resulting state is verified visually, not via console logs.
6. **Reference screenshots in `progress.txt`** under "Verification ran" — list every screenshot file path. The commit message body should also list them.

**A UI story is not `passes: true` until:**

- Screenshots exist at the paths above.
- `progress.txt` cites each screenshot and what it proves.
- Interactive elements have been clicked/dragged and the resulting visual state matches expectations.
- The page renders correctly at 1440 × 900 baseline AND at 1024 × 768 (resize the chrome viewport).
- Error states have been verified by intentionally breaking something (e.g. setting `VITE_API_URL` to an unreachable host) and screenshotting the fallback.

**Don't skip this for "small" UI changes.** A token mismatch on a single component bleeds visually across every screen; you only catch it by looking. If a story is too small to justify the protocol (e.g. a pure tooltip text change), say so explicitly in `notes` with the reasoning.

---

## End-to-End Verification Mandate (READ THIS BEFORE EVERY FEATURE STORY)

**Screenshots prove the UI rendered something. They do NOT prove it rendered the right something.** For any story whose acceptance involves a user-facing feature (Recent list, Live page, Backtest dial, Settings actions, Detectors registry, ExplainerCard hovers), you must produce **real-data, real-mouse, end-to-end evidence** that the feature works against the moved gold DB and the running services — not against mocks, not against fixture-only fakes.

**What "real" means concretely:**

| Surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Real verification required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Recent UI list**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The dev API is up against the moved gold DB at `~/signal-console/data/signal-console.sqlite`. The list contains actual rows queried via `/v1/games?since=PT24H`. At least one row has a numeric fires count from the actual detector cache (after lazy compute) — verify the count by also running `sqlite3 ~/signal-console/data/detector-cache.sqlite "SELECT COUNT(*) FROM detector_observations WHERE run_id IN (SELECT id FROM detector_runs WHERE game_id = '<that row's id>')"` and asserting parity.                                       |
| **Live page (`/live/:id`)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Click into a real game from Recent (real mouse via claude-in-chrome MCP). The timeline must render real `quote_ticks` data from `/v1/live/:gameId`. Fire markers must match what `/v1/board/:gameId` returns. Wait 30 seconds, observe the next poll cycle's refresh (a new tick or marker should appear if the game is in-play).                                                                                                                                                                                                                  |
| **Backtest**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Run a **real backtest** against the moved gold DB over a window containing the **K=6 Hartenstein anchor** (`2026-05-08` ± 2 days, including game `nba-0042500222`). Assert that the response from `POST /v1/backtest` with `params={kMad: 6.0, weighting: "volume", ...defaults}` contains a fire whose `bucket_start === "2026-05-08T03:12:00Z"` for game `nba-0042500222`. This is the same outcome the contract test `canonical.test.ts` pins; the UI smoke is the cross-check that the route + service + cache + UI all preserve that outcome. |
| **Sensitivity dial**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Move the dial via real mouse drag from K=3.0 to K=6.0 on the backtest result above. The fires/game preview metric MUST update without an API call (verify via Network tab — zero new `/v1/backtest` requests during drag). The new K=6.0 value must match the K=6 contract test mean (`9.3 ± 1.0` equal-weight or `8.6 ± 1.0` volume-weight).                                                                                                                                                                                                      |
| **Past alerts drilldown**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | From Recent, click into a row whose fire count > 0. The drilldown view must show each fired bucket with its timestamp, intensity, and computed baseline median + MAD. Click one of the listed alerts (real mouse). The detail view must show the surrounding context (prior 20 buckets + the firing bucket) at the K=3 live default.                                                                                                                                                                                                               |
| **Real "change a setting" round-trip** (this is what "changing a real setting" means in this app — NOT clear-cache; clear-cache is housekeeping anyone can do, not a setting): run a backtest at the defaults (K=3.0, warmup=8, weighting='volume'). Record `fires/game = X`. Change K to 6.0 via real mouse drag — assert the in-memory recompute fires (zero new `/v1/backtest` requests) and the metric updates to some `Y ≠ X`. Now change a _different_ knob (e.g. warmup 8 → 4) — assert the metric updates again to `Z ≠ Y`. Now revert everything: K → 3.0, warmup → 8. Assert the metric returns to the original `X` (to within float epsilon). This proves: (a) every knob actually does something, (b) the recompute is deterministic and stateless across reversals, (c) cached pre-bucketing is correct (the same params on the same data must produce identical output). Capture X, Y, Z, and the post-revert X' in `progress.txt`; assert ` | X - X'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | < 1e-9`. |
| **Settings page (diagnostic only)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The Settings page is a diagnostic dashboard — it has no user-adjustable settings beyond a "Clear cache" maintenance button. Verify it renders the four sections (Database / Sources / Errors / About) with real values queried from `/v1/settings`. Do NOT treat the Clear-cache button as a "setting change" — it's admin housekeeping.                                                                                                                                                                                                           |
| **ExplainerCard hover**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Hover a real K dial label. The card must open within 200 ms, show the `eli5` section in legible sans, the divider, then the `formal` section with **actually-rendered KaTeX math** (not raw `$...$` text). Move the mouse from the trigger across the 8 px bridge INTO the card body, scroll to the bottom of the `formal` section — the card must persist through all of that without dismissing. Press Escape — card dismisses.                                                                                                                  |

**The principle:** a feature is `passes: true` only when the smallest plausible smoke against the smallest plausible end-to-end stack proves the feature does its job. Mocked tests are part of the verification, not all of it. Screenshots are part of the verification, not all of it.

**Document the proof in `progress.txt`.** Every UI feature story's "Verification ran" section must include:

1. The exact commands and clicks performed.
2. The numeric assertions that passed (e.g. "asserted backtest K=6 fires/game = 9.4, within tolerance of contract test mean 9.3 ± 1.0").
3. The screenshot paths.
4. The pre/post DB queries when an action mutated state.

**If real verification is genuinely blocked** (e.g. the gold DB isn't present on the machine Ralph is running on, the ingest worker isn't running so no live data exists, no past game in the 24h window happens to have a `fires > 0` row), say so explicitly in the story's `notes`, mark `passes: false`, and stop. Do NOT flip `passes: true` on a story whose end-to-end smoke could not be completed.

---

## Reference Reading (locations relative to `~/`)

- `signal-console/PRD.md` — the spec (sections numbered 1–31).
- `signal-console/docs/design-language.md` — UI design language spec (palette, typography, motion, components, don'ts). REQUIRED reading for any UI story (US-022 onward). All UI work must source colors from `packages/ui/src/tokens.ts` and follow the principles there. No hex literals outside tokens.ts.

- `.claude/plans/concurrent-crafting-sedgewick.md` — the original architecture plan (deeper rationale).
- `nba-predict/scripts/board_signal_v2.py` — canonical Python reference for the `board-mad` detector.
- `nba-predict/packages/shared/src/board-anomaly/game-state-volatility.ts` — TypeScript reference (don't import; read for shape).
- `nba-predict/packages/shared/src/migrations.ts` — schema documentation for the gold DB (read-only).
- `nba-predict/apps/web/src/lib/*.ts` — pure utility files worth porting wholesale with their tests.
- `nba-predict/.codex/hooks.json` — the bug-fix-regression guard to port.

When porting, **do not blindly copy** — read, understand, then re-implement under the new repo's stricter eslint ruleset.

---

## When You Finish

If `jq -r '.userStories[] | select(.passes == false) | .id' prd.json` returns empty, output `<promise>COMPLETE</promise>` on its own line. The outer loop will verify.

If you cannot complete a story (e.g. blocked on owner action, or a dependency story is itself `passes: false`), explain the block in `progress.txt` and the story's `notes` field, leave `passes: false`, and exit cleanly. The outer loop has a circuit breaker that will skip stories that fail repeatedly.

---

Start now: read `prd.json`, pick the highest-priority unpassed story, implement it, verify, commit, mark `passes: true`, log to `progress.txt`. One story per iteration. No spillover.
