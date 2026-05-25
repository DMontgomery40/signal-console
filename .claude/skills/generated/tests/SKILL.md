---
name: tests
description: "Skill for the Tests area of signal-console. 56 symbols across 12 files."
---

# Tests

56 symbols | 12 files | Cohesion: 100%

## When to Use

- Working with code in `apps/`
- Understanding how buildServer, resolvePort work
- Modifying tests-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/api/tests/fanout.test.ts` | startApp, isRecord, isUnknownArray, asRecord, readArray (+2) |
| `apps/api/tests/board.test.ts` | startApp, isRecord, isUnknownArray, asRecord, readObservations (+1) |
| `apps/api/tests/cache.test.ts` | startApp, rowCounts, extractCount, isRecord, asRecord (+1) |
| `apps/api/tests/detectors.test.ts` | startApp, isRecord, asRecord, isUnknownArray, fetchDetectorRows (+1) |
| `apps/api/tests/games.test.ts` | startApp, isRecord, ids, sports, tagsForGet |
| `apps/api/tests/live.test.ts` | startApp, isRecord, isUnknownArray, asRecord, readTicks |
| `apps/api/tests/microstructure.test.ts` | startApp, isRecord, isUnknownArray, asRecord, readEvents |
| `apps/api/tests/settings.test.ts` | startApp, isRecord, asRecord, tagsForGet, bm |
| `apps/api/src/server.ts` | buildServer, resolvePort, resolveHost, start |
| `apps/api/tests/backtest.test.ts` | startApp, isRecord, asRecord |

## Entry Points

Start here when exploring this area:

- **`buildServer`** (Function) — `apps/api/src/server.ts:40`
- **`resolvePort`** (Function) — `apps/api/src/server.ts:83`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `buildServer` | Function | `apps/api/src/server.ts` | 40 |
| `resolvePort` | Function | `apps/api/src/server.ts` | 83 |
| `resolveHost` | Function | `apps/api/src/server.ts` | 96 |
| `start` | Function | `apps/api/src/server.ts` | 101 |
| `startApp` | Function | `apps/api/tests/auth.test.ts` | 34 |
| `startApp` | Function | `apps/api/tests/backtest.test.ts` | 221 |
| `startApp` | Function | `apps/api/tests/board.test.ts` | 145 |
| `startApp` | Function | `apps/api/tests/cache.test.ts` | 146 |
| `startApp` | Function | `apps/api/tests/detectors.test.ts` | 52 |
| `startApp` | Function | `apps/api/tests/fanout.test.ts` | 171 |
| `startApp` | Function | `apps/api/tests/games.test.ts` | 95 |
| `startApp` | Function | `apps/api/tests/health.test.ts` | 161 |
| `startApp` | Function | `apps/api/tests/live.test.ts` | 118 |
| `startApp` | Function | `apps/api/tests/microstructure.test.ts` | 112 |
| `startApp` | Function | `apps/api/tests/settings.test.ts` | 86 |
| `isRecord` | Function | `apps/api/tests/board.test.ts` | 159 |
| `isUnknownArray` | Function | `apps/api/tests/board.test.ts` | 163 |
| `asRecord` | Function | `apps/api/tests/board.test.ts` | 167 |
| `readObservations` | Function | `apps/api/tests/board.test.ts` | 172 |
| `countRunsForGame` | Function | `apps/api/tests/board.test.ts` | 179 |

## How to Explore

1. `gitnexus_context({name: "buildServer"})` — see callers and callees
2. `gitnexus_query({query: "tests"})` — find related execution flows
3. Read key files listed above for implementation details
