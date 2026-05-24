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

import type { Detector, DetectorResult, DetectorStats, DetectorWindow, Tick } from "../types";
import { Params, type ParamsResolved } from "./params";
import { prebucket } from "./prebucket";
import { runForK } from "./sweep";

export { Params } from "./params";

const ticksForGames = (allTicks: readonly Tick[], gameIds: readonly string[]): readonly Tick[] => {
  const allowed = new Set(gameIds);
  return allTicks.filter((t) => allowed.has(t.gameId));
};

const uniqueGameIds = (gameIds: readonly string[]): readonly string[] =>
  Array.from(new Set(gameIds));

// 1.2.0 (2026-05-24): Signal timing now lives in board-mad/baseline.ts with an
// explicit opening-ramp mode. Default remains the 1.1.0 rolling current-game
// behavior, but the new params are part of the cache key.
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
  version: "1.2.0",
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
    });
    const { fires, buckets } = runForK(series, params.kMad, {
      baselineMode: params.baselineMode,
      bucketSeconds: params.bucketSeconds,
      freshCapSeconds: params.freshCapSeconds,
      openingBaselineBuckets: params.openingBaselineBuckets,
      openingRampCompleteBuckets: params.openingRampCompleteBuckets,
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
