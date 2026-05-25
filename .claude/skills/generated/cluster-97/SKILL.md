---
name: cluster-97
description: "Skill for the Cluster_97 area of signal-console. 13 symbols across 2 files."
---

# Cluster_97

13 symbols | 2 files | Cohesion: 93%

## When to Use

- Working with code in `apps/`
- Understanding how buildNbaSidecarUrl, buildNbaSidecarDateWindow, fetchNbaSidecarScoreboard work
- Modifying cluster_97-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/worker/src/nba-sidecar.ts` | trimTrailingSlash, buildNbaSidecarUrl, formatDateUtc, parseScore, deriveFinalSidecarResultFromPlayByPlay (+7) |
| `apps/worker/src/backfill.ts` | runNba |

## Entry Points

Start here when exploring this area:

- **`buildNbaSidecarUrl`** (Function) — `apps/worker/src/nba-sidecar.ts:92`
- **`buildNbaSidecarDateWindow`** (Function) — `apps/worker/src/nba-sidecar.ts:179`
- **`fetchNbaSidecarScoreboard`** (Function) — `apps/worker/src/nba-sidecar.ts:201`
- **`fetchNbaSidecarPlayByPlay`** (Function) — `apps/worker/src/nba-sidecar.ts:230`
- **`ingestNbaSidecarScoreboard`** (Function) — `apps/worker/src/nba-sidecar.ts:257`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `buildNbaSidecarUrl` | Function | `apps/worker/src/nba-sidecar.ts` | 92 |
| `buildNbaSidecarDateWindow` | Function | `apps/worker/src/nba-sidecar.ts` | 179 |
| `fetchNbaSidecarScoreboard` | Function | `apps/worker/src/nba-sidecar.ts` | 201 |
| `fetchNbaSidecarPlayByPlay` | Function | `apps/worker/src/nba-sidecar.ts` | 230 |
| `ingestNbaSidecarScoreboard` | Function | `apps/worker/src/nba-sidecar.ts` | 257 |
| `ingestNbaSidecarPlayByPlay` | Function | `apps/worker/src/nba-sidecar.ts` | 287 |
| `syncNbaSidecarScoreboard` | Function | `apps/worker/src/nba-sidecar.ts` | 311 |
| `syncNbaSidecarWindow` | Function | `apps/worker/src/nba-sidecar.ts` | 356 |
| `runNba` | Function | `apps/worker/src/backfill.ts` | 137 |
| `trimTrailingSlash` | Function | `apps/worker/src/nba-sidecar.ts` | 88 |
| `formatDateUtc` | Function | `apps/worker/src/nba-sidecar.ts` | 106 |
| `parseScore` | Function | `apps/worker/src/nba-sidecar.ts` | 110 |
| `deriveFinalSidecarResultFromPlayByPlay` | Function | `apps/worker/src/nba-sidecar.ts` | 119 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RunBackfill → TrimTrailingSlash` | cross_community | 7 |
| `RunBackfill → FormatDateUtc` | cross_community | 6 |
| `RunBackfill → IngestNbaSidecarScoreboard` | cross_community | 5 |
| `SyncNbaSidecarScoreboard → TrimTrailingSlash` | intra_community | 4 |

## How to Explore

1. `gitnexus_context({name: "buildNbaSidecarUrl"})` — see callers and callees
2. `gitnexus_query({query: "cluster_97"})` — find related execution flows
3. Read key files listed above for implementation details
