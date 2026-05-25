---
name: routes
description: "Skill for the Routes area of signal-console. 16 symbols across 6 files."
---

# Routes

16 symbols | 6 files | Cohesion: 83%

## When to Use

- Working with code in `apps/`
- Understanding how discoverGameIdsInWindow, writeDetectorDefaults work
- Modifying routes-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/api/src/routes/backtest.ts` | parseTimestamp, parseWindow, normalizeGameIds, backtestRoutes |
| `apps/api/src/routes/detectors.ts` | isPlainObject, toJsonSchemaObject, buildRows, detectorsRoutes |
| `apps/api/src/routes/settings.ts` | isRecord, readDefaultAppVersion, settingsRoutes |
| `apps/api/src/routes/health.ts` | reasonFrom, verifyGoldReadSchema, healthRoutes |
| `apps/api/src/services/backtest.ts` | discoverGameIdsInWindow |
| `apps/api/src/services/detector-defaults.ts` | writeDetectorDefaults |

## Entry Points

Start here when exploring this area:

- **`discoverGameIdsInWindow`** (Function) — `apps/api/src/services/backtest.ts:839`
- **`writeDetectorDefaults`** (Function) — `apps/api/src/services/detector-defaults.ts:268`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `discoverGameIdsInWindow` | Function | `apps/api/src/services/backtest.ts` | 839 |
| `writeDetectorDefaults` | Function | `apps/api/src/services/detector-defaults.ts` | 268 |
| `parseTimestamp` | Function | `apps/api/src/routes/backtest.ts` | 119 |
| `parseWindow` | Function | `apps/api/src/routes/backtest.ts` | 123 |
| `normalizeGameIds` | Function | `apps/api/src/routes/backtest.ts` | 135 |
| `backtestRoutes` | Function | `apps/api/src/routes/backtest.ts` | 141 |
| `isPlainObject` | Function | `apps/api/src/routes/detectors.ts` | 55 |
| `toJsonSchemaObject` | Function | `apps/api/src/routes/detectors.ts` | 59 |
| `buildRows` | Function | `apps/api/src/routes/detectors.ts` | 68 |
| `detectorsRoutes` | Function | `apps/api/src/routes/detectors.ts` | 78 |
| `isRecord` | Function | `apps/api/src/routes/settings.ts` | 80 |
| `readDefaultAppVersion` | Function | `apps/api/src/routes/settings.ts` | 84 |
| `settingsRoutes` | Function | `apps/api/src/routes/settings.ts` | 417 |
| `reasonFrom` | Function | `apps/api/src/routes/health.ts` | 41 |
| `verifyGoldReadSchema` | Function | `apps/api/src/routes/health.ts` | 78 |
| `healthRoutes` | Function | `apps/api/src/routes/health.ts` | 84 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SettingsRoutes → SchedulePathFor` | cross_community | 5 |
| `SettingsRoutes → WriteJsonAtomic` | cross_community | 5 |
| `BacktestRoutes → ReadInt` | cross_community | 5 |
| `BacktestRoutes → SchedulePathFor` | cross_community | 5 |
| `BacktestRoutes → WriteJsonAtomic` | cross_community | 5 |
| `BacktestRoutes → IsBaselineDefaults` | cross_community | 5 |
| `BacktestRoutes → OrderedDefaults` | cross_community | 5 |
| `SettingsRoutes → PragmaInt` | cross_community | 4 |
| `SettingsRoutes → ReasonFrom` | cross_community | 4 |
| `SettingsRoutes → ReadFromDisk` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Services | 7 calls |

## How to Explore

1. `gitnexus_context({name: "discoverGameIdsInWindow"})` — see callers and callees
2. `gitnexus_query({query: "routes"})` — find related execution flows
3. Read key files listed above for implementation details
