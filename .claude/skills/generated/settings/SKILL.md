---
name: settings
description: "Skill for the Settings area of signal-console. 26 symbols across 2 files."
---

# Settings

26 symbols | 2 files | Cohesion: 76%

## When to Use

- Working with code in `apps/`
- Understanding how useUpdateDetectorDefaults, useScheduleDetectorDefaults work
- Modifying settings-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/web/src/features/settings/SettingsPage.tsx` | inferDetectorProfile, parseDetectorProfileId, nextUtcNineAm, DetectorDefaultsSection, updateField (+19) |
| `apps/web/src/data/queries.ts` | useUpdateDetectorDefaults, useScheduleDetectorDefaults |

## Entry Points

Start here when exploring this area:

- **`useUpdateDetectorDefaults`** (Function) — `apps/web/src/data/queries.ts:524`
- **`useScheduleDetectorDefaults`** (Function) — `apps/web/src/data/queries.ts:563`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useUpdateDetectorDefaults` | Function | `apps/web/src/data/queries.ts` | 524 |
| `useScheduleDetectorDefaults` | Function | `apps/web/src/data/queries.ts` | 563 |
| `inferDetectorProfile` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 402 |
| `parseDetectorProfileId` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 409 |
| `nextUtcNineAm` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 416 |
| `DetectorDefaultsSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 423 |
| `updateField` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 446 |
| `chooseProfile` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 501 |
| `parseLevelFilter` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 98 |
| `formatTimestamp` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 124 |
| `ExplainHeader` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 143 |
| `sourcesMap` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 814 |
| `SourcesSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 818 |
| `levelClass` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 879 |
| `ErrorsSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 886 |
| `humanBytes` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 110 |
| `formatBytesCell` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 120 |
| `ExplainDt` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 133 |
| `DbSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 761 |
| `AboutSection` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 951 |

## How to Explore

1. `gitnexus_context({name: "useUpdateDetectorDefaults"})` — see callers and callees
2. `gitnexus_query({query: "settings"})` — find related execution flows
3. Read key files listed above for implementation details
