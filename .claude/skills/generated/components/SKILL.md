---
name: components
description: "Skill for the Components area of signal-console. 42 symbols across 10 files."
---

# Components

42 symbols | 10 files | Cohesion: 76%

## When to Use

- Working with code in `apps/`
- Understanding how useDetectors, useSettings, useClearCache work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/ui/src/components/RotaryDial.tsx` | clampValue, roundToStep, maybeSnap, triggerSnapTransition, triggerChipFlash (+13) |
| `apps/web/src/App.tsx` | CrashOnRender, readPath, activeLabelFor, routeKey, routeContent (+2) |
| `apps/web/src/data/queries.ts` | useDetectors, useSettings, useClearCache |
| `apps/web/src/components/ErrorBoundary.tsx` | ErrorBoundary, messageOf, FallbackPanel |
| `apps/web/src/components/ApiUnreachableBanner.tsx` | isNetworkError, ApiUnreachableBanner |
| `apps/web/src/components/QueryErrorBanner.tsx` | messageOf, QueryErrorBanner |
| `apps/web/src/features/detectors/DetectorsPage.tsx` | HowToAddPanel, DetectorsPage |
| `apps/web/src/router.ts` | parseGameId, parseLiveId |
| `packages/ui/src/components/ExplainerCard.tsx` | isDev, ExplainerCard |
| `apps/web/src/features/settings/SettingsPage.tsx` | SettingsPage |

## Entry Points

Start here when exploring this area:

- **`useDetectors`** (Function) — `apps/web/src/data/queries.ts:389`
- **`useSettings`** (Function) — `apps/web/src/data/queries.ts:396`
- **`useClearCache`** (Function) — `apps/web/src/data/queries.ts:490`
- **`isNetworkError`** (Function) — `apps/web/src/components/ApiUnreachableBanner.tsx:6`
- **`ApiUnreachableBanner`** (Function) — `apps/web/src/components/ApiUnreachableBanner.tsx:20`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `useDetectors` | Function | `apps/web/src/data/queries.ts` | 389 |
| `useSettings` | Function | `apps/web/src/data/queries.ts` | 396 |
| `useClearCache` | Function | `apps/web/src/data/queries.ts` | 490 |
| `isNetworkError` | Function | `apps/web/src/components/ApiUnreachableBanner.tsx` | 6 |
| `ApiUnreachableBanner` | Function | `apps/web/src/components/ApiUnreachableBanner.tsx` | 20 |
| `QueryErrorBanner` | Function | `apps/web/src/components/QueryErrorBanner.tsx` | 19 |
| `DetectorsPage` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 426 |
| `SettingsPage` | Function | `apps/web/src/features/settings/SettingsPage.tsx` | 1045 |
| `parseGameId` | Function | `apps/web/src/router.ts` | 23 |
| `parseLiveId` | Function | `apps/web/src/router.ts` | 38 |
| `App` | Function | `apps/web/src/App.tsx` | 79 |
| `handlePop` | Function | `apps/web/src/App.tsx` | 83 |
| `ErrorBoundary` | Function | `apps/web/src/components/ErrorBoundary.tsx` | 37 |
| `triggerSnapTransition` | Function | `packages/ui/src/components/RotaryDial.tsx` | 222 |
| `triggerChipFlash` | Function | `packages/ui/src/components/RotaryDial.tsx` | 231 |
| `commit` | Function | `packages/ui/src/components/RotaryDial.tsx` | 240 |
| `onMove` | Function | `packages/ui/src/components/RotaryDial.tsx` | 269 |
| `onWheel` | Function | `packages/ui/src/components/RotaryDial.tsx` | 291 |
| `handleKeyDown` | Function | `packages/ui/src/components/RotaryDial.tsx` | 302 |
| `handleChipClick` | Function | `packages/ui/src/components/RotaryDial.tsx` | 347 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RotaryDial → CompassDegFromValue` | intra_community | 4 |
| `RotaryDial → RoundToStep` | cross_community | 4 |
| `RotaryDial → MaybeSnap` | cross_community | 4 |
| `RotaryDial → ClampValue` | cross_community | 4 |
| `RotaryDial → TriggerSnapTransition` | cross_community | 4 |
| `SettingsPage → IsNetworkError` | intra_community | 3 |
| `RecentPage → IsNetworkError` | cross_community | 3 |
| `RecentPage → MessageOf` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Settings | 5 calls |
| Live | 2 calls |
| Games | 1 calls |
| Backtest | 1 calls |
| Recent | 1 calls |
| Detectors | 1 calls |

## How to Explore

1. `gitnexus_context({name: "useDetectors"})` — see callers and callees
2. `gitnexus_query({query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
