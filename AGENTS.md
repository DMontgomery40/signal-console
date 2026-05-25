## Change Inventory Checklist

Before making any product tweak, first write a short inventory of every surface that might need to move. Keep it scoped to the change, but do not skip a category because the request sounds small. For each category, either make the change or explicitly mark it "checked, no change".

- **Runtime behavior:** detector math, params schema/defaults, recompute paths, cache keys, persisted DB reads/writes, migrations, API request/response schemas, route OpenAPI metadata, adapter/worker ingestion, health/readiness behavior, and source-watermark or cache invalidation logic.
- **UI surfaces:** route/page copy, component labels, aria labels/value text, empty/loading/error states, control ranges/defaults/snap labels, keyboard behavior, visible units, hover explainer copy, settings rows, detector registry labels, timelines/charts, screenshots or visual snapshots, and responsive layout.
- **Explainers:** every hover explainer entry in `packages/ui/src/explainers.ts` that names the concept, its units, defaults, math, tradeoff, or canonical code reference. These are product copy, not decorative tooltips.
- **Docs:** `README.md`, `PRD.md`, `PLAN.md`, active `docs/*.md`, active `specs/*.md`, handoffs, and operator runbooks. Do not use `.docs-archive/` as live authority, but update active docs when behavior, commands, env, API, UX, or source coverage changes.
- **Tests:** add behavior-level coverage for the user-facing contract and the broader bug/change family. Prefer UI/API/integration or contract tests over line-coupled unit tests. Include stale-label searches with `rg` for old terms, labels, env names, endpoint names, and source names.
- **Video/demo assets:** if the feature appears in the Signal Console video project, check `~/markdown-video-experiment/projects/signal-console-explainer/plan.json`, draft plans, narration text, generated still prompts, screenshots, clips, and final-render notes. Redo only the affected scenes/assets. Edit generated stills when that is honest; recapture screenshots/screen recordings when the actual UI is visible.
- **Generated or built output:** if `dist`, generated OpenAPI, screenshots, reports, or packaged assets are regenerated, verify they still match source and do not reintroduce retired wording.
- **Operational handoff:** update any handoff prompt or checklist that another agent/operator would follow. Include exact env names, file paths, commands, ports, verification commands, and rollback notes when relevant.

For a new external source or API such as FanDuel or DraftKings, the inventory must also cover: endpoint scorecard, auth/env/secrets docs, adapter boundaries, raw payload persistence, source identity, market/instrument mapping, quote tick semantics, volume/open-interest fields, rate limits/backoff, direct-API diagnostics versus persisted coverage, settings/admin visibility, health/readiness, detector/backtest/live/recent exposure, source filters, fixture coverage, integration tests, and operator docs. If any part is pending because live persisted data is not wired yet, say "pending" rather than inventing a fallback.

End every mutating turn by running the narrow changed-surface tests plus the repo verify command when available. Before finalizing, run `rg` for retired terms and exact source/API names so small copy changes do not leave stale labels behind.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **signal-console** (6252 symbols, 10505 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/signal-console/context` | Codebase overview, check index freshness |
| `gitnexus://repo/signal-console/clusters` | All functional areas |
| `gitnexus://repo/signal-console/processes` | All execution flows |
| `gitnexus://repo/signal-console/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
