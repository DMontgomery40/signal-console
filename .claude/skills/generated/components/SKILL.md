---
name: components
description: "Skill for the Components area of signal-console. 33 symbols across 7 files."
---

# Components

33 symbols | 7 files | Cohesion: 79%

## When to Use

- Working with code in `packages/`
- Understanding how triggerSnapTransition, triggerChipFlash, commit work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/ui/src/components/RotaryDial.tsx` | clampValue, roundToStep, maybeSnap, triggerSnapTransition, triggerChipFlash (+13) |
| `apps/web/src/App.tsx` | readPath, activeLabelFor, routeKey, App, handlePop |
| `apps/web/src/components/ErrorBoundary.tsx` | ErrorBoundary, messageOf, FallbackPanel |
| `packages/ui/src/components/ExplainerCard.tsx` | isDev, ExplainerCard |
| `apps/web/src/components/ApiUnreachableBanner.tsx` | isNetworkError, ApiUnreachableBanner |
| `apps/web/src/features/detectors/DetectorsPage.tsx` | HowToAddPanel, DetectorsPage |
| `apps/web/src/data/queries.ts` | useDetectors |

## Entry Points

Start here when exploring this area:

- **`triggerSnapTransition`** (Function) — `packages/ui/src/components/RotaryDial.tsx:206`
- **`triggerChipFlash`** (Function) — `packages/ui/src/components/RotaryDial.tsx:215`
- **`commit`** (Function) — `packages/ui/src/components/RotaryDial.tsx:224`
- **`onMove`** (Function) — `packages/ui/src/components/RotaryDial.tsx:253`
- **`onWheel`** (Function) — `packages/ui/src/components/RotaryDial.tsx:275`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `triggerSnapTransition` | Function | `packages/ui/src/components/RotaryDial.tsx` | 206 |
| `triggerChipFlash` | Function | `packages/ui/src/components/RotaryDial.tsx` | 215 |
| `commit` | Function | `packages/ui/src/components/RotaryDial.tsx` | 224 |
| `onMove` | Function | `packages/ui/src/components/RotaryDial.tsx` | 253 |
| `onWheel` | Function | `packages/ui/src/components/RotaryDial.tsx` | 275 |
| `handleKeyDown` | Function | `packages/ui/src/components/RotaryDial.tsx` | 286 |
| `handleChipClick` | Function | `packages/ui/src/components/RotaryDial.tsx` | 331 |
| `ExplainerCard` | Function | `packages/ui/src/components/ExplainerCard.tsx` | 69 |
| `RotaryDial` | Function | `packages/ui/src/components/RotaryDial.tsx` | 158 |
| `handleTickClick` | Function | `packages/ui/src/components/RotaryDial.tsx` | 324 |
| `App` | Function | `apps/web/src/App.tsx` | 79 |
| `handlePop` | Function | `apps/web/src/App.tsx` | 83 |
| `ErrorBoundary` | Function | `apps/web/src/components/ErrorBoundary.tsx` | 37 |
| `useDetectors` | Function | `apps/web/src/data/queries.ts` | 320 |
| `isNetworkError` | Function | `apps/web/src/components/ApiUnreachableBanner.tsx` | 6 |
| `ApiUnreachableBanner` | Function | `apps/web/src/components/ApiUnreachableBanner.tsx` | 20 |
| `DetectorsPage` | Function | `apps/web/src/features/detectors/DetectorsPage.tsx` | 394 |
| `ticks` | Function | `packages/ui/src/components/RotaryDial.tsx` | 181 |
| `clampValue` | Function | `packages/ui/src/components/RotaryDial.tsx` | 59 |
| `roundToStep` | Function | `packages/ui/src/components/RotaryDial.tsx` | 66 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RotaryDial → CompassDegFromValue` | intra_community | 4 |
| `RotaryDial → RoundToStep` | cross_community | 4 |
| `RotaryDial → MaybeSnap` | cross_community | 4 |
| `RotaryDial → ClampValue` | cross_community | 4 |
| `RotaryDial → TriggerSnapTransition` | cross_community | 4 |
| `SettingsPage → IsNetworkError` | cross_community | 3 |
| `RecentPage → IsNetworkError` | cross_community | 3 |
| `App → NavigateTo` | cross_community | 3 |
| `DetectorsPage → IsNetworkError` | intra_community | 3 |
| `DetectorsPage → MessageOf` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Live | 1 calls |
| Cluster_77 | 1 calls |
| Recent | 1 calls |
| Detectors | 1 calls |

## How to Explore

1. `gitnexus_context({name: "triggerSnapTransition"})` — see callers and callees
2. `gitnexus_query({query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
