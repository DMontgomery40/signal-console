import { describe, expect, it } from "vitest";

import type { Tick } from "@signal-console/detectors";
import { BOARD_STATE_SPACE_CONFIG_DEFAULTS } from "@signal-console/detectors/board-mad/state-space-config";

import { buildBoardVolatilityModelRequest } from "../src/services/board-volatility-model";

function tick(input: {
  readonly capturedAt: string;
  readonly gameElapsedSeconds?: number;
  readonly gameId?: string;
  readonly impliedProbability: number;
  readonly isHeartbeat?: boolean;
  readonly source?: string;
  readonly sourceMarketId: string;
  readonly volume?: number;
}): Tick {
  return {
    capturedAt: new Date(input.capturedAt),
    gameId: input.gameId ?? "nba-synth-1",
    ...(input.gameElapsedSeconds === undefined
      ? {}
      : { gameElapsedSeconds: input.gameElapsedSeconds }),
    impliedProbability: input.impliedProbability,
    isHeartbeat: input.isHeartbeat ?? false,
    ...(input.source === undefined ? {} : { source: input.source }),
    sourceMarketId: input.sourceMarketId,
    volume: input.volume ?? 100,
  };
}

describe("buildBoardVolatilityModelRequest", () => {
  it("builds per-bucket breadth and source-dominance features from quote ticks", () => {
    const request = buildBoardVolatilityModelRequest({
      bucketSeconds: 60,
      freshCapSeconds: 300,
      gameId: "nba-synth-1",
      params: {
        baselineMode: "historical-blend",
        bucketSeconds: 60,
        historicalPriorWeight: 1,
        historicalRampCompleteGameMinutes: 12,
        kMad: 5,
        stateSpace: BOARD_STATE_SPACE_CONFIG_DEFAULTS,
        trailingBuckets: 20,
        warmupBuckets: 8,
      },
      ticks: [
        tick({
          capturedAt: "2026-05-25T00:00:10.000Z",
          gameElapsedSeconds: 10,
          impliedProbability: 0.4,
          source: "bet365",
          sourceMarketId: "bet365-m1",
          volume: 100,
        }),
        tick({
          capturedAt: "2026-05-25T00:00:40.000Z",
          gameElapsedSeconds: 40,
          impliedProbability: 0.55,
          source: "bet365",
          sourceMarketId: "bet365-m1",
          volume: 100,
        }),
        tick({
          capturedAt: "2026-05-25T00:00:15.000Z",
          gameElapsedSeconds: 15,
          impliedProbability: 0.3,
          source: "kalshi",
          sourceMarketId: "kalshi-m2",
          volume: 25,
        }),
        tick({
          capturedAt: "2026-05-25T00:00:45.000Z",
          gameElapsedSeconds: 45,
          impliedProbability: 0.6,
          source: "kalshi",
          sourceMarketId: "kalshi-m2",
          volume: 25,
        }),
      ],
      weighting: "volume",
    });

    expect(request.gameId).toBe("nba-synth-1");
    expect(request.observations).toHaveLength(1);
    expect(request.observations[0]).toMatchObject({
      activeMarketCount: 2,
      bucketStart: "2026-05-25T00:00:00.000Z",
      gameElapsedSeconds: 45,
      sourceCount: 2,
    });
    expect(request.observations[0]?.sourceDominance).toBeGreaterThan(0.5);
    expect(request.observations[0]?.sourceDominance).toBeLessThan(1);
  });

  it("drops heartbeat, stale-gap, and 0.500 placeholder ticks from the model request", () => {
    const request = buildBoardVolatilityModelRequest({
      bucketSeconds: 60,
      freshCapSeconds: 60,
      gameId: "nba-synth-2",
      params: {
        baselineMode: "trailing",
        bucketSeconds: 60,
        kMad: 3,
        stateSpace: BOARD_STATE_SPACE_CONFIG_DEFAULTS,
        trailingBuckets: 20,
        warmupBuckets: 8,
      },
      ticks: [
        tick({
          capturedAt: "2026-05-25T00:00:10.000Z",
          impliedProbability: 0.4,
          isHeartbeat: true,
          sourceMarketId: "m1",
        }),
        tick({
          capturedAt: "2026-05-25T00:02:00.000Z",
          impliedProbability: 0.4,
          sourceMarketId: "m1",
        }),
        tick({
          capturedAt: "2026-05-25T00:02:10.000Z",
          impliedProbability: 0.5,
          sourceMarketId: "m1",
        }),
      ],
      weighting: "equal",
    });

    expect(request.observations).toEqual([]);
  });

  it("falls back to tipoff-anchored elapsed seconds when ticks lack game clock", () => {
    const request = buildBoardVolatilityModelRequest({
      bucketSeconds: 60,
      freshCapSeconds: 300,
      gameId: "nba-synth-3",
      params: {
        baselineMode: "opening-ramp",
        bucketSeconds: 60,
        kMad: 3,
        openingBaselineBuckets: 4,
        openingRampCompleteBuckets: 12,
        stateSpace: BOARD_STATE_SPACE_CONFIG_DEFAULTS,
        trailingBuckets: 20,
        warmupBuckets: 8,
      },
      ticks: [
        tick({
          capturedAt: "2026-05-25T00:00:10.000Z",
          impliedProbability: 0.4,
          sourceMarketId: "m1",
        }),
        tick({
          capturedAt: "2026-05-25T00:02:10.000Z",
          impliedProbability: 0.7,
          sourceMarketId: "m1",
        }),
      ],
      timingContext: {
        clockSource: "scheduled",
        gameId: "nba-synth-3",
        pbpMaxUtc: null,
        pbpMinUtc: null,
        scheduledStartUtc: new Date("2026-05-25T00:00:00.000Z"),
        tipoffAnchorUtc: new Date("2026-05-25T00:00:00.000Z"),
      },
      weighting: "equal",
    });

    expect(request.observations[0]?.gameElapsedSeconds).toBe(130);
  });
});
