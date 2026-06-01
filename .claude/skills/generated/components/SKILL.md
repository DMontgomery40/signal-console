---
name: components
description: "Skill for the Components area of signal-console. 33 symbols across 5 files."
---

# Components

33 symbols | 5 files | Cohesion: 83%

## When to Use

- Working with code in `packages/`
- Understanding how parseGameId, parseLiveId, App work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/ui/src/components/RotaryDial.tsx` | clampValue, roundToStep, maybeSnap, triggerSnapTransition, triggerChipFlash (+13) |
| `apps/web/src/App.tsx` | CrashOnRender, readPath, activeLabelFor, routeKey, routeContent (+3) |
| `apps/web/src/components/ErrorBoundary.tsx` | ErrorBoundary, messageOf, FallbackPanel |
| `apps/web/src/router.ts` | parseGameId, parseLiveId |
| `packages/ui/src/components/ExplainerCard.tsx` | isDev, ExplainerCard |

## Entry Points

Start here when exploring this area:

- **`parseGameId`** (Function) — `apps/web/src/router.ts:23`
- **`parseLiveId`** (Function) — `apps/web/src/router.ts:38`
- **`App`** (Function) — `apps/web/src/App.tsx:85`
- **`handlePop`** (Function) — `apps/web/src/App.tsx:89`
- **`navigate`** (Function) — `apps/web/src/App.tsx:98`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `parseGameId` | Function | `apps/web/src/router.ts` | 23 |
| `parseLiveId` | Function | `apps/web/src/router.ts` | 38 |
| `App` | Function | `apps/web/src/App.tsx` | 85 |
| `handlePop` | Function | `apps/web/src/App.tsx` | 89 |
| `navigate` | Function | `apps/web/src/App.tsx` | 98 |
| `ErrorBoundary` | Function | `apps/web/src/components/ErrorBoundary.tsx` | 37 |
| `triggerSnapTransition` | Function | `packages/ui/src/components/RotaryDial.tsx` | 234 |
| `triggerChipFlash` | Function | `packages/ui/src/components/RotaryDial.tsx` | 243 |
| `commit` | Function | `packages/ui/src/components/RotaryDial.tsx` | 252 |
| `onMove` | Function | `packages/ui/src/components/RotaryDial.tsx` | 281 |
| `onWheel` | Function | `packages/ui/src/components/RotaryDial.tsx` | 303 |
| `handleKeyDown` | Function | `packages/ui/src/components/RotaryDial.tsx` | 314 |
| `handleChipClick` | Function | `packages/ui/src/components/RotaryDial.tsx` | 359 |
| `ExplainerCard` | Function | `packages/ui/src/components/ExplainerCard.tsx` | 69 |
| `RotaryDial` | Function | `packages/ui/src/components/RotaryDial.tsx` | 165 |
| `handleTickClick` | Function | `packages/ui/src/components/RotaryDial.tsx` | 352 |
| `ticks` | Function | `packages/ui/src/components/RotaryDial.tsx` | 192 |
| `CrashOnRender` | Function | `apps/web/src/App.tsx` | 27 |
| `readPath` | Function | `apps/web/src/App.tsx` | 31 |
| `activeLabelFor` | Function | `apps/web/src/App.tsx` | 36 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RotaryDial → CompassDegFromValue` | intra_community | 4 |
| `RotaryDial → RoundToStep` | cross_community | 4 |
| `RotaryDial → MaybeSnap` | cross_community | 4 |
| `RotaryDial → ClampValue` | cross_community | 4 |
| `RotaryDial → TriggerSnapTransition` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Data | 3 calls |
| Live | 2 calls |
| Games | 1 calls |
| Backtest | 1 calls |
| Recent | 1 calls |

## How to Explore

1. `gitnexus_context({name: "parseGameId"})` — see callers and callees
2. `gitnexus_query({query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
