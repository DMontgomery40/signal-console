---
name: cluster-77
description: "Skill for the Cluster_77 area of signal-console. 4 symbols across 2 files."
---

# Cluster_77

4 symbols | 2 files | Cohesion: 43%

## When to Use

- Working with code in `apps/`
- Understanding how parseGameId, parseLiveId work
- Modifying cluster_77-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/router.ts` | parseGameId, parseLiveId |
| `apps/web/src/App.tsx` | CrashOnRender, routeContent |

## Entry Points

Start here when exploring this area:

- **`parseGameId`** (Function) — `apps/web/src/router.ts:23`
- **`parseLiveId`** (Function) — `apps/web/src/router.ts:38`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `parseGameId` | Function | `apps/web/src/router.ts` | 23 |
| `parseLiveId` | Function | `apps/web/src/router.ts` | 38 |
| `CrashOnRender` | Function | `apps/web/src/App.tsx` | 25 |
| `routeContent` | Function | `apps/web/src/App.tsx` | 54 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RouteContent → UseGame` | cross_community | 3 |
| `RouteContent → UseBoard` | cross_community | 3 |
| `RouteContent → NavigateTo` | cross_community | 3 |
| `RouteContent → IsNetworkError` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 2 calls |
| Games | 1 calls |
| Live | 1 calls |
| Backtest | 1 calls |
| Settings | 1 calls |
| Recent | 1 calls |

## How to Explore

1. `gitnexus_context({name: "parseGameId"})` — see callers and callees
2. `gitnexus_query({query: "cluster_77"})` — find related execution flows
3. Read key files listed above for implementation details
