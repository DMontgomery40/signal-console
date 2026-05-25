// Tipoff-anchor regression suite (audit-fix #2, plan phase A2).
//
// Tests the PBP-MISSING path of the baseline elapsed-time fallback. When a
// bucket has no per-tick gameElapsedSeconds AND a per-game GameTimingContext
// is provided by the runner, the baseline must anchor elapsed seconds on
// tipoffAnchorUtc — NOT on "first nonzero market bucket" (the original
// category error this audit closes).
//
// These tests are companion to baseline.elapsed.test.ts, which tests the
// PBP-anchored happy path. Together they pin the contract that:
//   1. With per-tick gameElapsedSeconds: use it (covered by elapsed suite)
//   2. Without per-tick but with timingContext.clockSource in {pbp,scheduled}:
//      anchor elapsed on tipoffAnchorUtc (this suite)
//   3. With clockSource="none": refuse to warm any bucket — fail closed
//      (this suite)
//   4. Without any timingContext (legacy callers): fall back to first-bucket
//      wall-elapsed (backward-compat path, covered by elapsed suite)

import { describe, expect, it } from "vitest";

import type { GameTimingContext } from "../../types";
import {
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BUCKET_SECONDS_DEFAULT,
  BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
} from "../config";
import type { BucketSeries } from "../prebucket";
import { runForK, type SweepParams } from "../sweep";

const BUCKET_SECONDS = BOARD_MAD_BUCKET_SECONDS_DEFAULT;

const TIPOFF_ISO = "2026-05-25T01:00:00.000Z";
const TIPOFF_MS = Date.parse(TIPOFF_ISO);
const TIPOFF_S = Math.floor(TIPOFF_MS / 1000);

const baseParams = (overrides: Partial<SweepParams> = {}): SweepParams => ({
  baselineMode: BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  bucketSeconds: BUCKET_SECONDS,
  freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  openingBaselineBuckets: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  openingRampCompleteBuckets: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  historicalAwayWeight: BOARD_MAD_HISTORICAL_AWAY_WEIGHT_DEFAULT,
  historicalLastGames: BOARD_MAD_HISTORICAL_LAST_GAMES_DEFAULT,
  historicalPriorWeight: BOARD_MAD_HISTORICAL_PRIOR_WEIGHT_DEFAULT,
  historicalRampCompleteGameMinutes: BOARD_MAD_HISTORICAL_RAMP_COMPLETE_GAME_MINUTES_DEFAULT,
  trailingGameMinutes: BOARD_MAD_TRAILING_GAME_MINUTES_DEFAULT,
  recentWallMinutes: BOARD_MAD_RECENT_WALL_MINUTES_DEFAULT,
  recentWallWeight: BOARD_MAD_RECENT_WALL_WEIGHT_DEFAULT,
  trailingBuckets: BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  warmupBuckets: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  weighting: "volume",
  ...overrides,
});

const scheduledContext = (gameId = "synth-scheduled"): GameTimingContext => ({
  gameId,
  scheduledStartUtc: new Date(TIPOFF_MS),
  tipoffAnchorUtc: new Date(TIPOFF_MS),
  clockSource: "scheduled",
  pbpMinUtc: null,
  pbpMaxUtc: null,
});

const noneContext = (gameId = "synth-none"): GameTimingContext => ({
  gameId,
  scheduledStartUtc: new Date(0),
  tipoffAnchorUtc: new Date(0),
  clockSource: "none",
  pbpMinUtc: null,
  pbpMaxUtc: null,
});

// Build a BucketSeries with timingContext attached and entries that have
// NO per-tick gameElapsedSeconds — simulating the PBP-missing case the
// runner sees during live-game PBP lag.
const noPbpSeries = (
  context: GameTimingContext,
  pairs: readonly (readonly [elapsedSecFromTipoff: number, intensity: number])[],
): BucketSeries => ({
  bucketSeconds: BUCKET_SECONDS,
  weighting: "volume",
  freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  perGame: [
    {
      gameId: context.gameId,
      timingContext: context,
      buckets: pairs.map(([elapsedSec, intensity]) => ({
        bucket: TIPOFF_S + elapsedSec,
        intensity,
        gameElapsedSeconds: null,
      })),
    },
  ],
});

describe("tipoff-anchor fallback (scheduled clockSource, audit-fix #2)", () => {
  it("sparse no-PBP at tipoff+5min — bucket NOT eligible (under 8min holdoff from tipoff)", () => {
    // Per-tick gameElapsedSeconds is null. Without a tipoff anchor, the
    // legacy fallback would say "elapsed = 0" (first-bucket wall delta) and
    // also fail to warm. WITH the scheduled tipoff anchor, elapsed is the
    // real 5 minutes — still under the 8-min holdoff, still NOT eligible.
    // This test pins that both behaviors fail-closed at 5min.
    const series = noPbpSeries(scheduledContext(), [[5 * 60, 5.0]]);
    const { buckets } = runForK(series, 3.0, baseParams());
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.warmedUp).toBe(false);
  });

  it("sparse no-PBP at tipoff+15min — bucket IS eligible (past 8min holdoff from tipoff)", () => {
    // 15 elapsed minutes from tipoff >= 8 min holdoff. Without the tipoff
    // anchor, this single observation would have elapsed=0 from the first-
    // bucket fallback and would NOT warm — masking the bug. With the
    // scheduled anchor, the math correctly sees 15min elapsed and warms.
    // This is the KEY assertion that pins the tipoff-anchor contract.
    const series = noPbpSeries(scheduledContext(), [[15 * 60, 5.0]]);
    const { buckets } = runForK(series, 3.0, baseParams());
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.warmedUp).toBe(true);
  });

  it("sparse no-PBP at tipoff+5/9min — second bucket warmed; baseline draws from prior 5min entry", () => {
    // Two sparse observations: 5min and 9min from tipoff. The 9-min bucket
    // is past holdoff (9 > 8). Its baseline window includes the 5-min entry
    // (4min elapsed prior is within the trailing window). Median of a
    // 1-element sample is the value itself.
    const series = noPbpSeries(scheduledContext(), [
      [5 * 60, 2.0],
      [9 * 60, 5.0],
    ]);
    const { buckets } = runForK(series, 3.0, baseParams());
    expect(buckets[0]?.warmedUp).toBe(false);
    expect(buckets[1]?.warmedUp).toBe(true);
    expect(buckets[1]?.baselineMedian).toBe(2.0);
  });
});

describe("fail-closed posture (clockSource=none, audit-fix #2)", () => {
  it("clockSource=none — ALL buckets unwarmed regardless of elapsed time", () => {
    // resolveGameTimingContext returns clockSource="none" when both PBP and
    // games.scheduled_start are absent. The baseline MUST refuse to warm,
    // because there is no real basketball-time anchor — any "elapsed" we
    // compute would be made up. Fail-closed = no fake fires.
    const series = noPbpSeries(noneContext(), [
      [5 * 60, 1.0],
      [15 * 60, 5.0],
      [60 * 60, 10.0],
    ]);
    const { buckets, fires } = runForK(series, 3.0, baseParams());
    expect(buckets).toHaveLength(3);
    for (const b of buckets) {
      expect(b.warmedUp).toBe(false);
    }
    expect(fires).toHaveLength(0);
  });
});

describe("historical-blend tipoff fallback (audit-fix #5 amendment, Codex review P1)", () => {
  it("Codex repro: scheduled/no-PBP historical-blend at 5/10/15/20min, trailingGameMinutes=12, recentWallMinutes=0", () => {
    // Buckets at elapsed=5/10/15/20 min (from tipoff). All gameElapsedSeconds
    // null — pure PBP-lag/no-PBP case with scheduled fallback. With
    // trailingGameMinutes=12 and recentWallMinutes=0, the game window at
    // bucket 20min covers (20-12, 20) = (8, 20). Includes the 10min and
    // 15min entries, excludes 5min. Intensities are set to elapsed-minutes
    // so the assertion is human-readable: median should be (10+15)/2 = 12.5.
    //
    // PRE-FIX behavior (the bug Codex caught): liveEstimatorForHistoricalBucket
    // read current.gameElapsedSeconds directly, got null, fell through to
    // gameValues=[] -> historical-blend collapsed to recentValues=[] ->
    // estimator returned null -> resolveBoardMadBaseline fell through to
    // priorValuesForBucket which returned [5, 10, 15] (trailing window),
    // median=10. Wrong domain.
    const series = noPbpSeries(scheduledContext(), [
      [5 * 60, 5.0],
      [10 * 60, 10.0],
      [15 * 60, 15.0],
      [20 * 60, 20.0],
    ]);
    const { buckets } = runForK(
      series,
      3.0,
      baseParams({
        baselineMode: BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
        trailingGameMinutes: 12,
        recentWallMinutes: 0,
        recentWallWeight: 0,
      }),
    );
    const final = buckets[3];
    expect(final?.warmedUp).toBe(true);
    // Sample is [10, 15] (5-min entry excluded because elapsed=5 < 20-12=8).
    // Median = (10+15)/2 = 12.5; MAD = median(|10-12.5|, |15-12.5|) = 2.5.
    expect(final?.baselineMedian).toBe(12.5);
    expect(final?.baselineMad).toBe(2.5);
  });

  it("mixed PBP-lag: current bucket has finite gameElapsedSeconds, prior buckets null — tipoff fallback applies to priors", () => {
    // Simulates: PBP feed catches up at the current bucket. Earlier buckets
    // are still null (no PBP at their capture time). The game-window filter
    // must compute elapsed for each PRIOR entry via tipoff fallback so they
    // still qualify for the window.
    const ctx = scheduledContext();
    const series: BucketSeries = {
      bucketSeconds: BUCKET_SECONDS,
      weighting: "volume",
      freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
      perGame: [
        {
          gameId: ctx.gameId,
          timingContext: ctx,
          buckets: [
            { bucket: TIPOFF_S + 5 * 60, intensity: 5.0, gameElapsedSeconds: null },
            { bucket: TIPOFF_S + 10 * 60, intensity: 10.0, gameElapsedSeconds: null },
            { bucket: TIPOFF_S + 15 * 60, intensity: 15.0, gameElapsedSeconds: null },
            { bucket: TIPOFF_S + 20 * 60, intensity: 20.0, gameElapsedSeconds: 20 * 60 },
          ],
        },
      ],
    };
    const { buckets } = runForK(
      series,
      3.0,
      baseParams({
        baselineMode: BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
        trailingGameMinutes: 12,
        recentWallMinutes: 0,
        recentWallWeight: 0,
      }),
    );
    const final = buckets[3];
    expect(final?.warmedUp).toBe(true);
    // Same sample as above: prior entries get tipoff-anchored elapsed
    // (5/10/15 min). Window (8, 20) includes 10 and 15. Median = 12.5.
    expect(final?.baselineMedian).toBe(12.5);
  });
});

describe("legacy backward-compat (no timingContext provided, audit-fix #2)", () => {
  it("legacy callers without timingContext fall back to first-bucket wall-elapsed", () => {
    // BucketSeriesGame without timingContext (synthetic tests that bypass
    // the runner). The pre-A2 behavior must be preserved: elapsedSeconds
    // is computed as `current.bucket - first.bucket`. Same series, no
    // context: first entry at tipoff+5min becomes elapsed=0 (first bucket),
    // entry at tipoff+15min becomes elapsed=10min (15-5), which IS past
    // the 8-min holdoff. The 15-min bucket warms via the legacy path.
    const series: BucketSeries = {
      bucketSeconds: BUCKET_SECONDS,
      weighting: "volume",
      freshCapSeconds: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
      perGame: [
        {
          gameId: "legacy",
          buckets: [
            { bucket: TIPOFF_S + 5 * 60, intensity: 2.0, gameElapsedSeconds: null },
            { bucket: TIPOFF_S + 15 * 60, intensity: 5.0, gameElapsedSeconds: null },
          ],
        },
      ],
    };
    const { buckets } = runForK(series, 3.0, baseParams());
    expect(buckets[0]?.warmedUp).toBe(false);
    expect(buckets[1]?.warmedUp).toBe(true);
  });
});
