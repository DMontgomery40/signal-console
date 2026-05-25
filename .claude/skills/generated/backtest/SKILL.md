---
name: backtest
description: "Skill for the Backtest area of signal-console. 86 symbols across 9 files."
---

# Backtest

86 symbols | 9 files | Cohesion: 78%

## When to Use

- Working with code in `apps/`
- Understanding how useBacktest, isBoardMadPrebucketField, defaultValuesFor work
- Modifying backtest-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/backtest/BacktestPage.tsx` | isBoardLikeDetector, inferBoardProfile, todayIso, daysAgoIso, diffDaysExclusive (+35) |
| `apps/web/src/features/backtest/BacktestTimelines.tsx` | groupByGame, buildGroups, buildContextSeries, TimelineChart, GameCard (+8) |
| `apps/web/src/features/backtest/clientRecompute.ts` | isBoardMadPrebucketField, isPlainRecord, boardParamsForDetector, readBoardMadRecomputeParams, hasBoardMadPrebucketDrift (+3) |
| `apps/web/src/features/backtest/PbpAnchoredIncidents.tsx` | PbpAnchoredIncidents, findEventBucket, formatDeltaSeconds, formatBucketEnd, AnchorBlock (+3) |
| `apps/web/src/lib/paramsSchema.ts` | defaultValuesFor, isRecord, readString, readNumber, readStringArray (+2) |
| `apps/web/src/features/backtest/MemoryDial.tsx` | clampLookback, formatBucketDurationForDisplay, MemoryDial, handleSliderChange |
| `apps/web/src/features/backtest/WarmupDial.tsx` | clampHoldoff, WarmupDial, handleSliderChange |
| `apps/web/src/data/queries.ts` | useBacktest, useGame |
| `apps/web/src/features/backtest/SensitivityDial.tsx` | SensitivityDial |

## Entry Points

Start here when exploring this area:

- **`useBacktest`** (Function) — `apps/web/src/data/queries.ts:468`
- **`isBoardMadPrebucketField`** (Function) — `apps/web/src/features/backtest/clientRecompute.ts:101`
- **`defaultValuesFor`** (Function) — `apps/web/src/lib/paramsSchema.ts:114`
- **`BacktestPage`** (Function) — `apps/web/src/features/backtest/BacktestPage.tsx:682`
- **`updateParam`** (Function) — `apps/web/src/features/backtest/BacktestPage.tsx:721`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useBacktest` | Function | `apps/web/src/data/queries.ts` | 468 |
| `isBoardMadPrebucketField` | Function | `apps/web/src/features/backtest/clientRecompute.ts` | 101 |
| `defaultValuesFor` | Function | `apps/web/src/lib/paramsSchema.ts` | 114 |
| `BacktestPage` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 682 |
| `updateParam` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 721 |
| `handleDetectorChange` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 759 |
| `SensitivityDial` | Function | `apps/web/src/features/backtest/SensitivityDial.tsx` | 34 |
| `formatBucketDurationForDisplay` | Function | `apps/web/src/features/backtest/MemoryDial.tsx` | 54 |
| `MemoryDial` | Function | `apps/web/src/features/backtest/MemoryDial.tsx` | 70 |
| `handleSliderChange` | Function | `apps/web/src/features/backtest/MemoryDial.tsx` | 76 |
| `WarmupDial` | Function | `apps/web/src/features/backtest/WarmupDial.tsx` | 65 |
| `handleSliderChange` | Function | `apps/web/src/features/backtest/WarmupDial.tsx` | 71 |
| `isRecord` | Function | `apps/web/src/lib/paramsSchema.ts` | 6 |
| `parseProperty` | Function | `apps/web/src/lib/paramsSchema.ts` | 51 |
| `parseSchema` | Function | `apps/web/src/lib/paramsSchema.ts` | 101 |
| `parsedProps` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 702 |
| `updateBoardParam` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 727 |
| `updateBoardParams` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 740 |
| `applyBoardProfile` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 753 |
| `PbpAnchoredIncidents` | Function | `apps/web/src/features/backtest/PbpAnchoredIncidents.tsx` | 93 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 4 calls |
| Board-mad | 1 calls |
| Games | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useBacktest"})` — see callers and callees
2. `gitnexus_query({query: "backtest"})` — find related execution flows
3. Read key files listed above for implementation details
