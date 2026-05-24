---
name: cache-migrations
description: "Skill for the Cache-migrations area of signal-console. 4 symbols across 2 files."
---

# Cache-migrations

4 symbols | 2 files | Cohesion: 100%

## When to Use

- Working with code in `packages/`
- Understanding how runMigrations, openCacheDb work
- Modifying cache-migrations-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/db/src/cache-migrations/runner.ts` | runMigrations, openCacheDb |
| `scripts/cache-reset.ts` | removeIfExists, main |

## Entry Points

Start here when exploring this area:

- **`runMigrations`** (Function) — `packages/db/src/cache-migrations/runner.ts:29`
- **`openCacheDb`** (Function) — `packages/db/src/cache-migrations/runner.ts:34`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `runMigrations` | Function | `packages/db/src/cache-migrations/runner.ts` | 29 |
| `openCacheDb` | Function | `packages/db/src/cache-migrations/runner.ts` | 34 |
| `removeIfExists` | Function | `scripts/cache-reset.ts` | 9 |
| `main` | Function | `scripts/cache-reset.ts` | 13 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → RunMigrations` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "runMigrations"})` — see callers and callees
2. `gitnexus_query({query: "cache-migrations"})` — find related execution flows
3. Read key files listed above for implementation details
