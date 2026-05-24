---
name: detectors
description: "Skill for the Detectors area of signal-console. 14 symbols across 2 files."
---

# Detectors

14 symbols | 2 files | Cohesion: 81%

## When to Use

- Working with code in `apps/`
- Understanding how readBoolean work
- Modifying detectors-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/detectors/DetectorsPage.tsx` | numberDefault, stringDefault, rangeHint, NumberField, EnumField (+8) |
| `apps/web/src/lib/paramsSchema.ts` | readBoolean |

## Entry Points

Start here when exploring this area:

- **`readBoolean`** (Function) — `apps/web/src/lib/paramsSchema.ts:20`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `readBoolean` | Function | `apps/web/src/lib/paramsSchema.ts` | 20 |
| `numberDefault` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 56 |
| `stringDefault` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 63 |
| `rangeHint` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 67 |
| `NumberField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 74 |
| `EnumField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 97 |
| `BooleanField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 124 |
| `readBooleanDefault` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 148 |
| `UnknownField` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 152 |
| `ParamRow` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 168 |
| `isExplainerId` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 34 |
| `MaybeExplain` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 37 |
| `formatSources` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 214 |
| `DetectorCard` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 218 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DetectorCard → ReadBoolean` | cross_community | 5 |
| `DetectorCard → IsRecord` | cross_community | 4 |
| `DetectorCard → ReadString` | cross_community | 4 |
| `DetectorCard → ReadNumber` | cross_community | 4 |
| `DetectorCard → ReadStringArray` | cross_community | 4 |
| `DetectorCard → RangeHint` | cross_community | 4 |
| `DetectorCard → NumberDefault` | cross_community | 4 |
| `DetectorCard → StringDefault` | cross_community | 4 |
| `DetectorCard → IsExplainerId` | intra_community | 3 |
| `DetectorCard → UnknownField` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Backtest | 1 calls |

## How to Explore

1. `gitnexus_context({name: "readBoolean"})` — see callers and callees
2. `gitnexus_query({query: "detectors"})` — find related execution flows
3. Read key files listed above for implementation details
