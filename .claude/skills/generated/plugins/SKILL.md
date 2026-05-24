---
name: plugins
description: "Skill for the Plugins area of signal-console. 3 symbols across 1 files."
---

# Plugins

3 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `apps/`
- Understanding how pathFromUrl, authPlugin, readExpectedToken work
- Modifying plugins-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/api/src/plugins/auth.ts` | pathFromUrl, authPlugin, readExpectedToken |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `pathFromUrl` | Function | `apps/api/src/plugins/auth.ts` | 29 |
| `authPlugin` | Function | `apps/api/src/plugins/auth.ts` | 34 |
| `readExpectedToken` | Function | `apps/api/src/plugins/auth.ts` | 41 |

## How to Explore

1. `gitnexus_context({name: "pathFromUrl"})` — see callers and callees
2. `gitnexus_query({query: "plugins"})` — find related execution flows
3. Read key files listed above for implementation details
