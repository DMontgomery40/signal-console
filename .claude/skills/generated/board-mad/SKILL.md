---
name: board-mad
description: "Skill for the Board-mad area of signal-console. 19 symbols across 3 files."
---

# Board-mad

19 symbols | 3 files | Cohesion: 95%

## When to Use

- Working with code in `packages/`
- Understanding how runSweep, runForK, perGame work
- Modifying board-mad-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/detectors/src/board-mad/prebucket.ts` | sanitise, sortByMarketAndTime, contributionFromPair, contributionsFromSortedTicks, sumByBucket (+4) |
| `packages/detectors/src/board-mad/sweep.ts` | median, medianAbsDev, baselinesForGame, firesFromBaselines, detectorBucketsFromBaselines (+3) |
| `packages/detectors/src/board-mad/index.ts` | ticksForGames, run |

## Entry Points

Start here when exploring this area:

- **`runSweep`** (Function) — `packages/detectors/src/board-mad/sweep.ts:148`
- **`runForK`** (Function) — `packages/detectors/src/board-mad/sweep.ts:162`
- **`perGame`** (Function) — `packages/detectors/src/board-mad/prebucket.ts:136`
- **`prebucket`** (Function) — `packages/detectors/src/board-mad/prebucket.ts:128`
- **`run`** (Method) — `packages/detectors/src/board-mad/index.ts:41`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `runSweep` | Function | `packages/detectors/src/board-mad/sweep.ts` | 148 |
| `runForK` | Function | `packages/detectors/src/board-mad/sweep.ts` | 162 |
| `perGame` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 136 |
| `prebucket` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 128 |
| `run` | Method | `packages/detectors/src/board-mad/index.ts` | 41 |
| `median` | Function | `packages/detectors/src/board-mad/sweep.ts` | 36 |
| `medianAbsDev` | Function | `packages/detectors/src/board-mad/sweep.ts` | 46 |
| `baselinesForGame` | Function | `packages/detectors/src/board-mad/sweep.ts` | 52 |
| `firesFromBaselines` | Function | `packages/detectors/src/board-mad/sweep.ts` | 93 |
| `detectorBucketsFromBaselines` | Function | `packages/detectors/src/board-mad/sweep.ts` | 110 |
| `computeAllBaselines` | Function | `packages/detectors/src/board-mad/sweep.ts` | 139 |
| `sanitise` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 54 |
| `sortByMarketAndTime` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 59 |
| `contributionFromPair` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 67 |
| `contributionsFromSortedTicks` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 88 |
| `sumByBucket` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 101 |
| `buildGameSeries` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 113 |
| `ticksForGames` | Function | `packages/detectors/src/board-mad/index.ts` | 22 |
| `discoverGameIds` | Function | `packages/detectors/src/board-mad/prebucket.ts` | 125 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Run → Median` | cross_community | 6 |
| `RunSweep → Median` | intra_community | 5 |
| `PerGame → ContributionFromPair` | intra_community | 4 |
| `Run → DiscoverGameIds` | intra_community | 3 |
| `Run → FiresFromBaselines` | cross_community | 3 |
| `Run → DetectorBucketsFromBaselines` | cross_community | 3 |
| `PerGame → SortByMarketAndTime` | intra_community | 3 |
| `PerGame → Sanitise` | intra_community | 3 |
| `PerGame → SumByBucket` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "runSweep"})` — see callers and callees
2. `gitnexus_query({query: "board-mad"})` — find related execution flows
3. Read key files listed above for implementation details
