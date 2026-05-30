// Board-mad detector identity + which params force a server re-run.
//
// Extracted from the former clientRecompute.ts (deleted, audit F-002). When the
// board-volatility model moved to the Python sidecar the browser stopped
// recomputing backtests locally, which orphaned the entire client recompute
// engine while its test suite kept it green. Only these identity helpers are
// still load-bearing: BacktestPage uses them to pick the default detector and to
// label every param as "changing this needs a re-run" (the page no longer
// distinguishes recompute-able vs prebucket params — ALL changes mark the
// snapshot stale now).

export const BOARD_MAD_DETECTOR_ID = "board-mad";
// Stage 1 cascade — runs board-mad AND off-price-print over the same window
// and unions their fires. It is the default detector on the Backtest UI.
export const ENSEMBLE_OR_DETECTOR_ID = "ensemble-or";

// Params that change the prebucketed intensity series itself (not just the
// post-bucket threshold). Kept as the canonical "re-run required" set so the
// per-param re-run hints stay stable. The state-space coefficients live here too
// because the sidecar owns that math — the browser can never recompute it.
export const BOARD_MAD_PREBUCKET_PARAMS: readonly string[] = [
  "bucketSeconds",
  "weighting",
  "freshCapSeconds",
  "historicalLastGames",
  "historicalAwayWeight",
  "historicalPriorWeight",
  "historicalRampCompleteGameMinutes",
  "trailingGameMinutes",
  "recentWallMinutes",
  "recentWallWeight",
  "stateSpace",
];

export function isBoardMadPrebucketField(name: string): boolean {
  return BOARD_MAD_PREBUCKET_PARAMS.includes(name);
}
