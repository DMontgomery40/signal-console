---
name: backtest
description: "Skill for the Backtest area of signal-console. 93 symbols across 11 files."
---

# Backtest

93 symbols | 11 files | Cohesion: 84%

## When to Use

- Working with code in `apps/`
- Understanding how useBacktest, isBoardMadPrebucketField, defaultValuesFor work
- Modifying backtest-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/backtest/BacktestPage.tsx` | readNumber, readString, stableJson, jsonValuesEqual, isBoardLikeDetector (+47) |
| `apps/web/src/features/backtest/BacktestTimelines.tsx` | groupByGame, buildGroups, buildContextSeries, TimelineChart, GameCard (+8) |
| `apps/web/src/features/backtest/PbpAnchoredIncidents.tsx` | PbpAnchoredIncidents, findEventBucket, formatDeltaSeconds, formatBucketEnd, AnchorBlock (+3) |
| `apps/web/src/lib/paramsSchema.ts` | defaultValuesFor, isRecord, readString, readNumber, readStringArray (+2) |
| `apps/web/src/features/backtest/MemoryDial.tsx` | clampLookback, formatBucketDurationForDisplay, MemoryDial, handleSliderChange |
| `apps/web/src/features/backtest/WarmupDial.tsx` | clampHoldoff, WarmupDial, handleSliderChange |
| `apps/web/src/data/queries.ts` | useBacktest, useGame |
| `apps/web/src/features/backtest/boardMadDetectorIds.ts` | isBoardMadPrebucketField |
| `apps/web/src/components/PromotionDialog.tsx` | PromotionDialog |
| `apps/web/src/features/backtest/SensitivityDial.tsx` | SensitivityDial |

## Entry Points

Start here when exploring this area:

- **`useBacktest`** (Function) — `apps/web/src/data/queries.ts:674`
- **`isBoardMadPrebucketField`** (Function) — `apps/web/src/features/backtest/boardMadDetectorIds.ts:34`
- **`defaultValuesFor`** (Function) — `apps/web/src/lib/paramsSchema.ts:114`
- **`PromotionDialog`** (Function) — `apps/web/src/components/PromotionDialog.tsx:33`
- **`BacktestPage`** (Function) — `apps/web/src/features/backtest/BacktestPage.tsx:786`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useBacktest` | Function | `apps/web/src/data/queries.ts` | 674 |
| `isBoardMadPrebucketField` | Function | `apps/web/src/features/backtest/boardMadDetectorIds.ts` | 34 |
| `defaultValuesFor` | Function | `apps/web/src/lib/paramsSchema.ts` | 114 |
| `PromotionDialog` | Function | `apps/web/src/components/PromotionDialog.tsx` | 33 |
| `BacktestPage` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 786 |
| `updateParam` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 839 |
| `updateBoardParam` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 845 |
| `updateBoardParams` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 858 |
| `updateBoardStateSpaceText` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 871 |
| `updateBoardStateSpaceConfig` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 883 |
| `updateBoardStateSpaceField` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 889 |
| `applyBoardProfile` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 908 |
| `handleDetectorChange` | Function | `apps/web/src/features/backtest/BacktestPage.tsx` | 914 |
| `SensitivityDial` | Function | `apps/web/src/features/backtest/SensitivityDial.tsx` | 44 |
| `formatBucketDurationForDisplay` | Function | `apps/web/src/features/backtest/MemoryDial.tsx` | 54 |
| `MemoryDial` | Function | `apps/web/src/features/backtest/MemoryDial.tsx` | 70 |
| `handleSliderChange` | Function | `apps/web/src/features/backtest/MemoryDial.tsx` | 76 |
| `WarmupDial` | Function | `apps/web/src/features/backtest/WarmupDial.tsx` | 65 |
| `handleSliderChange` | Function | `apps/web/src/features/backtest/WarmupDial.tsx` | 71 |
| `isRecord` | Function | `apps/web/src/lib/paramsSchema.ts` | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Data | 5 calls |
| Settings | 4 calls |
| Games | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useBacktest"})` — see callers and callees
2. `gitnexus_query({query: "backtest"})` — find related execution flows
3. Read key files listed above for implementation details
