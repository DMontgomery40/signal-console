# Signal Console Core Purpose

Signal Console is for one expensive NBA trading problem: a live data feed can credit the wrong player, or correct a play later, while player props and game props are still being priced. A rebound, assist, block, or point can land under the wrong name, and exposed markets may keep trading against that bad state. Signal Console watches market movement around those moments so bet365 can review or suspend affected markets before bad trades turn into bad payouts.

The mistake rarely stays inside one bet. If a rebound is credited to the wrong player, it can touch that player's props, the player who should have received credit, combo markets, team rebounds, quarter markets, and game-level prices. Sometimes the official correction arrives late. Sometimes it never arrives in a way that changes settlement. The useful warning is simpler: the board is behaving as if something around the play deserves a closer look.

## In-Flight Architectural Notes

Before designing changes to numerical state (formulas, constants, baselines, thresholds, calibration data) or proposing a new package layout, read `.codex/memory.md`. It contains the current architectural direction being staged (math/calibration/detectors/domain split, provenance rules for empirical constants, enforcement plan) plus the staging rule that says these are not yet codified here. Update `.codex/memory.md` when the direction shifts; only promote framings to this file after at least one real concept has moved through the new boundaries.

## Project Memory Policy

Use only Signal Console memory as repo authority:

- `.codex/memory.md`
- `~/.codex/projects/-Users-davidmontgomery-signal-console/MEMORY.md`

Do not use sibling-project memory paths, old `nba-predict` memory, or global memory summaries as current Signal Console authority.

## Odds-API.io Live Comparator Policy

Odds-API.io is the preferred live sportsbook/prediction-market comparator when its feed covers the required sport, bookmaker, market family, and player-prop depth. It is a distinct provider surface from the older `api.the-odds-api.com/v4` API; do not mix endpoint shapes, auth assumptions, source IDs, or adapter names without explicit migration proof.

Before designing or editing Odds-API.io ingestion, fetch `https://docs.odds-api.io/llms.txt`; fetch `https://docs.odds-api.io/llms-full.txt`, `https://docs.odds-api.io/guides/websockets`, `https://docs.odds-api.io/guides/prediction-markets`, `https://docs.odds-api.io/examples/player-props`, and `https://docs.odds-api.io/api-reference/openapi.json` when implementation details matter.

The current selected-bookmaker spine for this account is `Bet365,DraftKings,FanDuel,Kalshi,Polymarket`. Verify it with `GET /bookmakers/selected?apiKey=...` before relying on it in a proof run. Credential lookup for this provider is `ODDSAPI_API_KEY`, then `ODDS_API_KEY`, then `ODDS_API_IO_KEY`; never write the key into evidence artifacts.

For live odds, build WebSocket-first against `wss://api.odds-api.io/v3/ws` with `markets=ML,Spread,Totals,Player Props` for NBA smoke/proof work. Do not create live quote polling loops when the Odds-API.io WebSocket supports the needed stream. REST is acceptable for initial snapshots, health/readiness checks, historical/backfill work, and gap repair after `resync_required`; when REST is used for fresh deltas, use `GET /odds/updated?since=...` rather than repeated full `/odds` or `/odds/multi` polling.

Player-prop and prediction-market coverage must be proven from real provider responses for the exact sport/league/event/bookmaker set before product-ready claims. The docs say the unified `/v3/odds` shape can include Bet365, DraftKings, FanDuel, Kalshi, Polymarket, and player props, but docs alone are not completion evidence. Kalshi is a special case: this repo already ingests Kalshi NBA player props from the direct Kalshi API, while Odds-API.io docs and live payloads may lag that surface. Keep direct Kalshi as the authoritative Kalshi player-prop path until Odds-API.io proves equivalent Kalshi player-prop coverage in live payloads; do not treat missing Odds-API.io Kalshi props as missing Kalshi props overall.

For TypeScript workers, evaluate the official `odds-api-io` Node SDK before hand-rolling REST calls for sports/events/odds/bookmaker selection/updated odds. The WebSocket replay/reconnect implementation currently appears in the SDK repo examples on `feat/websocket-reconnect-replay`, not as a stable exported library API, so treat it as a reference pattern to port or pin deliberately, with tests around `seq`, `lastSeq`, `resync_required`, raw-payload persistence, and replay gaps. The durable NBA runbook and repeatable smoke command live in `docs/odds-api-io-live-comparator.md`; update it when the provider contract or proof path changes.

## Change Inventory Checklist

Before making any product tweak, first write a short inventory of every surface that might need to move. Keep it scoped to the change, but do not skip a category because the request sounds small. For each category, either make the change or explicitly mark it "checked, no change".

- **Runtime behavior:** detector math, params schema/defaults, recompute paths, cache keys, persisted DB reads/writes, migrations, API request/response schemas, route OpenAPI metadata, adapter/worker ingestion, health/readiness behavior, and source-watermark or cache invalidation logic.
- **UI surfaces:** route/page copy, component labels, aria labels/value text, empty/loading/error states, control ranges/defaults/snap labels, keyboard behavior, visible units, hover explainer copy, settings rows, detector registry labels, timelines/charts, screenshots or visual snapshots, and responsive layout.
- **Explainers:** every hover explainer entry in `packages/ui/src/explainers.ts` that names the concept, its units, defaults, math, tradeoff, or canonical code reference. These are product copy, not decorative tooltips.
- **Docs:** `README.md`, `PLAN.md`, active `docs/*.md`, active `specs/*.md`, handoffs, and operator runbooks. Do not use `.docs-archive/` or the retired root `PRD.md` as live authority, but update active docs when behavior, commands, env, API, UX, or source coverage changes.
- **Tests:** add behavior-level coverage for the user-facing contract and the broader bug/change family. Prefer UI/API/integration or contract tests over line-coupled unit tests. Include stale-label searches with `rg` for old terms, labels, env names, endpoint names, and source names.
- **Video/demo assets:** if the feature appears in the Signal Console video project, check `~/markdown-video-experiment/projects/signal-console-explainer/plan.json`, draft plans, narration text, generated still prompts, screenshots, clips, and final-render notes. Redo only the affected scenes/assets. Edit generated stills when that is honest; recapture screenshots/screen recordings when the actual UI is visible.
- **Generated or built output:** if `dist`, generated OpenAPI, screenshots, reports, or packaged assets are regenerated, verify they still match source and do not reintroduce retired wording.
- **Operational handoff:** update any handoff prompt or checklist that another agent/operator would follow. Include exact env names, file paths, commands, ports, verification commands, and rollback notes when relevant.

For a new external source or API such as FanDuel or DraftKings, the inventory must also cover: endpoint scorecard, auth/env/secrets docs, adapter boundaries, raw payload persistence, source identity, market/instrument mapping, quote tick semantics, volume/open-interest fields, rate limits/backoff, direct-API diagnostics versus persisted coverage, settings/admin visibility, health/readiness, detector/backtest/live/recent exposure, source filters, fixture coverage, integration tests, and operator docs. If any part is pending because live persisted data is not wired yet, say "pending" rather than inventing a fallback.

End every mutating turn by running the narrow changed-surface tests plus the repo verify command when available. Before finalizing, run `rg` for retired terms and exact source/API names so small copy changes do not leave stale labels behind.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **signal-console** (8562 symbols, 14051 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
