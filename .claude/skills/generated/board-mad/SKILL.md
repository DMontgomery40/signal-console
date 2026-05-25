---
name: board-mad
description: "Skill for the Board-mad area of signal-console. 35 symbols across 5 files."
---

# Board-mad

35 symbols | 5 files | Cohesion: 92%

## When to Use

- Working with code in `packages/`
- Understanding how median, medianAbsDev, resolveBoardMadBaseline work
- Modifying board-mad-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/detectors/src/board-mad/baseline.ts` | median, medianAbsDev, resolvePositiveInteger, resolveNonNegativeNumber, clamp01 (+9) |
| `packages/detectors/src/board-mad/prebucket.ts` | discoverGameIds, uniqueGameIds, prebucket, sanitise, sortByMarketAndTime (+5) |
| `packages/detectors/src/board-mad/sweep.ts` | baselinesForGame, firesFromBaselines, detectorBucketsFromBaselines, computeAllBaselines, runSweep (+1) |
| `packages/detectors/src/board-mad/index.ts` | ticksForGames, uniqueGameIds, historicalPriorMap, run |
| `apps/api/src/services/board-mad-context.ts` | buildSidePrior |

## Entry Points

Start here when exploring this area:

- **`median`** (Function) — `packages/detectors/src/board-mad/baseline.ts:56`
- **`medianAbsDev`** (Function) — `packages/detectors/src/board-mad/baseline.ts:66`
- **`resolveBoardMadBaseline`** (Function) — `packages/detectors/src/board-mad/baseline.ts:209`
- **`prebucket`** (Function) — `packages/detectors/src/board-mad/prebucket.ts:151`
- **`perGame`** (Function) — `packages/detectors/src/board-mad/prebucket.ts:159`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `median` | Function | `packages/detectors/src/board-mad/baseline.ts` | 56 |
| `medianAbsDev` | Function | `packages/detectors/src/board-mad/baseline.ts` | 66 |
| `resolveBoardMadBaseline` | Function | `packages/detectors/src/board-mad/baseline.ts` | 209 |
| `prebucket` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 151 |
| `perGame` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 159 |
| `runSweep` | Function | `packages/detectors/src/board-mad/sweep.ts` | 117 |
| `runForK` | Function | `packages/detectors/src/board-mad/sweep.ts` | 131 |
| `run` | Method | `packages/detectors/src/board-mad/index.ts` | 65 |
| `buildSidePrior` | Function | `apps/api/src/services/board-mad-context.ts` | 151 |
| `resolvePositiveInteger` | Function | `packages/detectors/src/board-mad/baseline.ts` | 72 |
| `resolveNonNegativeNumber` | Function | `packages/detectors/src/board-mad/baseline.ts` | 77 |
| `clamp01` | Function | `packages/detectors/src/board-mad/baseline.ts` | 82 |
| `isEntrySeries` | Function | `packages/detectors/src/board-mad/baseline.ts` | 84 |
| `asEntries` | Function | `packages/detectors/src/board-mad/baseline.ts` | 91 |
| `isFiniteNumber` | Function | `packages/detectors/src/board-mad/baseline.ts` | 102 |
| `openingRampWindowSize` | Function | `packages/detectors/src/board-mad/baseline.ts` | 105 |
| `priorValuesForBucket` | Function | `packages/detectors/src/board-mad/baseline.ts` | 119 |
| `weightedAverage` | Function | `packages/detectors/src/board-mad/baseline.ts` | 144 |
| `liveValuesForHistoricalBucket` | Function | `packages/detectors/src/board-mad/baseline.ts` | 150 |
| `historicalShareForBucket` | Function | `packages/detectors/src/board-mad/baseline.ts` | 194 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunSweep → IsEntrySeries` | cross_community | 6 |
| `RunSweep → ResolvePositiveInteger` | cross_community | 5 |
| `RunSweep → Clamp01` | cross_community | 5 |
| `RunSweep → ResolveNonNegativeNumber` | cross_community | 5 |
| `Run → UniqueGameIds` | intra_community | 3 |
| `Run → DiscoverGameIds` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "median"})` — see callers and callees
2. `gitnexus_query({query: "board-mad"})` — find related execution flows
3. Read key files listed above for implementation details
