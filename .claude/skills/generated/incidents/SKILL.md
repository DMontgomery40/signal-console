---
name: incidents
description: "Skill for the Incidents area of signal-console. 21 symbols across 2 files."
---

# Incidents

21 symbols | 2 files | Cohesion: 73%

## When to Use

- Working with code in `apps/`
- Understanding how useCreateKnownCase work
- Modifying incidents-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/incidents/KnownCasesPage.tsx` | clean, formPayload, canSubmit, Field, ClaimField (+15) |
| `apps/web/src/data/queries.ts` | useCreateKnownCase |

## Entry Points

Start here when exploring this area:

- **`useCreateKnownCase`** (Function) — `apps/web/src/data/queries.ts:591`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useCreateKnownCase` | Function | `apps/web/src/data/queries.ts` | 591 |
| `clean` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 65 |
| `formPayload` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 70 |
| `canSubmit` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 92 |
| `Field` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 171 |
| `ClaimField` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 205 |
| `IncidentForm` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 231 |
| `update` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 240 |
| `incidentWindow` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 114 |
| `isWithinIncidentWindow` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 128 |
| `replayWindowEndIso` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 135 |
| `bucketStartForAnchor` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 141 |
| `eventBucket` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 147 |
| `tickSourceCounts` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 162 |
| `ReplayStatus` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 425 |
| `IncidentReplay` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 449 |
| `formatTime` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 53 |
| `caseGameId` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 60 |
| `originLabel` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 103 |
| `caseStatusLabel` | Function | `apps/web/src/features/incidents/KnownCasesPage.tsx` | 107 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `IncidentReplay → LiveQuery` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Live | 4 calls |
| Data | 3 calls |
| Games | 2 calls |
| Backtest | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useCreateKnownCase"})` — see callers and callees
2. `gitnexus_query({query: "incidents"})` — find related execution flows
3. Read key files listed above for implementation details
