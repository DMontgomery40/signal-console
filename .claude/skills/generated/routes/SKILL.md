---
name: routes
description: "Skill for the Routes area of signal-console. 12 symbols across 6 files."
---

# Routes

12 symbols | 6 files | Cohesion: 95%

## When to Use

- Working with code in `apps/`
- Understanding how writeDetectorDefaults, clearCache work
- Modifying routes-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/api/src/routes/detectors.ts` | isPlainObject, toJsonSchemaObject, buildRows, detectorsRoutes |
| `apps/api/src/routes/settings.ts` | isRecord, readDefaultAppVersion, settingsRoutes |
| `apps/api/src/routes/health.ts` | reasonFrom, healthRoutes |
| `apps/api/src/services/detector-defaults.ts` | writeDetectorDefaults |
| `apps/api/src/routes/cache.ts` | cacheRoutes |
| `apps/api/src/services/cache.ts` | clearCache |

## Entry Points

Start here when exploring this area:

- **`writeDetectorDefaults`** (Function) — `apps/api/src/services/detector-defaults.ts:98`
- **`clearCache`** (Function) — `apps/api/src/services/cache.ts:18`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `writeDetectorDefaults` | Function | `apps/api/src/services/detector-defaults.ts` | 98 |
| `clearCache` | Function | `apps/api/src/services/cache.ts` | 18 |
| `isPlainObject` | Function | `apps/api/src/routes/detectors.ts` | 55 |
| `toJsonSchemaObject` | Function | `apps/api/src/routes/detectors.ts` | 59 |
| `buildRows` | Function | `apps/api/src/routes/detectors.ts` | 68 |
| `detectorsRoutes` | Function | `apps/api/src/routes/detectors.ts` | 78 |
| `isRecord` | Function | `apps/api/src/routes/settings.ts` | 45 |
| `readDefaultAppVersion` | Function | `apps/api/src/routes/settings.ts` | 49 |
| `settingsRoutes` | Function | `apps/api/src/routes/settings.ts` | 202 |
| `cacheRoutes` | Function | `apps/api/src/routes/cache.ts` | 52 |
| `reasonFrom` | Function | `apps/api/src/routes/health.ts` | 38 |
| `healthRoutes` | Function | `apps/api/src/routes/health.ts` | 44 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SettingsRoutes → PragmaInt` | cross_community | 4 |
| `SettingsRoutes → ReasonFrom` | cross_community | 4 |
| `SettingsRoutes → ReadFromDisk` | cross_community | 4 |
| `SettingsRoutes → FileSize` | cross_community | 4 |
| `SettingsRoutes → FileMtimeIso` | cross_community | 4 |
| `DetectorsRoutes → IsPlainObject` | intra_community | 4 |
| `SettingsRoutes → IsRecord` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Services | 1 calls |

## How to Explore

1. `gitnexus_context({name: "writeDetectorDefaults"})` — see callers and callees
2. `gitnexus_query({query: "routes"})` — find related execution flows
3. Read key files listed above for implementation details
