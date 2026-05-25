---
name: cluster-112
description: "Skill for the Cluster_112 area of signal-console. 13 symbols across 1 files."
---

# Cluster_112

13 symbols | 1 files | Cohesion: 96%

## When to Use

- Working with code in `packages/`
- Understanding how parseBet365DumpLine, pick, syncBet365InternalDump work
- Modifying cluster_112-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/adapters/src/bet365-internal-dump.ts` | normalizeToken, buildGameKey, shiftIsoDate, americanToImplied, decimalToImplied (+8) |

## Entry Points

Start here when exploring this area:

- **`parseBet365DumpLine`** (Function) — `packages/adapters/src/bet365-internal-dump.ts:93`
- **`pick`** (Function) — `packages/adapters/src/bet365-internal-dump.ts:111`
- **`syncBet365InternalDump`** (Function) — `packages/adapters/src/bet365-internal-dump.ts:211`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `parseBet365DumpLine` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 93 |
| `pick` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 111 |
| `syncBet365InternalDump` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 211 |
| `normalizeToken` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 43 |
| `buildGameKey` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 51 |
| `shiftIsoDate` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 58 |
| `americanToImplied` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 64 |
| `decimalToImplied` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 69 |
| `normalizeImpliedProbability` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 74 |
| `buildRawPayloadHash` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 85 |
| `buildGameIndex` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 163 |
| `resolveGame` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 179 |
| `buildDisplayLabel` | Function | `packages/adapters/src/bet365-internal-dump.ts` | 198 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SyncBet365InternalDump → NormalizeToken` | intra_community | 4 |
| `SyncBet365InternalDump → BuildStableId` | cross_community | 4 |
| `SyncBet365InternalDump → ShiftIsoDate` | intra_community | 3 |
| `SyncBet365InternalDump → Pick` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_109 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "parseBet365DumpLine"})` — see callers and callees
2. `gitnexus_query({query: "cluster_112"})` — find related execution flows
3. Read key files listed above for implementation details
