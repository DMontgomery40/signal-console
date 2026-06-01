---
name: routes
description: "Skill for the Routes area of signal-console. 17 symbols across 5 files."
---

# Routes

17 symbols | 5 files | Cohesion: 82%

## When to Use

- Working with code in `apps/`
- Understanding how discoverGameIdsInWindow work
- Modifying routes-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/api/src/routes/backtest.ts` | parseTimestamp, parseWindow, normalizeGameIds, backtestRoutes |
| `apps/api/src/routes/detectors.ts` | isPlainObject, toJsonSchemaObject, buildRows, detectorsRoutes |
| `apps/api/src/routes/settings.ts` | isRecord, toJsonSchemaObject, readDefaultAppVersion, settingsRoutes |
| `apps/api/src/routes/health.ts` | reasonFrom, verifyGoldReadSchema, healthRoutes |
| `apps/api/src/services/backtest.ts` | isRecord, discoverGameIdsInWindow |

## Entry Points

Start here when exploring this area:

- **`discoverGameIdsInWindow`** (Function) — `apps/api/src/services/backtest.ts:219`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `discoverGameIdsInWindow` | Function | `apps/api/src/services/backtest.ts` | 219 |
| `parseTimestamp` | Function | `apps/api/src/routes/backtest.ts` | 127 |
| `parseWindow` | Function | `apps/api/src/routes/backtest.ts` | 131 |
| `normalizeGameIds` | Function | `apps/api/src/routes/backtest.ts` | 143 |
| `backtestRoutes` | Function | `apps/api/src/routes/backtest.ts` | 149 |
| `isRecord` | Function | `apps/api/src/services/backtest.ts` | 18 |
| `isPlainObject` | Function | `apps/api/src/routes/detectors.ts` | 57 |
| `toJsonSchemaObject` | Function | `apps/api/src/routes/detectors.ts` | 61 |
| `buildRows` | Function | `apps/api/src/routes/detectors.ts` | 70 |
| `detectorsRoutes` | Function | `apps/api/src/routes/detectors.ts` | 87 |
| `isRecord` | Function | `apps/api/src/routes/settings.ts` | 49 |
| `toJsonSchemaObject` | Function | `apps/api/src/routes/settings.ts` | 53 |
| `readDefaultAppVersion` | Function | `apps/api/src/routes/settings.ts` | 57 |
| `settingsRoutes` | Function | `apps/api/src/routes/settings.ts` | 178 |
| `reasonFrom` | Function | `apps/api/src/routes/health.ts` | 41 |
| `verifyGoldReadSchema` | Function | `apps/api/src/routes/health.ts` | 78 |
| `healthRoutes` | Function | `apps/api/src/routes/health.ts` | 84 |

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
