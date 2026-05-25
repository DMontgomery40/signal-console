---
name: dev
description: "Skill for the Dev area of signal-console. 15 symbols across 1 files."
---

# Dev

15 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `scripts/`
- Understanding how resolvePort, printUsage, parseCommand work
- Modifying dev-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `scripts/dev/run.ts` | resolvePort, printUsage, parseCommand, devSpecs, runForeground (+10) |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `resolvePort` | Function | `scripts/dev/run.ts` | 20 |
| `printUsage` | Function | `scripts/dev/run.ts` | 30 |
| `parseCommand` | Function | `scripts/dev/run.ts` | 49 |
| `devSpecs` | Function | `scripts/dev/run.ts` | 65 |
| `runForeground` | Function | `scripts/dev/run.ts` | 89 |
| `killChild` | Function | `scripts/dev/run.ts` | 122 |
| `startDev` | Function | `scripts/dev/run.ts` | 128 |
| `stopAll` | Function | `scripts/dev/run.ts` | 142 |
| `spawnDaemon` | Function | `scripts/dev/run.ts` | 167 |
| `startDaemon` | Function | `scripts/dev/run.ts` | 190 |
| `status` | Function | `scripts/dev/run.ts` | 205 |
| `stop` | Function | `scripts/dev/run.ts` | 233 |
| `main` | Function | `scripts/dev/run.ts` | 266 |
| `spawnManaged` | Function | `scripts/dev/run.ts` | 108 |
| `children` | Function | `scripts/dev/run.ts` | 139 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → ResolvePort` | intra_community | 4 |
| `Main → KillChild` | intra_community | 4 |

## How to Explore

1. `gitnexus_context({name: "resolvePort"})` — see callers and callees
2. `gitnexus_query({query: "dev"})` — find related execution flows
3. Read key files listed above for implementation details
