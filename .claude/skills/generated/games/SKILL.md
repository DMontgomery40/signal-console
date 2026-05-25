---
name: games
description: "Skill for the Games area of signal-console. 32 symbols across 4 files."
---

# Games

32 symbols | 4 files | Cohesion: 76%

## When to Use

- Working with code in `apps/`
- Understanding how useBoard, GameDetailPage, handleToggle work
- Modifying games-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/games/FanoutPanel.tsx` | tierFor, tierClassName, formatIp, formatSignedIp, formatBucketVolume (+16) |
| `apps/web/src/features/games/GameDetailPage.tsx` | formatScheduledStart, buildContextSeries, GameDetailPage, handleToggle, formatBucket (+3) |
| `apps/web/src/data/queries.ts` | useBoard, useFanout |
| `apps/web/src/features/recent/RecentPage.tsx` | FiresCell |

## Entry Points

Start here when exploring this area:

- **`useBoard`** (Function) — `apps/web/src/data/queries.ts:346`
- **`GameDetailPage`** (Function) — `apps/web/src/features/games/GameDetailPage.tsx:217`
- **`handleToggle`** (Function) — `apps/web/src/features/games/GameDetailPage.tsx:258`
- **`useFanout`** (Function) — `apps/web/src/data/queries.ts:356`
- **`FanoutPanel`** (Function) — `apps/web/src/features/games/FanoutPanel.tsx:557`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useBoard` | Function | `apps/web/src/data/queries.ts` | 346 |
| `GameDetailPage` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 217 |
| `handleToggle` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 258 |
| `useFanout` | Function | `apps/web/src/data/queries.ts` | 356 |
| `FanoutPanel` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 557 |
| `tierFor` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 48 |
| `tierClassName` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 56 |
| `formatIp` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 110 |
| `formatSignedIp` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 115 |
| `formatBucketVolume` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 469 |
| `volumeHeatClass` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 479 |
| `MoversTable` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 486 |
| `formatScheduledStart` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 33 |
| `buildContextSeries` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 55 |
| `FiresCell` | Function | `apps/web/src/features/recent/RecentPage.tsx` | 73 |
| `formatBucket` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 39 |
| `formatNumber` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 45 |
| `ContextTimeline` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 68 |
| `FiredBucketRow` | Function | `apps/web/src/features/games/GameDetailPage.tsx` | 154 |
| `isConcentratedOffPrice` | Function | `apps/web/src/features/games/FanoutPanel.tsx` | 280 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 3 calls |
| Backtest | 1 calls |
| Live | 1 calls |
| Recent | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useBoard"})` — see callers and callees
2. `gitnexus_query({query: "games"})` — find related execution flows
3. Read key files listed above for implementation details
