---
name: board-anomaly
description: "Skill for the Board-anomaly area of signal-console. 225 symbols across 31 files."
---

# Board-anomaly

225 symbols | 31 files | Cohesion: 76%

## When to Use

- Working with code in `packages/`
- Understanding how getBoardAlertEventContext, mismatches, buildBoardVolatilityBaselineLookupInput work
- Modifying board-anomaly-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/shared/src/live-repository.ts` | parseJson, stringifyJson, computeCoverageSummary, freshnessBandFromMs, rowToGame (+70) |
| `packages/shared/src/board-anomaly/game-state-volatility.ts` | current, orderedRows, computePercentileRank, isBoardVwInputRow, currentObservationGameState (+15) |
| `packages/shared/src/board-anomaly/alert-metrics.ts` | averageContribution, averageMicrostructure, unmappedRatio, firstPopAtFromScored, h0DriversFromScored (+9) |
| `packages/shared/src/db-core.ts` | currentTimestamp, getDatabasePath, executeDatabaseOperation, getDatabase, getDatabaseSchemaVersion (+8) |
| `packages/shared/src/board-anomaly/detector.ts` | scored, clusterToAlert, measureBoardGameStateVolatility, inWindow, shockSet (+5) |
| `packages/shared/src/board-anomaly/board-volatility-model.ts` | buildBoardVolatilityBaselineLookupInput, interpolatePercentile, runBoardStressKalmanFilter, shockRows, sortFamilies (+3) |
| `packages/shared/src/board-volatility-baselines.ts` | quantile, resolveFallbackBoardVolatilityBaseline, getLatestBoardVolatilityBaselineVersion, resolveBoardVolatilityBaseline, rebuildBoardVolatilityBaselines (+2) |
| `packages/shared/src/board-anomaly-event-context.ts` | loadGameLabel, getBoardAlertEventContext, comparePredictionMarketRows, playByPlay, parseHistoricalParticipantAlertId (+1) |
| `packages/shared/src/board-anomaly-incidents.ts` | listFinishedGameReplayWindows, buildIncidentReason, formatDuration, findOppositeInstrumentId, latestImpliedProbability (+1) |
| `packages/shared/src/board-anomaly-observation-context.ts` | statFamilyHintFromTokens, loadGameContext, gameStateRows, gameStateAt, buildObservationLabels (+1) |

## Entry Points

Start here when exploring this area:

- **`getBoardAlertEventContext`** (Function) — `packages/shared/src/board-anomaly-event-context.ts:302`
- **`mismatches`** (Function) — `packages/shared/src/board-anomaly-historical-listings.ts:112`
- **`buildBoardVolatilityBaselineLookupInput`** (Function) — `packages/shared/src/board-anomaly/board-volatility-model.ts:156`
- **`resolveFallbackBoardVolatilityBaseline`** (Function) — `packages/shared/src/board-volatility-baselines.ts:144`
- **`getLatestBoardVolatilityBaselineVersion`** (Function) — `packages/shared/src/board-volatility-baselines.ts:217`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `DatabaseFailureError` | Class | `packages/shared/src/errors.ts` | 126 |
| `InternalAppError` | Class | `packages/shared/src/errors.ts` | 148 |
| `getBoardAlertEventContext` | Function | `packages/shared/src/board-anomaly-event-context.ts` | 302 |
| `mismatches` | Function | `packages/shared/src/board-anomaly-historical-listings.ts` | 112 |
| `buildBoardVolatilityBaselineLookupInput` | Function | `packages/shared/src/board-anomaly/board-volatility-model.ts` | 156 |
| `resolveFallbackBoardVolatilityBaseline` | Function | `packages/shared/src/board-volatility-baselines.ts` | 144 |
| `getLatestBoardVolatilityBaselineVersion` | Function | `packages/shared/src/board-volatility-baselines.ts` | 217 |
| `resolveBoardVolatilityBaseline` | Function | `packages/shared/src/board-volatility-baselines.ts` | 232 |
| `rebuildBoardVolatilityBaselines` | Function | `packages/shared/src/board-volatility-baselines.ts` | 279 |
| `currentTimestamp` | Function | `packages/shared/src/db-core.ts` | 17 |
| `getDatabasePath` | Function | `packages/shared/src/db-core.ts` | 21 |
| `executeDatabaseOperation` | Function | `packages/shared/src/db-core.ts` | 25 |
| `getDatabase` | Function | `packages/shared/src/db-core.ts` | 62 |
| `getDatabaseSchemaVersion` | Function | `packages/shared/src/db-core.ts` | 91 |
| `checkDatabaseHealth` | Function | `packages/shared/src/db-core.ts` | 139 |
| `closeDatabase` | Function | `packages/shared/src/db-core.ts` | 216 |
| `backupDatabase` | Function | `packages/shared/src/db-core.ts` | 227 |
| `removeDatabaseArtifacts` | Function | `packages/shared/src/db-core.ts` | 232 |
| `resetDatabase` | Function | `packages/shared/src/db-core.ts` | 239 |
| `toAppError` | Function | `packages/shared/src/errors.ts` | 173 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RebuildBoardVolatilityBaselines → InternalAppError` | intra_community | 6 |
| `RebuildBoardVolatilityBaselines → NowIso` | cross_community | 6 |
| `ListPlayerPropDisagreementAlerts → InternalAppError` | intra_community | 6 |
| `ListPlayerPropDisagreementAlerts → NowIso` | cross_community | 6 |
| `ListFinishedGameIncidents → InternalAppError` | cross_community | 6 |
| `ListFinishedGameIncidents → NowIso` | cross_community | 6 |
| `ListUnmappedMarkets → InternalAppError` | intra_community | 6 |
| `UpsertMarketAnomalyScoreConfig → InternalAppError` | intra_community | 6 |
| `RecordGameStateObservation → InternalAppError` | intra_community | 6 |
| `UpsertGame → InternalAppError` | intra_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_176 | 3 calls |
| Cluster_168 | 3 calls |
| Cluster_149 | 3 calls |
| Cluster_151 | 3 calls |
| Cluster_190 | 2 calls |
| Cluster_179 | 2 calls |
| Cluster_150 | 2 calls |
| Cluster_152 | 2 calls |

## How to Explore

1. `gitnexus_context({name: "getBoardAlertEventContext"})` — see callers and callees
2. `gitnexus_query({query: "board-anomaly"})` — find related execution flows
3. Read key files listed above for implementation details
