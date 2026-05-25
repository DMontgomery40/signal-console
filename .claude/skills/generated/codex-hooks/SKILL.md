---
name: codex-hooks
description: "Skill for the Codex-hooks area of signal-console. 26 symbols across 1 files."
---

# Codex-hooks

26 symbols | 1 files | Cohesion: 71%

## When to Use

- Working with code in `packages/`
- Understanding how applyStopEvent, buildBugfixPolicyContext, detectBugfixIntent work
- Modifying codex-hooks-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | buildEmptyState, readState, summarizeMissingCoverage, shouldGateStop, buildStopReason (+21) |

## Entry Points

Start here when exploring this area:

- **`applyStopEvent`** (Function) — `packages/shared/src/codex-hooks/bugfix-regression-guard.ts:425`
- **`buildBugfixPolicyContext`** (Function) — `packages/shared/src/codex-hooks/bugfix-regression-guard.ts:136`
- **`detectBugfixIntent`** (Function) — `packages/shared/src/codex-hooks/bugfix-regression-guard.ts:146`
- **`applyUserPromptEvent`** (Function) — `packages/shared/src/codex-hooks/bugfix-regression-guard.ts:370`
- **`classifyBashCommand`** (Function) — `packages/shared/src/codex-hooks/bugfix-regression-guard.ts:174`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `applyStopEvent` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 425 |
| `buildBugfixPolicyContext` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 136 |
| `detectBugfixIntent` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 146 |
| `applyUserPromptEvent` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 370 |
| `classifyBashCommand` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 174 |
| `applyPostToolUseEvent` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 388 |
| `extractPatchedFiles` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 155 |
| `isTestPath` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 169 |
| `buildEmptyState` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 119 |
| `readState` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 226 |
| `summarizeMissingCoverage` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 344 |
| `shouldGateStop` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 358 |
| `buildStopReason` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 362 |
| `slugPath` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 184 |
| `resolveRepoRoot` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 188 |
| `resolveStateRoot` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 206 |
| `resolveStatePath` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 213 |
| `writeState` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 247 |
| `deleteState` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 257 |
| `readStdinJson` | Function | `packages/shared/src/codex-hooks/bugfix-regression-guard.ts` | 475 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ApplyPostToolUseEvent → ResolveRepoRoot` | cross_community | 4 |
| `ApplyPostToolUseEvent → ResolveStateRoot` | cross_community | 4 |
| `ApplyPostToolUseEvent → SlugPath` | cross_community | 4 |
| `ApplyStopEvent → ResolveRepoRoot` | cross_community | 4 |
| `ApplyStopEvent → ResolveStateRoot` | cross_community | 4 |
| `ApplyStopEvent → SlugPath` | cross_community | 4 |
| `ApplyPostToolUseEvent → BuildEmptyState` | cross_community | 3 |
| `ApplyPostToolUseEvent → ExtractPatchedFiles` | cross_community | 3 |
| `ApplyPostToolUseEvent → PushUnique` | cross_community | 3 |
| `ApplyPostToolUseEvent → IsTestPath` | cross_community | 3 |

## How to Explore

1. `gitnexus_context({name: "applyStopEvent"})` — see callers and callees
2. `gitnexus_query({query: "codex-hooks"})` — find related execution flows
3. Read key files listed above for implementation details
