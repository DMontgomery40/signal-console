---
name: cluster-122
description: "Skill for the Cluster_122 area of signal-console. 13 symbols across 1 files."
---

# Cluster_122

13 symbols | 1 files | Cohesion: 86%

## When to Use

- Working with code in `apps/`
- Understanding how buildWorkerHeartbeatSummary, runWorkerCycle work
- Modifying cluster_122-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/worker/src/index.ts` | numberFromEnv, getBet365RateLimitCooldownMs, getSidecarLookbackDays, getSidecarLookaheadDays, getKalshiLiveMaxEvents (+8) |

## Entry Points

Start here when exploring this area:

- **`buildWorkerHeartbeatSummary`** (Function) — `apps/worker/src/index.ts:323`
- **`runWorkerCycle`** (Function) — `apps/worker/src/index.ts:357`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `buildWorkerHeartbeatSummary` | Function | `apps/worker/src/index.ts` | 323 |
| `runWorkerCycle` | Function | `apps/worker/src/index.ts` | 357 |
| `numberFromEnv` | Function | `apps/worker/src/index.ts` | 37 |
| `getBet365RateLimitCooldownMs` | Function | `apps/worker/src/index.ts` | 58 |
| `getSidecarLookbackDays` | Function | `apps/worker/src/index.ts` | 62 |
| `getSidecarLookaheadDays` | Function | `apps/worker/src/index.ts` | 66 |
| `getKalshiLiveMaxEvents` | Function | `apps/worker/src/index.ts` | 70 |
| `getKalshiLiveLookbackDays` | Function | `apps/worker/src/index.ts` | 74 |
| `getKalshiLiveMinimumStartDate` | Function | `apps/worker/src/index.ts` | 78 |
| `getPolymarketTradesLookbackMinutes` | Function | `apps/worker/src/index.ts` | 84 |
| `getPolymarketTradesMaxMarkets` | Function | `apps/worker/src/index.ts` | 88 |
| `isRateLimitFailure` | Function | `apps/worker/src/index.ts` | 146 |
| `drainQueuedAdminActions` | Function | `apps/worker/src/index.ts` | 256 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunWorkerCycle → NumberFromEnv` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_123 | 3 calls |

## How to Explore

1. `gitnexus_context({name: "buildWorkerHeartbeatSummary"})` — see callers and callees
2. `gitnexus_query({query: "cluster_122"})` — find related execution flows
3. Read key files listed above for implementation details
