---
name: services
description: "Skill for the Services area of signal-console. 106 symbols across 14 files."
---

# Services

106 symbols | 14 files | Cohesion: 84%

## When to Use

- Working with code in `apps/`
- Understanding how runBacktest, discoverGameIdsInWindow, getFanout work
- Modifying services-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/api/src/services/backtest.ts` | runBacktest, lookupRun, buildObservationsFromResult, buildStats, persistRun (+19) |
| `apps/api/src/services/settings.ts` | reasonFrom, pragmaInt, fileSize, fileMtimeIso, readGoldStats (+12) |
| `apps/api/src/services/board.ts` | getOrComputeBoard, persistRun, tx, computeGameWatermarkHash, sha256Hex (+11) |
| `apps/api/src/services/fanout.ts` | getFanout, loadPbpWindow, loadMovers, loadInstrumentLabels, extractPlayerName (+5) |
| `apps/api/src/services/fanout-narrative.ts` | renderFanoutNarrative, pickAnchorEvent, describeAnchor, countSignificantOthers, formatTail (+3) |
| `apps/api/src/services/microstructure.ts` | getMicrostructure, loadEvents, isRecord, pickString, pickNumber (+2) |
| `apps/api/src/services/games.ts` | parseIsoDuration, listGames, getGame, isRecord, fieldString (+2) |
| `apps/api/src/services/live.ts` | getLive, loadTicks, isRecord, pickString, pickNumber (+1) |
| `apps/api/src/services/detector-defaults.ts` | readFromDisk, readDetectorDefaults, boardMadDetectorVersion, orderedDefaults, isBaselineDefaults |
| `apps/api/src/routes/backtest.ts` | parseWindow, backtestRoutes |

## Entry Points

Start here when exploring this area:

- **`runBacktest`** (Function) — `apps/api/src/services/backtest.ts:89`
- **`discoverGameIdsInWindow`** (Function) — `apps/api/src/services/backtest.ts:685`
- **`getFanout`** (Function) — `apps/api/src/services/fanout.ts:66`
- **`readDetectorDefaults`** (Function) — `apps/api/src/services/detector-defaults.ts:86`
- **`readSettings`** (Function) — `apps/api/src/services/settings.ts:297`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `BacktestError` | Class | `apps/api/src/services/backtest.ts` | 81 |
| `runBacktest` | Function | `apps/api/src/services/backtest.ts` | 89 |
| `discoverGameIdsInWindow` | Function | `apps/api/src/services/backtest.ts` | 685 |
| `getFanout` | Function | `apps/api/src/services/fanout.ts` | 66 |
| `readDetectorDefaults` | Function | `apps/api/src/services/detector-defaults.ts` | 86 |
| `readSettings` | Function | `apps/api/src/services/settings.ts` | 297 |
| `getMicrostructure` | Function | `apps/api/src/services/microstructure.ts` | 50 |
| `renderFanoutNarrative` | Function | `apps/api/src/services/fanout-narrative.ts` | 29 |
| `getLive` | Function | `apps/api/src/services/live.ts` | 43 |
| `getOrComputeBoard` | Function | `apps/api/src/services/board.ts` | 63 |
| `boardMadDetectorVersion` | Function | `apps/api/src/services/detector-defaults.ts` | 125 |
| `parseIsoDuration` | Function | `apps/api/src/services/games.ts` | 41 |
| `listGames` | Function | `apps/api/src/services/games.ts` | 99 |
| `getGame` | Function | `apps/api/src/services/games.ts` | 119 |
| `parseWindow` | Function | `apps/api/src/routes/backtest.ts` | 112 |
| `backtestRoutes` | Function | `apps/api/src/routes/backtest.ts` | 119 |
| `lookupRun` | Function | `apps/api/src/services/backtest.ts` | 228 |
| `buildObservationsFromResult` | Function | `apps/api/src/services/backtest.ts` | 281 |
| `buildStats` | Function | `apps/api/src/services/backtest.ts` | 311 |
| `persistRun` | Function | `apps/api/src/services/backtest.ts` | 337 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `BacktestRoutes → IsBaselineDefaults` | cross_community | 5 |
| `BacktestRoutes → OrderedDefaults` | cross_community | 5 |
| `BacktestRoutes → ReadFromDisk` | cross_community | 4 |
| `BacktestRoutes → BacktestError` | cross_community | 4 |
| `BacktestRoutes → IsUnknownArray` | intra_community | 4 |
| `BacktestRoutes → IsRecord` | cross_community | 4 |
| `SettingsRoutes → PragmaInt` | cross_community | 4 |
| `SettingsRoutes → ReasonFrom` | cross_community | 4 |
| `SettingsRoutes → ReadFromDisk` | cross_community | 4 |
| `SettingsRoutes → FileSize` | cross_community | 4 |

## How to Explore

1. `gitnexus_context({name: "runBacktest"})` — see callers and callees
2. `gitnexus_query({query: "services"})` — find related execution flows
3. Read key files listed above for implementation details
