---
name: scripts
description: "Skill for the Scripts area of signal-console. 112 symbols across 8 files."
---

# Scripts

112 symbols | 8 files | Cohesion: 90%

## When to Use

- Working with code in `scripts/`
- Understanding how offendingScans, openGoldDb, fetch_pbp work
- Modifying scripts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/run-nba-detector-bakeoff.ts` | isRecord, readJsonRecord, unknownRows, readIncidents, parseIsoSeconds (+55) |
| `scripts/run-workspace-script.ts` | pythonVenvPython, pythonVenvBin, unique, pythonBootstrapCandidates, isPython312 (+11) |
| `scripts/extract-fixtures.ts` | isRecord, fieldString, fieldNumber, fieldNumberOrNull, fieldBitBool (+5) |
| `scripts/verify-no-stale-plan.ts` | normalizeFile, isAllowListed, parseRipgrepLine, isNoMatchError, runRipgrepOnce (+3) |
| `scripts/verify-queries.ts` | explainQueryPlan, renderPlan, scannedIdentifier, offendingScans, snapshotPath (+3) |
| `scripts/verify-no-hex-literals.ts` | normalizeFile, isAllowListed, parseRipgrepLine, isNoMatchError, runRipgrep (+2) |
| `scripts/backfill-pbp.py` | fetch_pbp, main |
| `packages/db/src/open.ts` | openGoldDb |

## Entry Points

Start here when exploring this area:

- **`offendingScans`** (Function) — `scripts/verify-queries.ts:184`
- **`openGoldDb`** (Function) — `packages/db/src/open.ts:26`
- **`fetch_pbp`** (Function) — `scripts/backfill-pbp.py:22`
- **`main`** (Function) — `scripts/backfill-pbp.py:30`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `offendingScans` | Function | `scripts/verify-queries.ts` | 184 |
| `openGoldDb` | Function | `packages/db/src/open.ts` | 26 |
| `fetch_pbp` | Function | `scripts/backfill-pbp.py` | 22 |
| `main` | Function | `scripts/backfill-pbp.py` | 30 |
| `isRecord` | Function | `scripts/run-nba-detector-bakeoff.ts` | 636 |
| `readJsonRecord` | Function | `scripts/run-nba-detector-bakeoff.ts` | 640 |
| `unknownRows` | Function | `scripts/run-nba-detector-bakeoff.ts` | 645 |
| `readIncidents` | Function | `scripts/run-nba-detector-bakeoff.ts` | 691 |
| `parseIsoSeconds` | Function | `scripts/run-nba-detector-bakeoff.ts` | 702 |
| `isoFromSeconds` | Function | `scripts/run-nba-detector-bakeoff.ts` | 707 |
| `clampProbability` | Function | `scripts/run-nba-detector-bakeoff.ts` | 752 |
| `logit` | Function | `scripts/run-nba-detector-bakeoff.ts` | 756 |
| `numberOrNull` | Function | `scripts/run-nba-detector-bakeoff.ts` | 791 |
| `rowString` | Function | `scripts/run-nba-detector-bakeoff.ts` | 799 |
| `loadGameWindows` | Function | `scripts/run-nba-detector-bakeoff.ts` | 812 |
| `loadPairs` | Function | `scripts/run-nba-detector-bakeoff.ts` | 896 |
| `loadMicro` | Function | `scripts/run-nba-detector-bakeoff.ts` | 959 |
| `buildGameData` | Function | `scripts/run-nba-detector-bakeoff.ts` | 1010 |
| `rankAlgorithmSummaries` | Function | `scripts/run-nba-detector-bakeoff.ts` | 1478 |
| `buildReportMarkdown` | Function | `scripts/run-nba-detector-bakeoff.ts` | 1490 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Run → IsRecord` | intra_community | 4 |
| `Run → UnknownRows` | intra_community | 4 |
| `Run → RowString` | intra_community | 4 |
| `Run → ParseIsoSeconds` | intra_community | 4 |

## How to Explore

1. `gitnexus_context({name: "offendingScans"})` — see callers and callees
2. `gitnexus_query({query: "scripts"})` — find related execution flows
3. Read key files listed above for implementation details
