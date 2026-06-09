# F-010 — The board-anomaly subsystem is unreachable from the live product (green-tested, barrel-exported), and its calibrated baseline rebuild is write-only

- **Severity:** medium — PROVEN-unreachable scaffolding that looks alive; concrete
  current harm is an admin action that does expensive work nothing consumes. NOT a
  "delete it" call — needs owner classification (intentionally staged vs abandoned),
  per the F-008 lesson about assuming intent.
- **Boundary crossed:** shared library (built + tested) ↔ live API/UI/worker (don't
  consume it) ↔ DB table (written, never read) ↔ PRD intent
- **Status:** confirmed by call-graph (every link proven below)
- **Surfaces no error:** yes — full green test suite + barrel exports make it look
  load-bearing; nothing fails because nothing calls it.

## What is proven unreachable

The board-anomaly **alert / listing / fanout** surface — `measureGameStateVolatility`,
`measureGameStateVolatilityForGame`, `listBoardAnomaliesAcrossGames`,
`listGameStateVolatilityAcrossGames`, the live/historical fanouts, and the
`BoardGameStateVolatility` type (the one with F-009's alias fields) — has **zero
callers in `apps/` or `scripts/`** (only its own `__tests__`):

- The 12 API route files are `backtest, board, cache, detectors, ensemble-or,
games, health, incidents, live, microstructure, off-price-print, settings` —
  there is **no board-anomaly route**.
- `rg "boardAnomaly\.|listBoardAnomalies|measureGameStateVolatility|BoardGameStateVolatility|...Fanout" apps scripts --glob '!*.test.*'` → **0 matches**.
- `/v1/board/.../fanout` is served by `services/fanout.ts`, which imports gold-db +
  `renderFanoutNarrative` — NOT the board-anomaly fanouts. So even "fanout" is the
  state-space board's, not this cluster's.

It IS heavily tested (`board-anomaly.test.ts`, `board-anomaly-repository.test.ts`)
and re-exported from the shared barrel (`export * as boardAnomaly`, `export * from
"./board-anomaly-*-fanouts"`). Green CI + public exports = looks alive. This is the
F-002 "dead but green-tested" pattern at subsystem scale (~15+ files).

## The write-only baseline table

- The worker exposes an admin action: `apps/worker/src/index.ts:294` —
  `actionType === "board-volatility-baseline-rebuild"` → `rebuildBoardVolatilityBaselines()`.
  That scans every NBA game's ticks + microstructure, runs the board-anomaly
  residual math (`materializeBoardObservations` → `scoreObservation` →
  `computeH0Adjustment` → `buildBoardVolatilityFeatureSnapshot`), and writes
  percentile rows (`p50..p99`) into the `board_volatility_baselines` table.
- The **reader** of that table, `resolveBoardVolatilityBaseline`
  (`board-volatility-baselines.ts`), has **zero callers**. GitNexus confirms it
  Calls things but nothing Calls it.
- Even the (dead) alert surface doesn't read it: `game-state-volatility.ts:719`
  uses `expectedRangeFromObservation` (observation-derived), and the hardcoded
  `FALLBACK_BASELINES`, not the calibrated table.

So: an operator can trigger `board-volatility-baseline-rebuild`, the worker burns a
full-DB scan, and **nothing reads the result**. Compute + an authoritative-looking
admin action with no observable effect — and no error to signal that.

## Why it matters / the intent question

The old checklist trail showed the calibrated-baseline READ path was
_intentionally_ left unwired (the live board uses fallback/observation ranges), but
the retired root PRD is no longer live authority. So the calibrated machinery is
plausibly **staged scaffolding** for a future calibration feature, not an accident.
The board-anomaly **alert** surface (0 callers, full tests) is the open question:
staged for an upcoming "board anomaly alerts" page, or abandoned?

Either way, the current state is a trap:

- A contributor extending "board volatility" finds TWO subsystems (the live
  state-space board AND this green-tested board-anomaly cluster) and can build on
  the dead one, or conflate their concepts. The two even share a filename
  (`board-volatility-model.ts` exists in both `apps/api/src/services/` and
  `packages/shared/src/board-anomaly/`).
- F-009's `state`/`band` + `headlineScore`/`score` alias fields live in THIS dead
  type → F-009's severity is downgraded (no live consumer today), but it becomes a
  live trap the moment the alert surface is wired.

## What to do (needs owner input — do NOT delete blind)

1. **Classify** (owner call): is the board-anomaly alert/listing/fanout surface
   staged-for-a-coming-feature, or abandoned? Same for the calibrated-baseline
   path. The PRD suggests the baseline READ is deliberately unwired.
2. If **abandoned**: remove the subsystem + its tests + barrel exports + the worker
   admin action, so the codebase stops advertising a parallel "board volatility."
3. If **staged**: mark it explicitly (a `// STAGED — not wired to any live route as
of <date>; see <ticket>` header on the barrel + the worker action), and gate the
   `board-volatility-baseline-rebuild` admin action behind a clear "writes a table
   nothing reads yet" note, so an operator can't trigger expensive no-op work
   believing it improves detection.
4. Fix F-009 as part of whichever path, before the alert surface goes live.

## Evidence (call-graph)

Routes: `ls apps/api/src/routes` (no board-anomaly). `rg` 0-caller proofs for the
alert entry points and `resolveBoardVolatilityBaseline`. Worker:
`apps/worker/src/index.ts:294-295`. Reader-not-used:
`game-state-volatility.ts:719` (`expectedRangeFromObservation`). Barrel:
`packages/shared/src/index.ts` (`export * as boardAnomaly`, `board-anomaly-*-fanouts`).
