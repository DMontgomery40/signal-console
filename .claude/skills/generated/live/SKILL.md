---
name: live
description: "Skill for the Live area of signal-console. 14 symbols across 3 files."
---

# Live

14 symbols | 3 files | Cohesion: 68%

## When to Use

- Working with code in `apps/`
- Understanding how useLive, useEnsembleOr, navigateTo work
- Modifying live-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/live/LivePage.tsx` | formatClock, buildChartData, thresholdFor, InvalidGameFallback, LivePage (+5) |
| `apps/web/src/data/queries.ts` | liveQuery, useLive, useEnsembleOr |
| `apps/web/src/router.ts` | navigateTo |

## Entry Points

Start here when exploring this area:

- **`useLive`** (Function) — `apps/web/src/data/queries.ts:477`
- **`useEnsembleOr`** (Function) — `apps/web/src/data/queries.ts:535`
- **`navigateTo`** (Function) — `apps/web/src/router.ts:12`
- **`buildChartData`** (Function) — `apps/web/src/features/live/LivePage.tsx:74`
- **`LivePage`** (Function) — `apps/web/src/features/live/LivePage.tsx:263`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useLive` | Function | `apps/web/src/data/queries.ts` | 477 |
| `useEnsembleOr` | Function | `apps/web/src/data/queries.ts` | 535 |
| `navigateTo` | Function | `apps/web/src/router.ts` | 12 |
| `buildChartData` | Function | `apps/web/src/features/live/LivePage.tsx` | 74 |
| `LivePage` | Function | `apps/web/src/features/live/LivePage.tsx` | 263 |
| `offPriceMarkersForDomain` | Function | `apps/web/src/features/live/LivePage.tsx` | 132 |
| `IntensityTimeline` | Function | `apps/web/src/features/live/LivePage.tsx` | 154 |
| `liveQuery` | Function | `apps/web/src/data/queries.ts` | 465 |
| `formatClock` | Function | `apps/web/src/features/live/LivePage.tsx` | 55 |
| `thresholdFor` | Function | `apps/web/src/features/live/LivePage.tsx` | 88 |
| `InvalidGameFallback` | Function | `apps/web/src/features/live/LivePage.tsx` | 242 |
| `formatAxisTime` | Function | `apps/web/src/features/live/LivePage.tsx` | 92 |
| `chartDomain` | Function | `apps/web/src/features/live/LivePage.tsx` | 101 |
| `xAxisDomain` | Function | `apps/web/src/features/live/LivePage.tsx` | 111 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LivePage → LiveQuery` | intra_community | 3 |
| `LivePage → NavigateTo` | intra_community | 3 |
| `IncidentReplay → LiveQuery` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Data | 3 calls |

## How to Explore

1. `gitnexus_context({name: "useLive"})` — see callers and callees
2. `gitnexus_query({query: "live"})` — find related execution flows
3. Read key files listed above for implementation details
