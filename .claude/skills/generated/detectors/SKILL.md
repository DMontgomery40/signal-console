---
name: detectors
description: "Skill for the Detectors area of signal-console. 16 symbols across 2 files."
---

# Detectors

16 symbols | 2 files | Cohesion: 84%

## When to Use

- Working with code in `apps/`
- Understanding how readBoolean work
- Modifying detectors-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/detectors/DetectorsPage.tsx` | displayParamName, paramExplainerId, numberDefault, stringDefault, rangeHint (+10) |
| `apps/web/src/lib/paramsSchema.ts` | readBoolean |

## Entry Points

Start here when exploring this area:

- **`readBoolean`** (Function) — `apps/web/src/lib/paramsSchema.ts:20`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `readBoolean` | Function | `apps/web/src/lib/paramsSchema.ts` | 20 |
| `displayParamName` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 59 |
| `paramExplainerId` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 63 |
| `numberDefault` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 86 |
| `stringDefault` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 93 |
| `rangeHint` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 97 |
| `NumberField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 104 |
| `EnumField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 127 |
| `BooleanField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 154 |
| `readBooleanDefault` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 178 |
| `UnknownField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 182 |
| `ParamRow` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 198 |
| `isExplainerId` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 34 |
| `MaybeExplain` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 67 |
| `formatSources` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 246 |
| `DetectorCard` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 250 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Backtest | 1 calls |

## How to Explore

1. `gitnexus_context({name: "readBoolean"})` — see callers and callees
2. `gitnexus_query({query: "detectors"})` — find related execution flows
3. Read key files listed above for implementation details
