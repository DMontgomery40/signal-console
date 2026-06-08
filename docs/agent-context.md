# Agent Context

Last verified: 2026-06-07
Repository: `/Users/davidmontgomery/signal-console`
Branch at bootstrap: `main`
HEAD at bootstrap: `e2b070e99801`

Use this file as the repo-local current-reality note for agents. Keep it aligned with verified facts as work happens.

## Current Reality

- Project purpose: Signal Console is a local trading-desk console for player-prop and market-signal monitoring. It serves small, recent slices from the moved gold SQLite store, exposes live game/PBP activity and detector views, and keeps detector/backtest work reproducible without writing through the API/UI path.
- Primary runtime or framework: pnpm workspace on Node 22+ with TypeScript, Fastify 5 API, React 19/Vite 6/Tailwind web app, Vitest, Turbo, and a Python 3.12 FastAPI `nba_api` sidecar.
- Main entry points: `apps/api/src/server.ts`, `apps/api/src/services/live.ts`, `apps/web/src/main.tsx`, `apps/web/src/features/live/LivePage.tsx`, `apps/worker/src/index.ts`, `apps/worker/src/backfill.ts`, `apps/worker/src/nba-sidecar.ts`, `apps/nba-sidecar/src/nba_sidecar/`, `packages/shared/src/live-repository.ts`, `packages/db/src/sport-views.ts`, and repo scripts in `package.json` plus `scripts/`.
- External services, APIs, or data sources: local gold SQLite at `data/signal-console.sqlite`, writable detector cache at `data/detector-cache.sqlite`, direct Kalshi/Polymarket/Bet365 adapters, Odds-API.io comparator work, and NBA stats/live/PBP payloads through the Python sidecar.
- Deployment or release path: local-only compute by default. Use `pnpm dev` for API/web/worker development and the existing Cloudflare tunnel only when the operator intentionally exposes the local service.
- In-flight integration (branch `integrate/research-lab-onto-main-20260608`, PR #9): the NBA miscredit-attribution research lab (sidecar `research/` re-ranker + FAR + separation + confluence, harvester scripts, `/v1/research/attribution` API + ResearchPage portal, `harvestMiscreditLabels` in `live-repository`) is being integrated onto `main`, with audit fixes F-007 (detector Source-subset comment), F-008 (board-volatility `sourceMarkets` -> `contributingSourceKeys`), F-011 (verify-citations guard), F-012 (`resolveOddsApiKey` honors the preferred `ODDSAPI_API_KEY`), and F-009 (collapse the redundant `BoardGameStateVolatility` aliases — drop `state`/`headlineScore`, keep `band`/`score`). F-010 (board-anomaly cluster only half-wired) is left as a documented open finding: a root-cause+debugger pass found the cluster is partly live via `normalizeBoardText`, so removal is unsafe, and with no live games (offseason) the quiet unwired path is harmless; revisit wire-vs-rewrite later.

## Commands

- `verify`: `pnpm verify`
- `lint`: `pnpm lint`
- `typecheck`: `pnpm typecheck`
- `build`: `pnpm build`
- `dev`: `pnpm dev`

## Architecture Notes

- Generated checkout map: [generated/repo-map.md](generated/repo-map.md)
- Mermaid diagram inventory: [diagrams/README.md](diagrams/README.md)
- Live/PBP contract: [live-data-contract.md](live-data-contract.md)
- Important source directories: `apps/api`, `apps/web`, `apps/worker`, `apps/nba-sidecar`, `packages/db`, `packages/detectors`, `packages/domain`, `packages/shared`, `packages/ui`, and `packages/adapters`.
- Important generated or ignored directories: `docs/generated`, `docs/generated/diagrams`, `outputs`, `apps/worker/data`, and SQLite sidecar files under `data/`.
- Cross-repo dependencies or sibling checkouts: `~/nba-predict` is reference-only historical context; `~/markdown-video-experiment/projects/signal-console-explainer` can contain video/demo assets that need targeted updates when visible Signal Console surfaces change.

## Required Diagrams

- Minimum diagram sources: [diagrams/repo-overview.mmd](diagrams/repo-overview.mmd), [diagrams/live-data-flow.mmd](diagrams/live-data-flow.mmd), [diagrams/pbp-revision-model.mmd](diagrams/pbp-revision-model.mmd), and [diagrams/docs-refresh-gate.mmd](diagrams/docs-refresh-gate.mmd)
- Rendered PNG outputs: [generated/diagrams/](generated/diagrams/)
- Diagram scope decision: one diagram is acceptable only for simple repos; add architecture, data-flow, state, deployment, user-flow, integration, or memory/rules diagrams when one diagram hides meaningful surfaces.
- Validation command: `python3 /Users/davidmontgomery/.agents/skills/agents-context-bootstrap/scripts/bootstrap_agent_context.py --repo . --validate-mermaid`

## Contracts And Data

- Inputs: quote ticks, source-market metadata, market microstructure events, NBA play-by-play/game-state payloads with player attribution, PBP revision snapshots, adapter run records with capture mode, detector defaults, operator parameters, and provider-specific comparator payloads.
- Outputs: typed API responses under `/v1/*`, React operator views, detector/backtest/cache rows, generated evidence under `outputs/`, generated repo context under `docs/generated/`, and Mermaid PNG renders.
- Persistent storage: the gold DB is `data/signal-console.sqlite` and must be opened read-only from API/UI/cache paths; `data/detector-cache.sqlite` is the writable derived-state cache and is safe to rebuild.
- Public interfaces: Fastify API routes, especially `/v1/live/:gameId`, TanStack Query hooks in the web app, detector registry contracts, worker/backfill commands, and the Odds-API.io smoke command documented in [odds-api-io-live-comparator.md](odds-api-io-live-comparator.md).
- Live contract: `/v1/live/:gameId` returns bounded market ticks plus replay-scoped `activity` from `game_states` and `nba_pbp_revisions`; it is not a raw-ticks-only endpoint. See [live-data-contract.md](live-data-contract.md).
- Worker freshness contract: Settings freshness comes from successful live `adapter_runs`, not quote-tick scans; historical/discovery work must set `capture_mode` explicitly.
- Compatibility constraints: do not mix Odds-API.io with the older `api.the-odds-api.com/v4` API; keep direct Kalshi player props authoritative until Odds-API.io proves equivalent live payload coverage; keep the staged math/calibration/domain split in `.codex/memory.md` until a real concept has moved through those boundaries.

## Agent Gotchas

- Stale docs or memories to distrust: `.docs-archive/` is historical only, and old `~/nba-predict` architecture should not be treated as the current runtime contract.
- Common false assumptions: `apps/nba-sidecar` uses Python `nba_api` directly and is not an `nbastatR` wrapper; the TypeScript adapters are betting-market adapters, not NBA stats adapters; K values are compute parameters, not gold-DB dimensions; `/v1/live/:gameId` includes official game/PBP activity and should not be treated as raw ticks only.
- Local setup requirements: Node 22+, pnpm 11+, Python 3.12 for the sidecar, local SQLite data files under `data/`, and provider keys supplied through documented environment variables rather than committed artifacts.
- Known unrelated failures: the worktree may contain local research outputs, screenshots, SQLite WAL/SHM files, and in-progress product changes; preserve unrelated dirty files unless the user explicitly asks for cleanup.

## Verification Policy

- Standard full gate: run `pnpm verify` before ending mutating work when available.
- Narrow changed-surface checks: run the affected package tests first, such as `pnpm --filter @signal-console/api verify`, `pnpm --filter @signal-console/web verify`, `pnpm --filter @signal-console/worker verify`, sidecar `python -m pytest`, or a targeted script under `scripts/`.
- Browser or manual checks: use the local dev server and browser screenshots for visible web changes; for Odds-API.io proof work, run `pnpm smoke:odds-api-io:nba` and keep redacted evidence under `outputs/odds-api-io-live-comparator/`.
- What to record when verification is blocked: exact command, exit status, relevant error text, whether the blocker is unrelated to the change, and the smallest remaining command that would close the gap.

## Staleness Triggers

Update this file when package managers, commands, architecture, data contracts, deployment flow, environment variables, or major product assumptions change.
