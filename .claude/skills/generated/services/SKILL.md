---
name: services
description: "Skill for the Services area of signal-console. 196 symbols across 24 files."
---

# Services

196 symbols | 24 files | Cohesion: 85%

## When to Use

- Working with code in `apps/`
- Understanding how getOrComputeBoard, readDetectorDefaults, runDetector work
- Modifying services-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/api/src/services/detector-runner.ts` | runDetector, resolveEffectiveTickWindow, scopeGameIds, scopeStart, scopeEnd (+33) |
| `apps/api/src/services/incidents.ts` | isRecord, readJson, readString, readBool, readNumberOrNull (+30) |
| `apps/api/src/services/board-mad-context.ts` | loadBoardMadTicksForGame, values, selectOpeningWindowValues, readPbpBounds, pbpHasGameClockColumns (+13) |
| `apps/api/src/services/settings.ts` | reasonFrom, pragmaInt, fileSize, fileMtimeIso, readGoldStats (+12) |
| `apps/api/src/services/fanout.ts` | getFanout, loadPbpWindow, loadMovers, loadMicrostructureWindow, pickNumberOrNull (+7) |
| `apps/api/src/services/detector-defaults.ts` | readFromDisk, readDetectorDefaults, boardMadDetectorVersion, orderedDefaults, isBaselineDefaults (+5) |
| `apps/api/src/services/fanout-narrative.ts` | renderFanoutNarrative, formatGameClock, pickAnchorEvent, describeAnchor, countSignificantOthers (+4) |
| `apps/api/src/services/games.ts` | isValidIsoDuration, parseIsoDuration, listGames, getGame, isRecord (+3) |
| `apps/api/src/services/microstructure.ts` | getMicrostructure, loadEvents, isRecord, pickString, pickNumber (+2) |
| `apps/api/src/services/board-volatility-model.ts` | isFiniteNumber, bucketKey, sanitizeTicks, contributionWeight, tickSourceKey (+2) |

## Entry Points

Start here when exploring this area:

- **`getOrComputeBoard`** (Function) — `apps/api/src/services/board.ts:83`
- **`readDetectorDefaults`** (Function) — `apps/api/src/services/detector-defaults.ts:279`
- **`runDetector`** (Function) — `apps/api/src/services/detector-runner.ts:174`
- **`parseStrictIsoTimestamp`** (Function) — `apps/api/src/services/timestamps.ts:22`
- **`listKnownCases`** (Function) — `apps/api/src/services/incidents.ts:384`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `RunnerError` | Class | `apps/api/src/services/detector-runner.ts` | 122 |
| `BacktestError` | Class | `apps/api/src/services/backtest.ts` | 68 |
| `CacheError` | Class | `apps/api/src/services/cache.ts` | 20 |
| `getOrComputeBoard` | Function | `apps/api/src/services/board.ts` | 83 |
| `readDetectorDefaults` | Function | `apps/api/src/services/detector-defaults.ts` | 279 |
| `runDetector` | Function | `apps/api/src/services/detector-runner.ts` | 174 |
| `parseStrictIsoTimestamp` | Function | `apps/api/src/services/timestamps.ts` | 22 |
| `listKnownCases` | Function | `apps/api/src/services/incidents.ts` | 384 |
| `appendDeskIncident` | Function | `apps/api/src/services/incidents.ts` | 541 |
| `getFanout` | Function | `apps/api/src/services/fanout.ts` | 109 |
| `resolveGameTimingContext` | Function | `apps/api/src/services/detector-runner.ts` | 136 |
| `timingContexts` | Function | `apps/api/src/services/detector-runner.ts` | 209 |
| `getMicrostructure` | Function | `apps/api/src/services/microstructure.ts` | 50 |
| `renderFanoutNarrative` | Function | `apps/api/src/services/fanout-narrative.ts` | 30 |
| `formatGameClock` | Function | `apps/api/src/services/fanout-narrative.ts` | 60 |
| `readSettings` | Function | `apps/api/src/services/settings.ts` | 297 |
| `getLive` | Function | `apps/api/src/services/live.ts` | 47 |
| `loadBoardMadTicksForGame` | Function | `apps/api/src/services/board-mad-context.ts` | 72 |
| `selectOpeningWindowValues` | Function | `apps/api/src/services/board-mad-context.ts` | 217 |
| `buildBoardVolatilityModelRequest` | Function | `apps/api/src/services/board-volatility-model.ts` | 78 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `BacktestRoutes → IsLeapYear` | cross_community | 6 |
| `SettingsRoutes → SchedulePathFor` | cross_community | 5 |
| `SettingsRoutes → WriteJsonAtomic` | cross_community | 5 |
| `BacktestRoutes → ReadInt` | cross_community | 5 |
| `BacktestRoutes → ReadFromDisk` | cross_community | 5 |
| `BacktestRoutes → RunnerError` | cross_community | 5 |
| `BacktestRoutes → IsRecord` | cross_community | 5 |
| `EnsembleOrRoutes → SchedulePathFor` | cross_community | 5 |
| `EnsembleOrRoutes → WriteJsonAtomic` | cross_community | 5 |
| `EnsembleOrRoutes → IsBaselineDefaults` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Board-mad | 2 calls |
| Loaders | 1 calls |

## How to Explore

1. `gitnexus_context({name: "getOrComputeBoard"})` — see callers and callees
2. `gitnexus_query({query: "services"})` — find related execution flows
3. Read key files listed above for implementation details
