import { describe, expect, it } from "vitest";

import {
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
} from "@signal-console/detectors/board-mad/config";

import type { BacktestResponse } from "../../../data/queries";
import { applyClientRecompute, BOARD_MAD_DETECTOR_ID } from "../clientRecompute";

function openingRampBacktest(): BacktestResponse {
  return {
    runId: 7,
    stats: { firesPerGame: 0, gamesInWindow: 1, totalFires: 0 },
    observations: [1, 1, 1, 1, 100, 100, 100, 100, 2].map((intensity, i) => {
      const bucketStart = new Date(i * 60_000);
      return {
        baselineMad: 0,
        baselineMedian: 0,
        bucketEnd: new Date(bucketStart.getTime() + 60_000).toISOString(),
        bucketStart: bucketStart.toISOString(),
        fired: 0,
        gameId: "nba-opening-ramp",
        intensity,
      };
    }),
  };
}

function sparseMemoryBacktest(): BacktestResponse {
  const points = [
    { minute: 0, intensity: 10 },
    { minute: 4, intensity: 11 },
    { minute: 8, intensity: 12 },
    { minute: 32, intensity: 1 },
    { minute: 36, intensity: 2 },
  ];
  return {
    runId: 8,
    stats: { firesPerGame: 0, gamesInWindow: 1, totalFires: 0 },
    observations: points.map(({ minute, intensity }) => {
      const bucketStart = new Date(minute * 60_000);
      return {
        baselineMad: 0,
        baselineMedian: 0,
        bucketEnd: new Date(bucketStart.getTime() + 60_000).toISOString(),
        bucketStart: bucketStart.toISOString(),
        fired: 0,
        gameId: "nba-sparse-memory",
        intensity,
      };
    }),
  };
}

describe("applyClientRecompute", () => {
  it("uses the shared opening-ramp baseline math for client-side backtest preview", () => {
    const recomputed = applyClientRecompute(BOARD_MAD_DETECTOR_ID, openingRampBacktest(), {
      baselineMode: BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
      kMad: 1,
      openingBaselineBuckets: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
      openingRampCompleteBuckets: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
      trailingBuckets: BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
      warmupBuckets: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
    });

    expect(recomputed?.stats.totalFires).toBe(1);
    expect(
      recomputed?.observations
        .filter((observation) => observation.fired === 1)
        .map((observation) => ({
          baselineMedian: observation.baselineMedian,
          bucketStart: observation.bucketStart,
        })),
    ).toEqual([{ baselineMedian: 1, bucketStart: "1970-01-01T00:08:00.000Z" }]);
  });

  it("recomputes sparse observations with elapsed lookback duration, not prior activity count", () => {
    const recomputed = applyClientRecompute(BOARD_MAD_DETECTOR_ID, sparseMemoryBacktest(), {
      baselineMode: BOARD_MAD_BASELINE_MODE_TRAILING,
      kMad: 3,
      openingBaselineBuckets: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
      openingRampCompleteBuckets: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
      trailingBuckets: 20,
      warmupBuckets: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
    });

    const late = recomputed?.observations.find(
      (observation) => observation.bucketStart === "1970-01-01T00:36:00.000Z",
    );
    expect(late?.baselineMedian).toBe(1);
    expect(late?.baselineMad).toBe(1e-9);
    expect(late?.fired).toBe(1);
    expect(recomputed?.stats.totalFires).toBeGreaterThanOrEqual(1);
  });
});
