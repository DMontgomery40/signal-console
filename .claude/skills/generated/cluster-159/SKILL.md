---
name: cluster-159
description: "Skill for the Cluster_159 area of signal-console. 16 symbols across 1 files."
---

# Cluster_159

16 symbols | 1 files | Cohesion: 90%

## When to Use

- Working with code in `packages/`
- Understanding how buildPolymarketSelectionRecords work
- Modifying cluster_159-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/adapters/src/polymarket.ts` | parseJsonArray, parseOptionalJsonArray, normalizeToken, marketTypeSupported, marketWindowPrefix (+11) |

## Entry Points

Start here when exploring this area:

- **`buildPolymarketSelectionRecords`** (Function) — `packages/adapters/src/polymarket.ts:588`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `buildPolymarketSelectionRecords` | Function | `packages/adapters/src/polymarket.ts` | 588 |
| `parseJsonArray` | Function | `packages/adapters/src/polymarket.ts` | 101 |
| `parseOptionalJsonArray` | Function | `packages/adapters/src/polymarket.ts` | 113 |
| `normalizeToken` | Function | `packages/adapters/src/polymarket.ts` | 124 |
| `marketTypeSupported` | Function | `packages/adapters/src/polymarket.ts` | 132 |
| `marketWindowPrefix` | Function | `packages/adapters/src/polymarket.ts` | 149 |
| `formatLine` | Function | `packages/adapters/src/polymarket.ts` | 153 |
| `buildSourceMarketId` | Function | `packages/adapters/src/polymarket.ts` | 165 |
| `resolveParticipantKey` | Function | `packages/adapters/src/polymarket.ts` | 205 |
| `toNumber` | Function | `packages/adapters/src/polymarket.ts` | 254 |
| `describeMetric` | Function | `packages/adapters/src/polymarket.ts` | 267 |
| `buildMoneylineSelectionRecords` | Function | `packages/adapters/src/polymarket.ts` | 282 |
| `prices` | Function | `packages/adapters/src/polymarket.ts` | 290 |
| `buildSpreadSelectionRecords` | Function | `packages/adapters/src/polymarket.ts` | 354 |
| `buildTotalSelectionRecords` | Function | `packages/adapters/src/polymarket.ts` | 425 |
| `buildPlayerPropSelectionRecords` | Function | `packages/adapters/src/polymarket.ts` | 493 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SyncPolymarketNbaMarkets → NormalizeToken` | cross_community | 4 |
| `SyncPolymarketNbaMarkets → ParseJsonArray` | cross_community | 4 |
| `SyncPolymarketNbaMarkets → ParseOptionalJsonArray` | cross_community | 4 |
| `SyncPolymarketNbaMarkets → MarketWindowPrefix` | cross_community | 4 |
| `SyncPolymarketNbaMarkets → ToNumber` | cross_community | 4 |
| `BuildPolymarketSelectionRecords → NormalizeToken` | intra_community | 4 |
| `SyncPolymarketNbaMarkets → MarketTypeSupported` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_132 | 4 calls |

## How to Explore

1. `gitnexus_context({name: "buildPolymarketSelectionRecords"})` — see callers and callees
2. `gitnexus_query({query: "cluster_159"})` — find related execution flows
3. Read key files listed above for implementation details
