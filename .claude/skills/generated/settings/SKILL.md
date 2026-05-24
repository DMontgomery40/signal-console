---
name: settings
description: "Skill for the Settings area of signal-console. 20 symbols across 2 files."
---

# Settings

20 symbols | 2 files | Cohesion: 75%

## When to Use

- Working with code in `apps/`
- Understanding how useSettings, useClearCache, SettingsPage work
- Modifying settings-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/settings/SettingsPage.tsx` | humanBytes, formatBytesCell, ExplainDt, DbSection, AboutSection (+12) |
| `apps/web/src/data/queries.ts` | useSettings, useClearCache, useUpdateDetectorDefaults |

## Entry Points

Start here when exploring this area:

- **`useSettings`** (Function) — `apps/web/src/data/queries.ts:327`
- **`useClearCache`** (Function) — `apps/web/src/data/queries.ts:419`
- **`SettingsPage`** (Function) — `apps/web/src/features/settings/SettingsPage.tsx:619`
- **`useUpdateDetectorDefaults`** (Function) — `apps/web/src/data/queries.ts:453`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useSettings` | Function | `apps/web/src/data/queries.ts` | 327 |
| `useClearCache` | Function | `apps/web/src/data/queries.ts` | 419 |
| `SettingsPage` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 619 |
| `useUpdateDetectorDefaults` | Function | `apps/web/src/data/queries.ts` | 453 |
| `humanBytes` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 61 |
| `formatBytesCell` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 71 |
| `ExplainDt` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 84 |
| `DbSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 335 |
| `AboutSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 525 |
| `parseLevelFilter` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 49 |
| `formatTimestamp` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 75 |
| `ExplainHeader` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 94 |
| `sourcesMap` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 388 |
| `SourcesSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 392 |
| `levelClass` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 453 |
| `ErrorsSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 460 |
| `DetectorDefaultsSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 177 |
| `updateField` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 194 |
| `commit` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 203 |
| `resetField` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 222 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `SettingsPage → IsNetworkError` | cross_community | 3 |
| `DbSection → HumanBytes` | intra_community | 3 |
| `AboutSection → HumanBytes` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 2 calls |
| Recent | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useSettings"})` — see callers and callees
2. `gitnexus_query({query: "settings"})` — find related execution flows
3. Read key files listed above for implementation details
