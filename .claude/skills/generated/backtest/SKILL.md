---
name: backtest
description: "Skill for the Backtest area of signal-console. 69 symbols across 9 files."
---

# Backtest

69 symbols | 9 files | Cohesion: 80%

## When to Use

- Working with code in `apps/`
- Understanding how useBacktest, isBoardMadPrebucketField, defaultValuesFor work
- Modifying backtest-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/backtest/BacktestPage.tsx` | readKMad, readNumber, todayIso, daysAgoIso, diffDaysExclusive (+23) |
| `apps/web/src/features/backtest/BacktestTimelines.tsx` | groupByGame, buildGroups, buildContextSeries, TimelineChart, GameCard (+8) |
| `apps/web/src/features/backtest/PbpAnchoredIncidents.tsx` | findEventBucket, formatDeltaSeconds, formatBucketEnd, PbpAnchoredIncidents, AnchorBlock (+3) |
| `apps/web/src/lib/paramsSchema.ts` | defaultValuesFor, isRecord, readString, readNumber, readStringArray (+2) |
| `apps/web/src/features/backtest/clientRecompute.ts` | isBoardMadPrebucketField, median, medianAbsDev, groupByGame, recomputeBoardMad (+1) |
| `apps/web/src/features/backtest/WarmupDial.tsx` | clampWarmup, WarmupDial, handleSliderChange |
| `apps/web/src/data/queries.ts` | useBacktest, useGame |
| `apps/web/src/features/backtest/CryWolfDial.tsx` | CryWolfDial |
| `apps/web/src/features/backtest/MemoryDial.tsx` | MemoryDial |

## Entry Points

Start here when exploring this area:

- **`useBacktest`** (Function) — `apps/web/src/data/queries.ts:397`
- **`isBoardMadPrebucketField`** (Function) — `apps/web/src/features/backtest/clientRecompute.ts:54`
- **`defaultValuesFor`** (Function) — `apps/web/src/lib/paramsSchema.ts:114`
- **`BacktestPage`** (Function) — `apps/web/src/features/backtest/BacktestPage.tsx:353`
- **`updateParam`** (Function) — `apps/web/src/features/backtest/BacktestPage.tsx:392`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useBacktest` | Function | `apps/web/src/data/queries.ts` | 397 |
| `isBoardMadPrebucketField` | Function | `apps/web/src/features/backtest/clientRecompute.ts` | 54 |
| `defaultValuesFor` | Function | `apps/web/src/lib/paramsSchema.ts` | 114 |
| `BacktestPage` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 353 |
| `updateParam` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 392 |
| `handleDetectorChange` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 396 |
| `CryWolfDial` | Function | `apps/web/src/features/backtest/CryWolfDial.tsx` | 35 |
| `MemoryDial` | Function | `apps/web/src/features/backtest/MemoryDial.tsx` | 37 |
| `WarmupDial` | Function | `apps/web/src/features/backtest/WarmupDial.tsx` | 54 |
| `handleSliderChange` | Function | `apps/web/src/features/backtest/WarmupDial.tsx` | 57 |
| `isRecord` | Function | `apps/web/src/lib/paramsSchema.ts` | 6 |
| `parseProperty` | Function | `apps/web/src/lib/paramsSchema.ts` | 51 |
| `parseSchema` | Function | `apps/web/src/lib/paramsSchema.ts` | 101 |
| `parsedProps` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 373 |
| `PbpAnchoredIncidents` | Function | `apps/web/src/features/backtest/PbpAnchoredIncidents.tsx` | 93 |
| `recomputeBoardMad` | Function | `apps/web/src/features/backtest/clientRecompute.ts` | 108 |
| `applyClientRecompute` | Function | `apps/web/src/features/backtest/clientRecompute.ts` | 159 |
| `BacktestTimelines` | Function | `apps/web/src/features/backtest/BacktestTimelines.tsx` | 460 |
| `useGame` | Function | `apps/web/src/data/queries.ts` | 256 |
| `buildRequest` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 431 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `FiredBucketRow → IsRecord` | cross_community | 6 |
| `BacktestTimelines → FormatDelta` | cross_community | 6 |
| `BacktestTimelines → TierColor` | cross_community | 6 |
| `GameCard → TierFor` | cross_community | 5 |
| `GameCard → FormatIp` | cross_community | 5 |
| `GameCard → FormatSignedIp` | cross_community | 5 |
| `BacktestTimelines → UseFanout` | cross_community | 5 |
| `ResultsPanel → FindEventBucket` | intra_community | 5 |
| `ResultsPanel → FormatBucketEnd` | intra_community | 5 |
| `ResultsPanel → FormatDeltaSeconds` | intra_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 3 calls |
| Games | 1 calls |
| Recent | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useBacktest"})` — see callers and callees
2. `gitnexus_query({query: "backtest"})` — find related execution flows
3. Read key files listed above for implementation details
