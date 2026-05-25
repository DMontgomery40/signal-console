---
name: services
description: "Skill for the Services area of signal-console. 137 symbols across 17 files."
---

# Services

137 symbols | 17 files | Cohesion: 84%

## When to Use

- Working with code in `apps/`
- Understanding how getOrComputeBoard, runBacktest, getFanout work
- Modifying services-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/api/src/services/backtest.ts` | BacktestError, canonicalTimestamp, runBacktest, resolveDispatch, lookupRun (+20) |
| `apps/api/src/services/settings.ts` | reasonFrom, pragmaInt, fileSize, fileMtimeIso, readGoldStats (+12) |
| `apps/api/src/services/board.ts` | getOrComputeBoard, lookupRun, loadObservations, persistRun, tx (+11) |
| `apps/api/src/services/board-mad-context.ts` | parseNbaClockSecondsRemaining, nbaGameElapsedSeconds, buildBoardMadHistoricalPriors, combineSidePriors, loadNbaGames (+10) |
| `apps/api/src/services/fanout.ts` | getFanout, loadPbpWindow, loadMovers, loadMicrostructureWindow, pickNumberOrNull (+7) |
| `apps/api/src/services/fanout-narrative.ts` | renderFanoutNarrative, formatGameClock, pickAnchorEvent, describeAnchor, countSignificantOthers (+4) |
| `apps/api/src/services/detector-defaults.ts` | schedulePathFor, writeJsonAtomic, readFromDisk, applyDueScheduledDefaults, readDetectorDefaults (+4) |
| `apps/api/src/services/games.ts` | isValidIsoDuration, parseIsoDuration, listGames, getGame, isRecord (+3) |
| `apps/api/src/services/microstructure.ts` | getMicrostructure, loadEvents, isRecord, pickString, pickNumber (+2) |
| `apps/api/src/services/live.ts` | getLive, loadTicks, isRecord, pickString, pickNumber (+1) |

## Entry Points

Start here when exploring this area:

- **`getOrComputeBoard`** (Function) — `apps/api/src/services/board.ts:64`
- **`runBacktest`** (Function) — `apps/api/src/services/backtest.ts:111`
- **`getFanout`** (Function) — `apps/api/src/services/fanout.ts:109`
- **`parseNbaClockSecondsRemaining`** (Function) — `apps/api/src/services/board-mad-context.ts:26`
- **`nbaGameElapsedSeconds`** (Function) — `apps/api/src/services/board-mad-context.ts:45`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BacktestError` | Class | `apps/api/src/services/backtest.ts` | 95 |
| `CacheError` | Class | `apps/api/src/services/cache.ts` | 20 |
| `getOrComputeBoard` | Function | `apps/api/src/services/board.ts` | 64 |
| `runBacktest` | Function | `apps/api/src/services/backtest.ts` | 111 |
| `getFanout` | Function | `apps/api/src/services/fanout.ts` | 109 |
| `parseNbaClockSecondsRemaining` | Function | `apps/api/src/services/board-mad-context.ts` | 26 |
| `nbaGameElapsedSeconds` | Function | `apps/api/src/services/board-mad-context.ts` | 45 |
| `buildBoardMadHistoricalPriors` | Function | `apps/api/src/services/board-mad-context.ts` | 123 |
| `getMicrostructure` | Function | `apps/api/src/services/microstructure.ts` | 50 |
| `renderFanoutNarrative` | Function | `apps/api/src/services/fanout-narrative.ts` | 30 |
| `formatGameClock` | Function | `apps/api/src/services/fanout-narrative.ts` | 60 |
| `readSettings` | Function | `apps/api/src/services/settings.ts` | 297 |
| `getLive` | Function | `apps/api/src/services/live.ts` | 43 |
| `readDetectorDefaults` | Function | `apps/api/src/services/detector-defaults.ts` | 256 |
| `scheduleDetectorDefaults` | Function | `apps/api/src/services/detector-defaults.ts` | 275 |
| `parseStrictIsoTimestamp` | Function | `apps/api/src/services/timestamps.ts` | 22 |
| `isValidIsoDuration` | Function | `apps/api/src/services/games.ts` | 38 |
| `parseIsoDuration` | Function | `apps/api/src/services/games.ts` | 47 |
| `listGames` | Function | `apps/api/src/services/games.ts` | 108 |
| `getGame` | Function | `apps/api/src/services/games.ts` | 134 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunBacktest → IsLeapYear` | cross_community | 5 |
| `SettingsRoutes → SchedulePathFor` | cross_community | 5 |
| `SettingsRoutes → WriteJsonAtomic` | cross_community | 5 |
| `BacktestRoutes → ReadInt` | cross_community | 5 |
| `BacktestRoutes → SchedulePathFor` | cross_community | 5 |
| `BacktestRoutes → WriteJsonAtomic` | cross_community | 5 |
| `BacktestRoutes → IsBaselineDefaults` | cross_community | 5 |
| `BacktestRoutes → OrderedDefaults` | cross_community | 5 |
| `RunBacktest → ReadInt` | cross_community | 4 |
| `SettingsRoutes → PragmaInt` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Board-mad | 2 calls |

## How to Explore

1. `gitnexus_context({name: "getOrComputeBoard"})` — see callers and callees
2. `gitnexus_query({query: "services"})` — find related execution flows
3. Read key files listed above for implementation details
