---
name: cluster-100
description: "Skill for the Cluster_100 area of signal-console. 13 symbols across 1 files."
---

# Cluster_100

13 symbols | 1 files | Cohesion: 86%

## When to Use

- Working with code in `apps/`
- Understanding how buildWorkerHeartbeatSummary, runWorkerCycle work
- Modifying cluster_100-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/worker/src/index.ts` | numberFromEnv, getBet365RateLimitCooldownMs, getSidecarLookbackDays, getSidecarLookaheadDays, getKalshiLiveMaxEvents (+8) |

## Entry Points

Start here when exploring this area:

- **`buildWorkerHeartbeatSummary`** (Function) — `apps/worker/src/index.ts:322`
- **`runWorkerCycle`** (Function) — `apps/worker/src/index.ts:356`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `buildWorkerHeartbeatSummary` | Function | `apps/worker/src/index.ts` | 322 |
| `runWorkerCycle` | Function | `apps/worker/src/index.ts` | 356 |
| `numberFromEnv` | Function | `apps/worker/src/index.ts` | 36 |
| `getBet365RateLimitCooldownMs` | Function | `apps/worker/src/index.ts` | 57 |
| `getSidecarLookbackDays` | Function | `apps/worker/src/index.ts` | 61 |
| `getSidecarLookaheadDays` | Function | `apps/worker/src/index.ts` | 65 |
| `getKalshiLiveMaxEvents` | Function | `apps/worker/src/index.ts` | 69 |
| `getKalshiLiveLookbackDays` | Function | `apps/worker/src/index.ts` | 73 |
| `getKalshiLiveMinimumStartDate` | Function | `apps/worker/src/index.ts` | 77 |
| `getPolymarketTradesLookbackMinutes` | Function | `apps/worker/src/index.ts` | 83 |
| `getPolymarketTradesMaxMarkets` | Function | `apps/worker/src/index.ts` | 87 |
| `isRateLimitFailure` | Function | `apps/worker/src/index.ts` | 145 |
| `drainQueuedAdminActions` | Function | `apps/worker/src/index.ts` | 255 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `StartWorker → NumberFromEnv` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_101 | 3 calls |

## How to Explore

1. `gitnexus_context({name: "buildWorkerHeartbeatSummary"})` — see callers and callees
2. `gitnexus_query({query: "cluster_100"})` — find related execution flows
3. Read key files listed above for implementation details
