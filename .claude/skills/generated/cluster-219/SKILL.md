---
name: cluster-219
description: "Skill for the Cluster_219 area of signal-console. 21 symbols across 1 files."
---

# Cluster_219

21 symbols | 1 files | Cohesion: 97%

## When to Use

- Working with code in `packages/`
- Understanding how applyMigrations work
- Modifying cluster_219-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/shared/src/migrations.ts` | nowIso, ensureSchemaMigrationsTable, getAppliedVersion, insertMigration, tableExists (+16) |

## Entry Points

Start here when exploring this area:

- **`applyMigrations`** (Function) — `packages/shared/src/migrations.ts:284`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `applyMigrations` | Function | `packages/shared/src/migrations.ts` | 284 |
| `nowIso` | Function | `packages/shared/src/migrations.ts` | 6 |
| `ensureSchemaMigrationsTable` | Function | `packages/shared/src/migrations.ts` | 10 |
| `getAppliedVersion` | Function | `packages/shared/src/migrations.ts` | 20 |
| `insertMigration` | Function | `packages/shared/src/migrations.ts` | 28 |
| `tableExists` | Function | `packages/shared/src/migrations.ts` | 36 |
| `buildMigrationStableId` | Function | `packages/shared/src/migrations.ts` | 51 |
| `applyInitialRuntimeSchema` | Function | `packages/shared/src/migrations.ts` | 55 |
| `applyLiveResearchSchema` | Function | `packages/shared/src/migrations.ts` | 76 |
| `applyLegacyRuntimeCleanup` | Function | `packages/shared/src/migrations.ts` | 226 |
| `applyHistoricalIngestionSupport` | Function | `packages/shared/src/migrations.ts` | 248 |
| `applyCanonicalInstrumentConsolidation` | Function | `packages/shared/src/migrations.ts` | 357 |
| `applyPolymarketPlayerPropCanonicalIds` | Function | `packages/shared/src/migrations.ts` | 395 |
| `applyLatestLookupIndexes` | Function | `packages/shared/src/migrations.ts` | 495 |
| `applyDivergenceLookupIndexes` | Function | `packages/shared/src/migrations.ts` | 522 |
| `applyMarketAnomalySupport` | Function | `packages/shared/src/migrations.ts` | 535 |
| `applyMarketAnomalyLookupIndexes` | Function | `packages/shared/src/migrations.ts` | 597 |
| `applyNbaPlayByPlayActionStorage` | Function | `packages/shared/src/migrations.ts` | 618 |
| `applySourceCoverageLookupIndexes` | Function | `packages/shared/src/migrations.ts` | 653 |
| `applyMarketMicrostructureTradeIdentityIndex` | Function | `packages/shared/src/migrations.ts` | 670 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RebuildBoardVolatilityBaselines → NowIso` | cross_community | 6 |
| `ListPlayerPropDisagreementAlerts → NowIso` | cross_community | 6 |
| `ListFinishedGameIncidents → NowIso` | cross_community | 6 |
| `UpsertGame → NowIso` | cross_community | 6 |
| `RecordNbaPlayByPlayActions → NowIso` | cross_community | 6 |
| `UpsertSourceMarket → NowIso` | cross_community | 6 |
| `RecordMarketMicrostructureEvent → NowIso` | cross_community | 6 |
| `ResolveSourceMarketMapping → NowIso` | cross_community | 6 |
| `ClaimNextQueuedAdminAction → NowIso` | cross_community | 6 |
| `UpsertWatchlist → NowIso` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Board-anomaly | 1 calls |

## How to Explore

1. `gitnexus_context({name: "applyMigrations"})` — see callers and callees
2. `gitnexus_query({query: "cluster_219"})` — find related execution flows
3. Read key files listed above for implementation details
