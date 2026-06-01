---
name: board-mad
description: "Skill for the Board-mad area of signal-console. 51 symbols across 6 files."
---

# Board-mad

51 symbols | 6 files | Cohesion: 85%

## When to Use

- Working with code in `packages/`
- Understanding how median, medianAbsDev, resolveBoardMadBaseline work
- Modifying board-mad-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/detectors/src/board-mad/baseline.ts` | median, medianAbsDev, resolvePositiveInteger, resolveNonNegativeNumber, clamp01 (+18) |
| `packages/detectors/src/board-mad/prebucket.ts` | discoverGameIds, uniqueGameIds, prebucket, sanitise, sortByMarketAndTime (+5) |
| `packages/detectors/src/board-mad/sweep.ts` | baselinesForGame, firesFromBaselines, detectorBucketsFromBaselines, computeAllBaselines, runSweep (+1) |
| `packages/detectors/src/board-mad/index.ts` | ticksForGames, uniqueGameIds, historicalPriorMap, timingContextMap, run |
| `packages/detectors/src/board-mad/state-space-runtime.ts` | trimTrailingSlash, resolveSidecarBaseUrl, isRecord, parseResponse, fetchBoardVolatilityStateSpace |
| `packages/shared/src/board-anomaly/game-state-volatility.ts` | buildStateSpaceRequest, evaluateBoardVwBuckets |

## Entry Points

Start here when exploring this area:

- **`median`** (Function) — `packages/detectors/src/board-mad/baseline.ts:72`
- **`medianAbsDev`** (Function) — `packages/detectors/src/board-mad/baseline.ts:82`
- **`resolveBoardMadBaseline`** (Function) — `packages/detectors/src/board-mad/baseline.ts:373`
- **`prebucket`** (Function) — `packages/detectors/src/board-mad/prebucket.ts:156`
- **`perGame`** (Function) — `packages/detectors/src/board-mad/prebucket.ts:164`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `median` | Function | `packages/detectors/src/board-mad/baseline.ts` | 72 |
| `medianAbsDev` | Function | `packages/detectors/src/board-mad/baseline.ts` | 82 |
| `resolveBoardMadBaseline` | Function | `packages/detectors/src/board-mad/baseline.ts` | 373 |
| `prebucket` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 156 |
| `perGame` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 164 |
| `fetchBoardVolatilityStateSpace` | Function | `packages/detectors/src/board-mad/state-space-runtime.ts` | 135 |
| `runSweep` | Function | `packages/detectors/src/board-mad/sweep.ts` | 124 |
| `runForK` | Function | `packages/detectors/src/board-mad/sweep.ts` | 138 |
| `run` | Method | `packages/detectors/src/board-mad/index.ts` | 98 |
| `resolvePositiveInteger` | Function | `packages/detectors/src/board-mad/baseline.ts` | 88 |
| `resolveNonNegativeNumber` | Function | `packages/detectors/src/board-mad/baseline.ts` | 93 |
| `clamp01` | Function | `packages/detectors/src/board-mad/baseline.ts` | 98 |
| `isEntrySeries` | Function | `packages/detectors/src/board-mad/baseline.ts` | 100 |
| `asEntries` | Function | `packages/detectors/src/board-mad/baseline.ts` | 107 |
| `weightedAverage` | Function | `packages/detectors/src/board-mad/baseline.ts` | 261 |
| `liveEstimatorForHistoricalBucket` | Function | `packages/detectors/src/board-mad/baseline.ts` | 284 |
| `historicalShareForBucket` | Function | `packages/detectors/src/board-mad/baseline.ts` | 355 |
| `ticksForGames` | Function | `packages/detectors/src/board-mad/index.ts` | 31 |
| `uniqueGameIds` | Function | `packages/detectors/src/board-mad/index.ts` | 36 |
| `historicalPriorMap` | Function | `packages/detectors/src/board-mad/index.ts` | 39 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Run → UniqueGameIds` | intra_community | 3 |
| `Run → DiscoverGameIds` | intra_community | 3 |
| `ResolveBoardMadBaseline → IsEntrySeries` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "median"})` — see callers and callees
2. `gitnexus_query({query: "board-mad"})` — find related execution flows
3. Read key files listed above for implementation details
