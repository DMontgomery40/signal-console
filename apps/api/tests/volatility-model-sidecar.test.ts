import { describe, expect, it } from "vitest";

import { BOARD_STATE_SPACE_CONFIG_DEFAULTS } from "@signal-console/detectors/board-mad/state-space-config";

import { fetchBoardVolatilityStateSpace } from "../src/services/volatility-model-sidecar";

describe("volatility model sidecar client", () => {
  it("POSTs the state-space request and returns the parsed response", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      if (typeof input === "string") {
        calledUrl = input;
      } else if (input instanceof URL) {
        calledUrl = input.toString();
      } else {
        calledUrl = input.url;
      }
      calledInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              gameId: "nba-0042500314",
              generatedAt: "2026-05-27T12:00:00.000Z",
              observations: [
                {
                  baselineMad: 4.2,
                  baselineMedian: 18.5,
                  bucketEnd: "2026-05-25T00:17:00.000Z",
                  bucketStart: "2026-05-25T00:16:00.000Z",
                  fired: true,
                  regimeScore: 0.91,
                  standardizedInnovation: 2.4,
                  threshold: 31.1,
                  warmedUp: true,
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    };

    const response = await fetchBoardVolatilityStateSpace({
      baseUrl: "http://127.0.0.1:9393/",
      fetchImpl,
      request: {
        gameId: "nba-0042500314",
        observations: [
          {
            bucketEnd: "2026-05-25T00:17:00.000Z",
            bucketStart: "2026-05-25T00:16:00.000Z",
            intensity: 101.2,
            sourceDisagreement: 0.4,
          },
        ],
        params: {
          baselineMode: "historical-blend",
          bucketSeconds: 60,
          historicalPrior: { mad: 4, median: 24, sampleSize: 20 },
          historicalPriorWeight: 1,
          historicalRampCompleteGameMinutes: 12,
          kMad: 5,
          stateSpace: BOARD_STATE_SPACE_CONFIG_DEFAULTS,
          trailingBuckets: 20,
          warmupBuckets: 8,
        },
      },
    });

    expect(calledUrl).toBe("http://127.0.0.1:9393/api/v1/models/board-volatility/state-space");
    expect(typeof calledInit?.body).toBe("string");
    expect(calledInit?.body).toContain('"sourceDisagreement":0.4');
    expect(calledInit?.headers).toEqual({ "content-type": "application/json" });
    expect(calledInit?.method).toBe("POST");
    expect(response).toEqual({
      gameId: "nba-0042500314",
      generatedAt: "2026-05-27T12:00:00.000Z",
      observations: [
        {
          baselineMad: 4.2,
          baselineMedian: 18.5,
          bucketEnd: "2026-05-25T00:17:00.000Z",
          bucketStart: "2026-05-25T00:16:00.000Z",
          fired: true,
          regimeScore: 0.91,
          standardizedInnovation: 2.4,
          threshold: 31.1,
          warmedUp: true,
        },
      ],
    });
  });

  it("fails honestly when the sidecar returns a non-200 status", async () => {
    await expect(
      fetchBoardVolatilityStateSpace({
        baseUrl: "http://127.0.0.1:9393",
        fetchImpl: () => Promise.resolve(new Response("{}", { status: 503 })),
        request: {
          observations: [],
          params: {
            baselineMode: "trailing",
            bucketSeconds: 60,
            kMad: 3,
            stateSpace: BOARD_STATE_SPACE_CONFIG_DEFAULTS,
            trailingBuckets: 20,
            warmupBuckets: 8,
          },
        },
      }),
    ).rejects.toThrow("Board volatility sidecar request failed with status 503.");
  });
});
