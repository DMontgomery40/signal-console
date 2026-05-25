// board-mad detector — TypeScript port of scripts/board_signal_v2.py (nba-predict).
// PRD §8 / §10: the canonical board-state volatility signal. For each game we
// iterate quote_ticks in time order, bucket per-market |delta(impliedProbability)|
// (volume-weighted by log1p(volume) by default), then fire on buckets whose
// intensity exceeds a causal baseline median(prior W) + K · MAD(prior W), with
// configurable signal timing, per-market fresh cap, and is_heartbeat / 0.500
// opening-anchor sanitations. K is a compute parameter, never persisted.
//
// Implementation is split (US-033) into two K-independent / K-dependent halves:
//   - prebucket.ts: builds the per-bucket intensity series from raw ticks.
//   - sweep.ts: applies the trailing baseline + threshold check per K.
// The detector's public `run()` glues both halves together for a single K. The
// Backtest UI's Sensitivity dial (US-037) skips this glue and calls prebucket()
// once then runSweep(...) for in-memory K-sweeping in sub-second time.

import type {
  BoardMadHistoricalPrior,
  Detector,
  DetectorResult,
  DetectorStats,
  DetectorWindow,
  GameTimingContext,
  Tick,
} from "../types";
import { Params, type ParamsResolved } from "./params";
import { prebucket } from "./prebucket";
import { runForK } from "./sweep";

export { Params };
export type { ParamsResolved } from "./params";

const ticksForGames = (allTicks: readonly Tick[], gameIds: readonly string[]): readonly Tick[] => {
  const allowed = new Set(gameIds);
  return allTicks.filter((t) => allowed.has(t.gameId));
};

const uniqueGameIds = (gameIds: readonly string[]): readonly string[] =>
  Array.from(new Set(gameIds));

const historicalPriorMap = (
  priors: readonly BoardMadHistoricalPrior[] | undefined,
): ReadonlyMap<string, BoardMadHistoricalPrior> =>
  new Map((priors ?? []).map((prior) => [prior.gameId, prior]));

const timingContextMap = (
  contexts: readonly GameTimingContext[] | undefined,
): ReadonlyMap<string, GameTimingContext> =>
  new Map((contexts ?? []).map((ctx) => [ctx.gameId, ctx]));

// 1.6.0 (2026-05-25): The PBP-missing elapsed fallback (for ticks without
// per-tick gameElapsedSeconds) now anchors on the per-game GameTimingContext
// resolved by the shared detector runner (services/detector-runner.ts).
// Tipoff is PBP MIN(time_actual) when present, games.scheduled_start when
// PBP is absent, never first-nonzero market bucket. When neither anchor is
// available (clockSource="none"), the warmup gate refuses to warm any
// bucket (fail-closed posture). Cache identity already includes clockSource
// + tipoffAnchorUtc (phase A0a watermark), so scheduled-anchored cache rows
// automatically recompute when PBP arrives. Audit-fix #2 (phase A2).
//
// 1.5.0 (2026-05-24): The trailing/opening-ramp baseline sample is selected by
// elapsed time, not by slicing the sparse non-empty observation array. This
// keeps "20 one-minute buckets" equal to 20 elapsed minutes from tip-off/game
// clock, regardless of how many market observations occurred inside that
// duration. Cached runs from earlier versions must be recomputed.
//
// 1.4.0 (2026-05-24): Opening holdoff activation is elapsed time
// (`warmupBuckets * bucketSeconds`), not the count of market observations.
// This is a detector semantics change, so cached board-mad runs from earlier
// versions must be recomputed.
//
// 1.3.0 (2026-05-24): Board MAD can now use a historical/live blended
// baseline. The prebucket series carries game-clock elapsed seconds and an
// optional per-game historical prior so the sweep can use game-minute memory
// while still measuring the current 30/60s wall-clock bucket.
//
// 1.2.0 (2026-05-24): Signal timing now lives in board-mad/baseline.ts with an
// explicit opening-ramp mode. The timing params are part of the cache key.
//
// 1.1.0 (2026-05-23): API path (services/backtest.ts loadTicks) now narrows
// the tick set per-game to the PBP-anchored in-play window before feeding
// the detector, mirroring board.ts's resolveInPlayWindow. Without this,
// pre-game ticks polluted the trailing baseline and inflated fire counts
// ~14-17x against the canonical contract test's per-game means (9.3 ± 1.0
// at K=6, ~18 at K=3). Detector math is unchanged; cache rows from 1.0.0
// remain valid as data but are version-stale and will be re-computed on
// next access — that's the intentional invalidation.
export const detector: Detector<typeof Params> = {
  id: "board-mad",
  version: "1.6.0",
  displayName: "Board MAD (whole-board volatility)",
  sources: ["bet365", "kalshi", "polymarket"],
  paramsSchema: Params,
  run(window: DetectorWindow, params: ParamsResolved): DetectorResult {
    const gameIds = uniqueGameIds(window.gameIds);
    const allTicks = window.ticks ?? [];
    const scopedTicks = ticksForGames(allTicks, gameIds);
    const series = prebucket(scopedTicks, params.bucketSeconds, {
      weighting: params.weighting,
      freshCapSeconds: params.freshCapSeconds,
      gameIds,
      historicalPriors: historicalPriorMap(window.boardMadHistoricalPriors),
      timingContexts: timingContextMap(window.timingContexts),
    });
    const { fires, buckets } = runForK(series, params.kMad, {
      baselineMode: params.baselineMode,
      bucketSeconds: params.bucketSeconds,
      freshCapSeconds: params.freshCapSeconds,
      openingBaselineBuckets: params.openingBaselineBuckets,
      openingRampCompleteBuckets: params.openingRampCompleteBuckets,
      historicalAwayWeight: params.historicalAwayWeight,
      historicalLastGames: params.historicalLastGames,
      historicalPriorWeight: params.historicalPriorWeight,
      historicalRampCompleteGameMinutes: params.historicalRampCompleteGameMinutes,
      trailingGameMinutes: params.trailingGameMinutes,
      recentWallMinutes: params.recentWallMinutes,
      recentWallWeight: params.recentWallWeight,
      trailingBuckets: params.trailingBuckets,
      warmupBuckets: params.warmupBuckets,
      weighting: params.weighting,
    });
    const games = gameIds.length;
    const stats: DetectorStats = {
      firesPerGame: games === 0 ? 0 : fires.length / games,
      totalFires: fires.length,
      gamesInWindow: games,
    };
    return { fires, stats, buckets };
  },
};
