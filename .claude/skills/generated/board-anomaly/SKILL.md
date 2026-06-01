---
name: board-anomaly
description: "Skill for the Board-anomaly area of signal-console. 232 symbols across 31 files."
---

# Board-anomaly

232 symbols | 31 files | Cohesion: 78%

## When to Use

- Working with code in `packages/`
- Understanding how getBoardAlertEventContext, detectBoardAnomaliesForGame, measureGameStateVolatilityForGame work
- Modifying board-anomaly-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/shared/src/live-repository.ts` | parseJson, stringifyJson, computeCoverageSummary, freshnessBandFromMs, rowToGame (+76) |
| `packages/shared/src/board-anomaly/game-state-volatility.ts` | isBoardVwInputRow, currentObservationGameState, resolveBoardVwWeight, buildBoardVwBuckets, countActiveFireStreak (+13) |
| `packages/shared/src/db-core.ts` | currentTimestamp, getDatabasePath, executeDatabaseOperation, executeDatabaseOperationAsync, getDatabase (+9) |
| `packages/shared/src/board-anomaly/alert-metrics.ts` | averageContribution, averageMicrostructure, unmappedRatio, firstPopAtFromScored, h0DriversFromScored (+9) |
| `packages/shared/src/signal-quality.ts` | bucketStartIso, buildDeltaSeriesFromBucketRows, clampProbability, listClosedGameSummaries, getInstrumentDeltaSeries (+6) |
| `packages/shared/src/board-anomaly/detector.ts` | scored, clusterToAlert, measureBoardGameStateVolatility, inWindow, shockSet (+5) |
| `packages/shared/src/board-anomaly/board-volatility-model.ts` | buildBoardVolatilityBaselineLookupInput, interpolatePercentile, shockRows, sortFamilies, strongestRowsByFamily (+2) |
| `packages/shared/src/board-volatility-baselines.ts` | quantile, resolveFallbackBoardVolatilityBaseline, getLatestBoardVolatilityBaselineVersion, resolveBoardVolatilityBaseline, rebuildBoardVolatilityBaselines (+2) |
| `packages/shared/src/board-anomaly-event-context.ts` | loadGameLabel, getBoardAlertEventContext, parseHistoricalParticipantAlertId, resolveHistoricalParticipantIncident, comparePredictionMarketRows (+1) |
| `packages/shared/src/board-anomaly-incidents.ts` | buildIncidentReason, formatDuration, findOppositeInstrumentId, latestImpliedProbability, buildVigAdjustedComparison (+1) |

## Entry Points

Start here when exploring this area:

- **`getBoardAlertEventContext`** (Function) — `packages/shared/src/board-anomaly-event-context.ts:302`
- **`detectBoardAnomaliesForGame`** (Function) — `packages/shared/src/board-anomaly-game-runtime.ts:27`
- **`measureGameStateVolatilityForGame`** (Function) — `packages/shared/src/board-anomaly-game-runtime.ts:52`
- **`replayBoardAnomaliesForGame`** (Function) — `packages/shared/src/board-anomaly-game-runtime.ts:86`
- **`listFinishedGameIncidents`** (Function) — `packages/shared/src/board-anomaly-historical-listings.ts:42`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `DatabaseFailureError` | Class | `packages/shared/src/errors.ts` | 126 |
| `getBoardAlertEventContext` | Function | `packages/shared/src/board-anomaly-event-context.ts` | 302 |
| `detectBoardAnomaliesForGame` | Function | `packages/shared/src/board-anomaly-game-runtime.ts` | 27 |
| `measureGameStateVolatilityForGame` | Function | `packages/shared/src/board-anomaly-game-runtime.ts` | 52 |
| `replayBoardAnomaliesForGame` | Function | `packages/shared/src/board-anomaly-game-runtime.ts` | 86 |
| `listFinishedGameIncidents` | Function | `packages/shared/src/board-anomaly-historical-listings.ts` | 42 |
| `mismatches` | Function | `packages/shared/src/board-anomaly-historical-listings.ts` | 112 |
| `listBoardAnomaliesAcrossGames` | Function | `packages/shared/src/board-anomaly-live-listings.ts` | 23 |
| `listGameStateVolatilityAcrossGames` | Function | `packages/shared/src/board-anomaly-live-listings.ts` | 87 |
| `loadGameContext` | Function | `packages/shared/src/board-anomaly-observation-context.ts` | 56 |
| `materializeBoardObservations` | Function | `packages/shared/src/board-anomaly-observations.ts` | 30 |
| `incrementFiltered` | Function | `packages/shared/src/board-anomaly-observations.ts` | 159 |
| `buildBoardVolatilityBaselineLookupInput` | Function | `packages/shared/src/board-anomaly/board-volatility-model.ts` | 156 |
| `resolveFallbackBoardVolatilityBaseline` | Function | `packages/shared/src/board-volatility-baselines.ts` | 144 |
| `getLatestBoardVolatilityBaselineVersion` | Function | `packages/shared/src/board-volatility-baselines.ts` | 217 |
| `resolveBoardVolatilityBaseline` | Function | `packages/shared/src/board-volatility-baselines.ts` | 232 |
| `rebuildBoardVolatilityBaselines` | Function | `packages/shared/src/board-volatility-baselines.ts` | 279 |
| `currentTimestamp` | Function | `packages/shared/src/db-core.ts` | 17 |
| `getDatabasePath` | Function | `packages/shared/src/db-core.ts` | 21 |
| `executeDatabaseOperation` | Function | `packages/shared/src/db-core.ts` | 25 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RebuildBoardVolatilityBaselines → InternalAppError` | cross_community | 6 |
| `RebuildBoardVolatilityBaselines → NowIso` | cross_community | 6 |
| `ListPlayerPropDisagreementAlerts → InternalAppError` | cross_community | 6 |
| `ListPlayerPropDisagreementAlerts → NowIso` | cross_community | 6 |
| `ListFinishedGameIncidents → InternalAppError` | cross_community | 6 |
| `ListFinishedGameIncidents → NowIso` | cross_community | 6 |
| `ListUnmappedMarkets → InternalAppError` | cross_community | 6 |
| `UpsertMarketAnomalyScoreConfig → InternalAppError` | cross_community | 6 |
| `RecordGameStateObservation → InternalAppError` | cross_community | 6 |
| `UpsertGame → InternalAppError` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_221 | 5 calls |
| Cluster_208 | 4 calls |
| Cluster_200 | 3 calls |
| Cluster_183 | 3 calls |
| Cluster_211 | 2 calls |
| Cluster_182 | 2 calls |
| Cluster_188 | 2 calls |
| Cluster_184 | 2 calls |

## How to Explore

1. `gitnexus_context({name: "getBoardAlertEventContext"})` — see callers and callees
2. `gitnexus_query({query: "board-anomaly"})` — find related execution flows
3. Read key files listed above for implementation details
