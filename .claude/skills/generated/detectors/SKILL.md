---
name: detectors
description: "Skill for the Detectors area of signal-console. 15 symbols across 2 files."
---

# Detectors

15 symbols | 2 files | Cohesion: 91%

## When to Use

- Working with code in `apps/`
- Understanding how readBoolean work
- Modifying detectors-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/detectors/DetectorsPage.tsx` | isExplainerId, displayParamName, paramExplainerId, MaybeExplain, numberDefault (+9) |
| `apps/web/src/lib/paramsSchema.ts` | readBoolean |

## Entry Points

Start here when exploring this area:

- **`readBoolean`** (Function) — `apps/web/src/lib/paramsSchema.ts:20`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `readBoolean` | Function | `apps/web/src/lib/paramsSchema.ts` | 20 |
| `isExplainerId` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 34 |
| `displayParamName` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 73 |
| `paramExplainerId` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 77 |
| `MaybeExplain` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 81 |
| `numberDefault` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 100 |
| `stringDefault` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 107 |
| `rangeHint` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 111 |
| `NumberField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 118 |
| `EnumField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 141 |
| `BooleanField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 168 |
| `readBooleanDefault` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 192 |
| `ParamRow` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 262 |
| `formatSources` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 310 |
| `DetectorCard` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 314 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Backtest | 2 calls |

## How to Explore

1. `gitnexus_context({name: "readBoolean"})` — see callers and callees
2. `gitnexus_query({query: "detectors"})` — find related execution flows
3. Read key files listed above for implementation details
