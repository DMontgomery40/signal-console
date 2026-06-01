---
name: scripts
description: "Skill for the Scripts area of signal-console. 209 symbols across 14 files."
---

# Scripts

209 symbols | 14 files | Cohesion: 82%

## When to Use

- Working with code in `scripts/`
- Understanding how buildStateSpaceRequestForGame, observations, detectWithPythonStateSpace work
- Modifying scripts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/run-nba-detector-bakeoff.ts` | isStateSpaceAlgo, isoFromSeconds, contextAt, bucketize, getBucket (+108) |
| `scripts/odds-api-io-nba-smoke.ts` | parseArgs, defaultDateRange, safeStamp, coerceWebSocketEventOddsMessages, extractEventIds (+19) |
| `scripts/run-workspace-script.ts` | pythonVenvPython, pythonVenvBin, unique, pythonBootstrapCandidates, isPython312 (+11) |
| `packages/adapters/src/odds-api-io-live-comparator.ts` | readOddsApiIoApiKey, extractOddsApiIoBookmakerNames, verifyOddsApiIoSelectedBookmakers, discoverOddsApiIoNbaLeagueSlugs, buildOddsApiIoWebSocketUrl (+5) |
| `scripts/extract-fixtures.ts` | isRecord, fieldString, fieldNumber, fieldNumberOrNull, fieldBitBool (+5) |
| `scripts/verify-no-stale-plan.ts` | normalizeFile, isAllowListed, parseRipgrepLine, isNoMatchError, runRipgrepOnce (+3) |
| `scripts/verify-queries.ts` | explainQueryPlan, renderPlan, scannedIdentifier, offendingScans, snapshotPath (+3) |
| `scripts/verify-no-hex-literals.ts` | normalizeFile, isAllowListed, parseRipgrepLine, isNoMatchError, runRipgrep (+2) |
| `scripts/verify-product-purpose.ts` | projectSlug, repoFile, productPurposeCheckedFiles, verifyProductPurpose, main |
| `scripts/run-nba-detector-bakeoff.test.ts` | isRecord, isParsedStateSpaceRequest |

## Entry Points

Start here when exploring this area:

- **`buildStateSpaceRequestForGame`** (Function) — `scripts/run-nba-detector-bakeoff.ts:2060`
- **`observations`** (Function) — `scripts/run-nba-detector-bakeoff.ts:2067`
- **`detectWithPythonStateSpace`** (Function) — `scripts/run-nba-detector-bakeoff.ts:2203`
- **`bucketStartKey`** (Function) — `scripts/run-nba-detector-bakeoff.ts:2216`
- **`readOddsApiIoApiKey`** (Function) — `packages/adapters/src/odds-api-io-live-comparator.ts:102`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `buildStateSpaceRequestForGame` | Function | `scripts/run-nba-detector-bakeoff.ts` | 2060 |
| `observations` | Function | `scripts/run-nba-detector-bakeoff.ts` | 2067 |
| `detectWithPythonStateSpace` | Function | `scripts/run-nba-detector-bakeoff.ts` | 2203 |
| `bucketStartKey` | Function | `scripts/run-nba-detector-bakeoff.ts` | 2216 |
| `readOddsApiIoApiKey` | Function | `packages/adapters/src/odds-api-io-live-comparator.ts` | 102 |
| `extractOddsApiIoBookmakerNames` | Function | `packages/adapters/src/odds-api-io-live-comparator.ts` | 240 |
| `verifyOddsApiIoSelectedBookmakers` | Function | `packages/adapters/src/odds-api-io-live-comparator.ts` | 263 |
| `discoverOddsApiIoNbaLeagueSlugs` | Function | `packages/adapters/src/odds-api-io-live-comparator.ts` | 316 |
| `loadRuntimeEnv` | Function | `packages/shared/src/env.ts` | 51 |
| `buildMarketOutlierResults` | Function | `scripts/run-nba-detector-bakeoff.ts` | 2706 |
| `summarizeAlgorithm` | Function | `scripts/run-nba-detector-bakeoff.ts` | 2859 |
| `buildOddsApiIoWebSocketUrl` | Function | `packages/adapters/src/odds-api-io-live-comparator.ts` | 132 |
| `createInitialOddsApiIoWebSocketState` | Function | `packages/adapters/src/odds-api-io-live-comparator.ts` | 173 |
| `buildRuntimeStateSpaceAlgorithms` | Function | `scripts/run-nba-detector-bakeoff.ts` | 1242 |
| `buildMarketOutlierEpisodes` | Function | `scripts/run-nba-detector-bakeoff.ts` | 2600 |
| `offendingScans` | Function | `scripts/verify-queries.ts` | 184 |
| `openGoldDb` | Function | `packages/db/src/open.ts` | 26 |
| `productPurposeCheckedFiles` | Function | `scripts/verify-product-purpose.ts` | 44 |
| `verifyProductPurpose` | Function | `scripts/verify-product-purpose.ts` | 61 |
| `redactOddsApiIoUrl` | Function | `packages/adapters/src/odds-api-io-live-comparator.ts` | 106 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `DetectWithPythonStateSpace → Median` | cross_community | 7 |
| `DetectWithRobustBaseline → Median` | cross_community | 6 |
| `Run → RuntimeFormulaFromDefaults` | cross_community | 5 |
| `Run → RuntimeRationaleFromDefaults` | cross_community | 5 |
| `DetectWithPythonStateSpace → ContextAt` | intra_community | 5 |
| `Run → IsRecord` | cross_community | 4 |
| `Run → SchedulePathFor` | cross_community | 4 |
| `Run → WriteJsonAtomic` | cross_community | 4 |
| `Run → DetectorDefaultsEqual` | cross_community | 4 |
| `DetectWithRobustBaseline → ContextAt` | intra_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_146 | 2 calls |
| Services | 1 calls |

## How to Explore

1. `gitnexus_context({name: "buildStateSpaceRequestForGame"})` — see callers and callees
2. `gitnexus_query({query: "scripts"})` — find related execution flows
3. Read key files listed above for implementation details
