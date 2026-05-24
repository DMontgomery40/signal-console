---
name: scripts
description: "Skill for the Scripts area of signal-console. 33 symbols across 5 files."
---

# Scripts

33 symbols | 5 files | Cohesion: 91%

## When to Use

- Working with code in `scripts/`
- Understanding how openGoldDb work
- Modifying scripts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/extract-fixtures.ts` | isRecord, fieldString, fieldNumber, fieldNumberOrNull, fieldBitBool (+5) |
| `scripts/verify-no-stale-plan.ts` | normalizeFile, isAllowListed, parseRipgrepLine, isNoMatchError, runRipgrepOnce (+3) |
| `scripts/verify-no-hex-literals.ts` | normalizeFile, isAllowListed, parseRipgrepLine, isNoMatchError, runRipgrep (+2) |
| `scripts/verify-queries.ts` | isUpdateMode, main, explainQueryPlan, renderPlan, offendingScans (+2) |
| `packages/db/src/open.ts` | openGoldDb |

## Entry Points

Start here when exploring this area:

- **`openGoldDb`** (Function) — `packages/db/src/open.ts:26`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `openGoldDb` | Function | `packages/db/src/open.ts` | 26 |
| `isRecord` | Function | `scripts/extract-fixtures.ts` | 88 |
| `fieldString` | Function | `scripts/extract-fixtures.ts` | 92 |
| `fieldNumber` | Function | `scripts/extract-fixtures.ts` | 100 |
| `fieldNumberOrNull` | Function | `scripts/extract-fixtures.ts` | 108 |
| `fieldBitBool` | Function | `scripts/extract-fixtures.ts` | 115 |
| `toTick` | Function | `scripts/extract-fixtures.ts` | 122 |
| `ticks` | Function | `scripts/extract-fixtures.ts` | 152 |
| `pbpSpecsExcluding` | Function | `scripts/extract-fixtures.ts` | 174 |
| `normalizeFile` | Function | `scripts/verify-no-stale-plan.ts` | 83 |
| `isAllowListed` | Function | `scripts/verify-no-stale-plan.ts` | 87 |
| `parseRipgrepLine` | Function | `scripts/verify-no-stale-plan.ts` | 100 |
| `isNoMatchError` | Function | `scripts/verify-no-stale-plan.ts` | 122 |
| `runRipgrepOnce` | Function | `scripts/verify-no-stale-plan.ts` | 132 |
| `runRipgrep` | Function | `scripts/verify-no-stale-plan.ts` | 159 |
| `describeAllowList` | Function | `scripts/verify-no-stale-plan.ts` | 174 |
| `main` | Function | `scripts/verify-no-stale-plan.ts` | 183 |
| `normalizeFile` | Function | `scripts/verify-no-hex-literals.ts` | 44 |
| `isAllowListed` | Function | `scripts/verify-no-hex-literals.ts` | 48 |
| `parseRipgrepLine` | Function | `scripts/verify-no-hex-literals.ts` | 59 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → NormalizeFile` | intra_community | 4 |
| `Main → IsNoMatchError` | intra_community | 4 |
| `Main → NormalizeFile` | intra_community | 4 |
| `Main → IsNoMatchError` | intra_community | 3 |
| `Main → ExplainQueryPlan` | cross_community | 3 |
| `Main → OffendingScans` | cross_community | 3 |
| `Main → RenderPlan` | cross_community | 3 |
| `Main → SnapshotPath` | cross_community | 3 |
| `Main → OpenGoldDb` | intra_community | 3 |
| `Main → IsRecord` | cross_community | 3 |

## How to Explore

1. `gitnexus_context({name: "openGoldDb"})` — see callers and callees
2. `gitnexus_query({query: "scripts"})` — find related execution flows
3. Read key files listed above for implementation details
