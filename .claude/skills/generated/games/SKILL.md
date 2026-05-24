---
name: games
description: "Skill for the Games area of signal-console. 26 symbols across 4 files."
---

# Games

26 symbols | 4 files | Cohesion: 73%

## When to Use

- Working with code in `apps/`
- Understanding how useBoard, GameDetailPage, handleToggle work
- Modifying games-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/games/FanoutPanel.tsx` | FanoutPanel, tierFor, tierClassName, formatIp, formatSignedIp (+8) |
| `apps/web/src/features/games/GameDetailPage.tsx` | formatScheduledStart, buildContextSeries, GameDetailPage, handleToggle, formatBucket (+3) |
| `apps/web/src/features/recent/RecentPage.tsx` | isRecord, participantLabel, FiresCell |
| `apps/web/src/data/queries.ts` | useBoard, useFanout |

## Entry Points

Start here when exploring this area:

- **`useBoard`** (Function) — `apps/web/src/data/queries.ts:281`
- **`GameDetailPage`** (Function) — `apps/web/src/features/games/GameDetailPage.tsx:217`
- **`handleToggle`** (Function) — `apps/web/src/features/games/GameDetailPage.tsx:258`
- **`participantLabel`** (Function) — `apps/web/src/features/recent/RecentPage.tsx:33`
- **`useFanout`** (Function) — `apps/web/src/data/queries.ts:291`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useBoard` | Function | `apps/web/src/data/queries.ts` | 281 |
| `GameDetailPage` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 217 |
| `handleToggle` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 258 |
| `participantLabel` | Function | `apps/web/src/features/recent/RecentPage.tsx` | 33 |
| `useFanout` | Function | `apps/web/src/data/queries.ts` | 291 |
| `FanoutPanel` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 234 |
| `formatScheduledStart` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 33 |
| `buildContextSeries` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 55 |
| `isRecord` | Function | `apps/web/src/features/recent/RecentPage.tsx` | 26 |
| `FiresCell` | Function | `apps/web/src/features/recent/RecentPage.tsx` | 54 |
| `formatBucket` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 39 |
| `formatNumber` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 45 |
| `ContextTimeline` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 68 |
| `FiredBucketRow` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 154 |
| `tierFor` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 43 |
| `tierClassName` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 62 |
| `formatIp` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 78 |
| `formatSignedIp` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 83 |
| `points` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 117 |
| `MoversTable` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 182 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `FiredBucketRow → IsRecord` | cross_community | 6 |
| `BacktestTimelines → FormatDelta` | cross_community | 6 |
| `BacktestTimelines → TierColor` | cross_community | 6 |
| `FiredBucketRow → IsRecord` | cross_community | 6 |
| `GameCard → TierFor` | cross_community | 5 |
| `GameCard → FormatIp` | cross_community | 5 |
| `GameCard → FormatSignedIp` | cross_community | 5 |
| `BacktestTimelines → UseFanout` | cross_community | 5 |
| `FiredBucketRow → TierClassName` | cross_community | 4 |
| `FiredBucketRow → FormatDelta` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 2 calls |
| Backtest | 1 calls |
| Live | 1 calls |
| Recent | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useBoard"})` — see callers and callees
2. `gitnexus_query({query: "games"})` — find related execution flows
3. Read key files listed above for implementation details
