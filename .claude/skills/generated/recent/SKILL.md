---
name: recent
description: "Skill for the Recent area of signal-console. 6 symbols across 3 files."
---

# Recent

6 symbols | 3 files | Cohesion: 48%

## When to Use

- Working with code in `apps/`
- Understanding how useGames, QueryErrorBanner, RecentPage work
- Modifying recent-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/recent/RecentPage.tsx` | formatScheduledStart, renderStatus, RecentPage |
| `apps/web/src/components/QueryErrorBanner.tsx` | messageOf, QueryErrorBanner |
| `apps/web/src/data/queries.ts` | useGames |

## Entry Points

Start here when exploring this area:

- **`useGames`** (Function) — `apps/web/src/data/queries.ts:244`
- **`QueryErrorBanner`** (Function) — `apps/web/src/components/QueryErrorBanner.tsx:19`
- **`RecentPage`** (Function) — `apps/web/src/features/recent/RecentPage.tsx:81`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useGames` | Function | `apps/web/src/data/queries.ts` | 244 |
| `QueryErrorBanner` | Function | `apps/web/src/components/QueryErrorBanner.tsx` | 19 |
| `RecentPage` | Function | `apps/web/src/features/recent/RecentPage.tsx` | 81 |
| `messageOf` | Function | `apps/web/src/components/QueryErrorBanner.tsx` | 13 |
| `formatScheduledStart` | Function | `apps/web/src/features/recent/RecentPage.tsx` | 20 |
| `renderStatus` | Function | `apps/web/src/features/recent/RecentPage.tsx` | 47 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RecentPage → IsNetworkError` | cross_community | 3 |
| `RecentPage → MessageOf` | intra_community | 3 |
| `DetectorsPage → MessageOf` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 2 calls |
| Games | 2 calls |
| Live | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useGames"})` — see callers and callees
2. `gitnexus_query({query: "recent"})` — find related execution flows
3. Read key files listed above for implementation details
