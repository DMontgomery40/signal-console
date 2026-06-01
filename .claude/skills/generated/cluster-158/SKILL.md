---
name: cluster-158
description: "Skill for the Cluster_158 area of signal-console. 16 symbols across 1 files."
---

# Cluster_158

16 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `packages/`
- Understanding how syncPolymarketNbaTrades work
- Modifying cluster_158-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/adapters/src/polymarket-trades.ts` | sleep, normalizeToken, toNumber, toUnixSeconds, parseStringArray (+11) |

## Entry Points

Start here when exploring this area:

- **`syncPolymarketNbaTrades`** (Function) — `packages/adapters/src/polymarket-trades.ts:365`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `syncPolymarketNbaTrades` | Function | `packages/adapters/src/polymarket-trades.ts` | 365 |
| `sleep` | Function | `packages/adapters/src/polymarket-trades.ts` | 87 |
| `normalizeToken` | Function | `packages/adapters/src/polymarket-trades.ts` | 91 |
| `toNumber` | Function | `packages/adapters/src/polymarket-trades.ts` | 99 |
| `toUnixSeconds` | Function | `packages/adapters/src/polymarket-trades.ts` | 105 |
| `parseStringArray` | Function | `packages/adapters/src/polymarket-trades.ts` | 109 |
| `parseObjectJson` | Function | `packages/adapters/src/polymarket-trades.ts` | 120 |
| `hashPayload` | Function | `packages/adapters/src/polymarket-trades.ts` | 132 |
| `hydrateSourceMarketsWithGammaMetadata` | Function | `packages/adapters/src/polymarket-trades.ts` | 136 |
| `selectTargets` | Function | `packages/adapters/src/polymarket-trades.ts` | 180 |
| `fetchGammaEvent` | Function | `packages/adapters/src/polymarket-trades.ts` | 264 |
| `fetchTradesPage` | Function | `packages/adapters/src/polymarket-trades.ts` | 282 |
| `buildTeamOutcomeMap` | Function | `packages/adapters/src/polymarket-trades.ts` | 308 |
| `selectionForOutcome` | Function | `packages/adapters/src/polymarket-trades.ts` | 322 |
| `tradeTimestampIso` | Function | `packages/adapters/src/polymarket-trades.ts` | 347 |
| `tradeIdentity` | Function | `packages/adapters/src/polymarket-trades.ts` | 353 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SyncPolymarketNbaTrades → ParseStringArray` | intra_community | 3 |
| `SyncPolymarketNbaTrades → ParseObjectJson` | intra_community | 3 |
| `SyncPolymarketNbaTrades → ToNumber` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "syncPolymarketNbaTrades"})` — see callers and callees
2. `gitnexus_query({query: "cluster_158"})` — find related execution flows
3. Read key files listed above for implementation details
