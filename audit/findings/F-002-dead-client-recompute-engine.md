# F-002 — clientRecompute.ts recompute engine is dead in production but green-tested and "lockstep"-annotated (loaded gun)

- **Severity:** medium (latent; becomes high if revived)
- **Boundary crossed:** web UI ↔ detector math; live code ↔ test suite ↔ docs/progress notes
- **Status:** confirmed
- **Surfaces no error:** yes — dead code with a passing test suite looks maximally alive.

## What happened

`apps/web/src/features/backtest/clientRecompute.ts` (332 lines) is a faithful
client-side reimplementation of the board-mad sweep (it imports the shared
`resolveBoardMadBaseline`, then applies the `median + k·mad` fire rule exactly as
`sweep.ts` does). It was the engine behind the backtest "live preview" — dragging
a dial recomputed fires/game in-memory without a server round-trip.

When board-volatility moved to the Python sidecar, the page was changed to stop
recomputing locally (`BacktestPage.tsx:9-12`). The wiring was neutered:

```ts
function clampedStats(snapshot, currentParams): RecomputeView {
  void currentParams;                       // <-- ignores the form entirely
  return { stats: snapshot.response.stats,
           observations: snapshot.response.observations,
           fromRecompute: false };          // <-- always false now
}
```

`BacktestPage.tsx` now imports only three trivial things from the file —
`isBoardMadPrebucketField`, `BOARD_MAD_DETECTOR_ID`, `ENSEMBLE_OR_DETECTOR_ID`.

## What is now dead but looks alive

Orphaned (no production caller, only the file's own test references them):
`applyClientRecompute`, `recomputeBoardMad`, `clientRecomputeSupportsBaselineMode`,
`hasBoardMadPrebucketDrift`, `readBoardMadRecomputeParams`, `boardParamsForDetector`,
`groupByGame`, `observationToBaselineEntry`, `BOARD_MAD_RECOMPUTE_PARAMS`,
`isBoardMadRecomputeField`, `DEFAULT_BOARD_RECOMPUTE_PARAMS`.

Why this is a loaded gun, not just clutter:

1. **It tests green.** `__tests__/clientRecompute.test.ts` exercises the dead
   `applyClientRecompute`/`recomputeBoardMad` and passes — so CI signals "this
   code is healthy and used." Nothing tells a maintainer it's orphaned.
2. **It carries a lockstep mandate.** `scripts/ralph/progress.txt` instructs:
   "If a future story changes the server sweep semantics, this client copy must
   change in lockstep — keep the comment on top of clientRecompute.ts pointing at
   sweep.ts as the source of truth." Nobody will keep a dead file in lockstep, so
   the moment `sweep.ts` changes, this copy silently diverges.
3. **Revival hazard.** A future "bring back live preview" story would wire
   `applyClientRecompute` back in — resurrecting **board-mad median+MAD math** as
   the preview, even on surfaces whose real detector is now the state-space
   sidecar, and reintroducing a buried defect: the client recompute has **no
   `timingContext`** (its `BoardMadRecomputeParams` lacks the field the server
   feeds), so for PBP-lagged games it would compute warmup/trailing windows off
   the legacy "first-bucket" elapsed fallback while the server uses the
   tipoff-anchored game clock — different fires, silently, exactly on the games
   where elapsed-time anchoring matters most.

## Fix

- If client preview is gone for good: delete the recompute engine and its test,
  keep only the three still-used exports (move them to a small `board-mad-ids.ts`),
  and drop the lockstep note. Dead code that tests green is worse than no code.
- If preview is coming back: wire it through the **sidecar** (or thread
  `timingContext` into the client recompute and add a server-vs-client parity
  test on a PBP-lagged fixture) before re-enabling, and make `fromRecompute`
  reachable again.

## Evidence

- `BacktestPage.tsx:723-733` (`clampedStats` neutered), `:9-12` (design comment),
  `:37-41` (only 3 imports used).
- `clientRecompute.ts:269-331` (orphaned engine), `:59-67` (no `timingContext`).
- `progress.txt` lockstep mandate; `__tests__/clientRecompute.test.ts` green on dead code.
- Related: F-003 (the UI copy still promises the preview this engine used to power).

---

## RESOLUTION (fixed 2026-05-30)

Deleted the dead engine rather than leave a green-tested loaded gun:

- Extracted the only three still-used exports (`BOARD_MAD_DETECTOR_ID`,
  `ENSEMBLE_OR_DETECTOR_ID`, `isBoardMadPrebucketField` + its param list) into
  `apps/web/src/features/backtest/boardMadDetectorIds.ts`.
- Repointed `BacktestPage.tsx`'s import to the new module.
- `git rm` `clientRecompute.ts` and `__tests__/clientRecompute.test.ts` (the
  orphaned engine + the suite that kept it falsely green).

Verified: web typecheck clean (`tsc --noEmit` exit 0); BacktestPage +
SensitivityDial suites pass (48 tests). The `timingContext` revival hazard is
moot now that the divergent client copy no longer exists; if a live preview is
ever rebuilt it must go through the sidecar (noted in the ledger).
