---
name: live
description: "Skill for the Live area of signal-console. 8 symbols across 4 files."
---

# Live

8 symbols | 4 files | Cohesion: 67%

## When to Use

- Working with code in `apps/`
- Understanding how useLive, navigateTo, navigate work
- Modifying live-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/live/LivePage.tsx` | formatClock, buildChartData, IntensityTimeline, InvalidGameFallback, LivePage |
| `apps/web/src/data/queries.ts` | useLive |
| `apps/web/src/router.ts` | navigateTo |
| `apps/web/src/App.tsx` | navigate |

## Entry Points

Start here when exploring this area:

- **`useLive`** (Function) — `apps/web/src/data/queries.ts:271`
- **`navigateTo`** (Function) — `apps/web/src/router.ts:12`
- **`navigate`** (Function) — `apps/web/src/App.tsx:92`
- **`LivePage`** (Function) — `apps/web/src/features/live/LivePage.tsx:151`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useLive` | Function | `apps/web/src/data/queries.ts` | 271 |
| `navigateTo` | Function | `apps/web/src/router.ts` | 12 |
| `navigate` | Function | `apps/web/src/App.tsx` | 92 |
| `LivePage` | Function | `apps/web/src/features/live/LivePage.tsx` | 151 |
| `formatClock` | Function | `apps/web/src/features/live/LivePage.tsx` | 45 |
| `buildChartData` | Function | `apps/web/src/features/live/LivePage.tsx` | 61 |
| `IntensityTimeline` | Function | `apps/web/src/features/live/LivePage.tsx` | 71 |
| `InvalidGameFallback` | Function | `apps/web/src/features/live/LivePage.tsx` | 130 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LivePage → NavigateTo` | intra_community | 3 |
| `App → NavigateTo` | cross_community | 3 |
| `RouteContent → NavigateTo` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 2 calls |
| Games | 1 calls |
| Recent | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useLive"})` — see callers and callees
2. `gitnexus_query({query: "live"})` — find related execution flows
3. Read key files listed above for implementation details
