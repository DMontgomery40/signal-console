import assert from "node:assert/strict";
import test from "node:test";

import { BASELINE_DEFAULTS } from "../apps/api/src/services/detector-defaults";

import {
  buildMarketOutlierEpisodes,
  buildMarketOutlierResults,
  buildRuntimeStateSpaceAlgorithms,
  buildStateSpaceRequestForGame,
  detectWithPythonStateSpace,
  summarizeAlgorithm,
} from "./run-nba-detector-bakeoff";

type GameData = Parameters<typeof buildMarketOutlierEpisodes>[0];
type AlgoSpec = Parameters<typeof buildMarketOutlierResults>[0][number];
type FireMap = Parameters<typeof buildMarketOutlierResults>[2];
type Fire =
  FireMap extends ReadonlyMap<string, infer FireList>
    ? FireList extends readonly (infer FireType)[]
      ? FireType
      : never
    : never;
type IncidentAlgoResult = Parameters<typeof summarizeAlgorithm>[1][number];
type GameAlgorithmSummary = Parameters<typeof summarizeAlgorithm>[3][number];
type PairContribution = GameData["pairs"][number];
type MicroEvent = GameData["micro"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isParsedStateSpaceRequest(
  value: unknown,
): value is { params: { stateSpace: typeof BASELINE_DEFAULTS.stateSpace } } {
  if (!isRecord(value)) return false;
  const record = value;
  if (!isRecord(record["params"])) return false;
  const params = record["params"];
  return typeof params["stateSpace"] === "object" && params["stateSpace"] !== null;
}

function makeGameWithTapeBurst(): GameData {
  const startIso = "2026-05-01T00:00:00Z";
  const startSec = Date.parse(startIso) / 1000;
  const pairs: PairContribution[] = [];
  const micro: MicroEvent[] = [];
  for (let bucketIndex = 0; bucketIndex < 10; bucketIndex += 1) {
    const timeSec = startSec + bucketIndex * 30 + 5;
    const hot = bucketIndex === 4 || bucketIndex === 5;
    const marketCount = hot ? 8 : 1;
    for (let marketIndex = 0; marketIndex < marketCount; marketIndex += 1) {
      const pair: PairContribution = {
        timeSec,
        sourceMarketId: `m-${bucketIndex}-${marketIndex}`,
        source: marketIndex % 2 === 0 ? "bet365" : "draftkings",
        family: marketIndex % 3 === 0 ? "player_points" : "moneyline",
        deltaP: hot ? 0.95 : 0.02,
        deltaLogit: hot ? 1.3 : 0.04,
        volume: hot ? 1400 : 10,
      };
      pairs.push(pair);
    }
    if (hot) {
      const event: MicroEvent = {
        timeSec,
        source: "polymarket",
        sourceMarketId: `micro-${bucketIndex}`,
        instrumentId: `micro-${bucketIndex}`,
        severity: bucketIndex === 5 ? 220 : 140,
      };
      micro.push(event);
    }
  }
  const points: GameData["window"]["points"] = [];
  const bucketCache: GameData["bucketCache"] = new Map();
  return {
    gameId: "nba-test-1",
    window: {
      gameId: "nba-test-1",
      scheduledStart: startIso,
      homeKey: "okc",
      awayKey: "sas",
      startIso,
      endIso: "2026-05-01T03:00:00Z",
      startSec,
      endSec: startSec + 3 * 60 * 60,
      points,
    },
    pairs,
    micro,
    bucketCache,
  };
}

function makeFire(gameId: string, observedAtSec: number): Fire {
  return {
    gameId,
    bucketStartIso: new Date((observedAtSec - 30) * 1000).toISOString(),
    observedAtIso: new Date(observedAtSec * 1000).toISOString(),
    observedAtSec,
    score: 12,
    threshold: 7,
    period: 4,
    secondsRemaining: 220,
    scoreMarginAbs: 4,
    activeMarketCount: 8,
    sourceCount: 2,
    familyCount: 2,
    offpriceFanout: 1,
  };
}

function makeGameSummary(
  algoId: string,
  gameId: string,
  fires: number,
  episodes: number,
): GameAlgorithmSummary {
  return {
    algoId,
    gameId,
    scheduledStart: "2026-05-01T00:00:00Z",
    matchup: "SAS @ OKC",
    fires,
    episodes,
    finalFiveCloseFires: fires,
    firstFireIso: fires > 0 ? "2026-05-01T00:02:30.000Z" : null,
    lastFireIso: fires > 0 ? "2026-05-01T00:03:00.000Z" : null,
    bucketSeconds: 30,
    bucketCount: 10,
    quotePairCount: 24,
    microEventCount: 2,
    activeMarketCount: 8,
    sourceCount: 2,
    familyCount: 2,
    meanActiveMarketsPerBucket: 2.4,
    p95ActiveMarketsPerBucket: 8,
    maxActiveMarketsPerBucket: 8,
    p95Score: 30,
    maxScore: 35,
    firesPer100QuotePairs: 8.3,
    episodesPer100QuotePairs: 4.1,
    diagnosis: "synthetic",
  };
}

void test("buildMarketOutlierEpisodes merges adjacent tape bursts into one episode", () => {
  const game = makeGameWithTapeBurst();
  const episodes = buildMarketOutlierEpisodes(game);
  assert.equal(episodes.length, 1);
  const [episode] = episodes;
  assert.ok(episode);
  assert.equal(episode.bucketCount, 2);
  assert.equal(episode.gameId, "nba-test-1");
  assert.ok(episode.peakSeverity > 0);
  assert.ok(episode.peakPriceMoveZ >= 3);
  assert.match(episode.diagnosis, /price move outlier|extreme price move/);
  assert.match(episode.diagnosis, /broad market participation/);
  assert.match(episode.diagnosis, /microstructure confirmation/);
});

void test("market-outlier results and summary metrics track inside versus outside fires", () => {
  const game = makeGameWithTapeBurst();
  const [episode] = buildMarketOutlierEpisodes(game);
  assert.ok(episode);

  const algoA: AlgoSpec = {
    id: "algo-a",
    name: "Algo A",
    family: "historical-prior",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-wall",
    k: 3,
    warmupBuckets: 0,
    minPrior: 1,
    formula: "score > threshold",
    rationale: "synthetic test",
    citations: [],
  };
  const algoB: AlgoSpec = {
    id: "algo-b",
    name: "Algo B",
    family: "control",
    bucketSeconds: 30,
    scoreKind: "board-vw",
    baselineKind: "mad-wall",
    k: 3,
    warmupBuckets: 0,
    minPrior: 1,
    formula: "score > threshold",
    rationale: "synthetic test",
    citations: [],
  };

  const insideFire = makeFire(episode.gameId, episode.startSec + 30);
  const outsideFire = makeFire(episode.gameId, episode.endSec + 300);
  const firesByAlgoGame: FireMap = new Map([
    [`${algoA.id}:${episode.gameId}`, [insideFire, outsideFire]],
    [`${algoB.id}:${episode.gameId}`, [outsideFire]],
  ]);

  const marketResults = buildMarketOutlierResults([algoA, algoB], [episode], firesByAlgoGame);
  const algoAResult = marketResults.find((result) => result.algoId === algoA.id);
  const algoBResult = marketResults.find((result) => result.algoId === algoB.id);
  assert.ok(algoAResult);
  assert.ok(algoBResult);
  assert.equal(algoAResult.caught, true);
  assert.equal(algoAResult.firesInWindow, 1);
  assert.equal(algoBResult.caught, false);

  const incidentResults: IncidentAlgoResult[] = [
    {
      incidentId: "inc-1",
      algoId: algoA.id,
      scoreable: true,
      caught: true,
      leadSeconds: 12,
      fireIso: insideFire.observedAtIso,
      skipReason: null,
    },
  ];
  const summary = summarizeAlgorithm(
    algoA,
    incidentResults,
    firesByAlgoGame,
    [makeGameSummary(algoA.id, episode.gameId, 2, 1)],
    marketResults,
    [episode],
  );
  assert.equal(summary.marketOutlierEpisodeCount, 1);
  assert.equal(summary.marketOutlierEpisodesCaught, 1);
  assert.equal(summary.marketOutlierRecall, 100);
  assert.equal(summary.firesInsideMarketOutlierWindows, 1);
  assert.equal(summary.firesOutsideMarketOutlierWindows, 1);
  assert.equal(summary.firesInsideMarketOutlierShare, 50);
});

void test("runtime state-space algorithms derive directly from detector defaults", () => {
  const defaults = {
    ...BASELINE_DEFAULTS,
    kMadLive: 5,
    baselineMode: "historical-blend" as const,
    bucketSeconds: 30,
    stateSpace: {
      ...BASELINE_DEFAULTS.stateSpace,
      trigger: {
        ...BASELINE_DEFAULTS.stateSpace.trigger,
        enterOffset: 1.4,
      },
    },
  };
  const algorithms = buildRuntimeStateSpaceAlgorithms(defaults);
  const [runtime] = algorithms;
  assert.ok(runtime);
  assert.equal(runtime.engine, "python-state-space");
  assert.equal(runtime.k, 5);
  assert.equal(runtime.runtimeBaselineMode, "historical-blend");
  assert.equal(runtime.bucketSeconds, 30);
  assert.deepEqual(runtime.stateSpace, defaults.stateSpace);
  assert.match(runtime.rationale, /Current detector defaults/);
});

void test("state-space bakeoff path forwards the structured request and maps fired buckets", async () => {
  const game = makeGameWithTapeBurst();
  const defaults = {
    ...BASELINE_DEFAULTS,
    bucketSeconds: 30,
  };
  const [algo] = buildRuntimeStateSpaceAlgorithms(defaults);
  assert.ok(algo);
  const games = new Map([[game.gameId, game]]);
  const request = buildStateSpaceRequestForGame(game, algo, games);
  assert.ok(request.observations.length > 0);
  const first = request.observations[0];
  assert.ok(first);
  assert.equal(first.activeMarketCount, 1);
  const broadIndex = request.observations.findIndex(
    (observation) => (observation.activeMarketCount ?? 0) > 1,
  );
  assert.ok(broadIndex >= 0);
  let seenRequest: unknown = null;
  const fires = await detectWithPythonStateSpace(game, algo, games, {
    baseUrl: "http://sidecar.test",
    fetchImpl: (_input, init) => {
      const rawBody = init?.body;
      seenRequest = JSON.parse(typeof rawBody === "string" ? rawBody : "{}");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              generatedAt: "2026-05-28T00:00:00Z",
              gameId: game.gameId,
              observations: request.observations.map((observation, index) => ({
                bucketStart: observation.bucketStart,
                bucketEnd: observation.bucketEnd,
                baselineMedian: observation.intensity / 2,
                baselineMad: 0.5,
                threshold: observation.intensity * 0.75,
                standardizedInnovation: index === broadIndex ? 4.2 : 0.2,
                regimeScore: index === broadIndex ? 1 : 0.05,
                warmedUp: true,
                fired: index === broadIndex,
              })),
            },
            meta: { source: "python-sidecar" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    },
  });
  assert.notEqual(seenRequest, null);
  assert.ok(isParsedStateSpaceRequest(seenRequest));
  assert.deepEqual(seenRequest.params.stateSpace, algo.stateSpace);
  assert.equal(fires.length, 1);
  const [firstFire] = fires;
  assert.ok(firstFire);
  assert.equal(firstFire.gameId, game.gameId);
  assert.ok(firstFire.sourceCount > 1);
});

void test("state-space bakeoff maps fired buckets when the sidecar drops zero-millisecond fractions", async () => {
  // Regression: the request emits bucketStart via Date.toISOString() ("...:00.000Z"),
  // but the Python sidecar parses bucketStart into a datetime and re-serializes it
  // without the zero millisecond fraction ("...:00Z"). The fired-bucket join must
  // survive that ISO-8601 fractional-second difference; previously every fire was
  // silently dropped, zeroing the runtime state-space bakeoff row.
  const game = makeGameWithTapeBurst();
  const defaults = {
    ...BASELINE_DEFAULTS,
    bucketSeconds: 30,
  };
  const [algo] = buildRuntimeStateSpaceAlgorithms(defaults);
  assert.ok(algo);
  const games = new Map([[game.gameId, game]]);
  const request = buildStateSpaceRequestForGame(game, algo, games);
  const broadIndex = request.observations.findIndex(
    (observation) => (observation.activeMarketCount ?? 0) > 1,
  );
  assert.ok(broadIndex >= 0);
  // Confirm the precondition that exposes the bug: the request bucketStart carries
  // a millisecond fraction that the sidecar echo below intentionally strips.
  const firedObservation = request.observations[broadIndex];
  assert.ok(firedObservation);
  assert.ok(firedObservation.bucketStart.includes(".000Z"));
  const fires = await detectWithPythonStateSpace(game, algo, games, {
    baseUrl: "http://sidecar.test",
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              generatedAt: "2026-05-28T00:00:00Z",
              gameId: game.gameId,
              observations: request.observations.map((observation, index) => {
                // Re-serialize through a Date with truncated microseconds, exactly
                // as the Pydantic datetime round-trip in the sidecar does.
                const sidecarBucketStart = new Date(observation.bucketStart)
                  .toISOString()
                  .replace(".000Z", "Z");
                const sidecarBucketEnd = new Date(observation.bucketEnd)
                  .toISOString()
                  .replace(".000Z", "Z");
                return {
                  bucketStart: sidecarBucketStart,
                  bucketEnd: sidecarBucketEnd,
                  baselineMedian: observation.intensity / 2,
                  baselineMad: 0.5,
                  threshold: observation.intensity * 0.75,
                  standardizedInnovation: index === broadIndex ? 4.2 : 0.2,
                  regimeScore: index === broadIndex ? 1 : 0.05,
                  warmedUp: true,
                  fired: index === broadIndex,
                };
              }),
            },
            meta: { source: "python-sidecar" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
  });
  assert.equal(fires.length, 1);
  const [firstFire] = fires;
  assert.ok(firstFire);
  assert.equal(firstFire.gameId, game.gameId);
});
