---
name: settings
description: "Skill for the Settings area of signal-console. 35 symbols across 3 files."
---

# Settings

35 symbols | 3 files | Cohesion: 87%

## When to Use

- Working with code in `apps/`
- Understanding how useUpdateDetectorDefaults, useScheduleDetectorDefaults, readStateSpaceFieldValue work
- Modifying settings-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/settings/SettingsPage.tsx` | stableJson, detectorDefaultValueEquals, inferDetectorProfile, parseDetectorProfileId, nextUtcNineAm (+25) |
| `apps/web/src/features/state-space-guided-fields.ts` | readStateSpaceFieldValue, defaultStateSpaceFieldValue, writeStateSpaceFieldValue |
| `apps/web/src/data/queries.ts` | useUpdateDetectorDefaults, useScheduleDetectorDefaults |

## Entry Points

Start here when exploring this area:

- **`useUpdateDetectorDefaults`** (Function) — `apps/web/src/data/queries.ts:730`
- **`useScheduleDetectorDefaults`** (Function) — `apps/web/src/data/queries.ts:769`
- **`readStateSpaceFieldValue`** (Function) — `apps/web/src/features/state-space-guided-fields.ts:451`
- **`defaultStateSpaceFieldValue`** (Function) — `apps/web/src/features/state-space-guided-fields.ts:474`
- **`writeStateSpaceFieldValue`** (Function) — `apps/web/src/features/state-space-guided-fields.ts:478`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useUpdateDetectorDefaults` | Function | `apps/web/src/data/queries.ts` | 730 |
| `useScheduleDetectorDefaults` | Function | `apps/web/src/data/queries.ts` | 769 |
| `readStateSpaceFieldValue` | Function | `apps/web/src/features/state-space-guided-fields.ts` | 451 |
| `defaultStateSpaceFieldValue` | Function | `apps/web/src/features/state-space-guided-fields.ts` | 474 |
| `writeStateSpaceFieldValue` | Function | `apps/web/src/features/state-space-guided-fields.ts` | 478 |
| `stableJson` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 364 |
| `detectorDefaultValueEquals` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 368 |
| `inferDetectorProfile` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 453 |
| `parseDetectorProfileId` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 460 |
| `nextUtcNineAm` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 467 |
| `DetectorDefaultsSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 474 |
| `updateField` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 512 |
| `commitNext` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 537 |
| `updateBaselineMode` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 546 |
| `commit` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 559 |
| `resetField` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 563 |
| `updateStateSpaceText` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 573 |
| `applyStateSpaceConfig` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 585 |
| `updateStateSpaceField` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 593 |
| `resetStateSpaceField` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 610 |

## How to Explore

1. `gitnexus_context({name: "useUpdateDetectorDefaults"})` — see callers and callees
2. `gitnexus_query({query: "settings"})` — find related execution flows
3. Read key files listed above for implementation details
