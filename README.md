# Signal Console

Signal Console is a **local trading-desk console for player-prop and market-signal
monitoring**. It ingests betting-market and prediction-market data (Bet365, DraftKings,
FanDuel, Kalshi, Polymarket via Odds-API.io, plus direct Kalshi and an NBA stats sidecar),
runs anomaly detectors over the live board, and surfaces signals through an operator web UI
and a read-only API.

## Source of truth

**`main` is the single source-of-truth branch.** Local `main`, `origin/main`, and the
GitHub default branch all point at the same commit. Treat anything else as not authoritative:

- **Stale local branches, worktrees, and merged/closed PR branches are not authority.**
  They are historical or in-flight and may lag, diverge from, or predate `main`.
- **Unmerged work on an open PR branch is not part of `main`** until it has been
  integrated via a PR that merges into `main`. Such work is tracked on its branch, not
  here, and does not change what `main` is.
- Generated artifacts under `outputs/`, `apps/worker/data/`, and `.claude/tmp/` are local
  scratch/derived state and are not source of truth.

### Repo identity and sibling checkouts

- **`signal-console-mlb` and `signal-console-nfl` are SEPARATE projects**, not branches,
  worktrees, or forks of this repo. Never treat their code, docs, or memory as authority
  here (and vice versa).
- **Any other local `signal-console*` directory or worktree** (e.g. `signal-console-v2`,
  `signal-console-research`, dated copies) maps to THIS repo and is only a checkout of
  some branch/commit of it. Do not let work accumulate there: land it on `main` via a PR,
  then delete the worktree. When in doubt, `git -C <dir> remote -v` decides identity.
- `~/nba-predict` is reference-only historical context (see
  [docs/agent-context.md](docs/agent-context.md)).

### Historical branches (archived 2026-06-09)

The long-lived side branches were reconciled into `main` (PRs #1/#5/#9 plus the
branch-parity consolidation), tagged, and deleted:

- `archive/ralph-signal-console-v2` — the Ralph v2 build branch (fully superseded by
  `main`; its only unique tree content was the deliberately-deleted dead client-recompute
  engine, audit F-002, and generated skill files).
- `archive/preserve-main-statespace-20260529` — the state-space/research-lab preserve
  branch. Its real fixes and docs now live on `main`. It additionally carries the
  **gold-DB sidecar LFS archive** under `archives/gold-db-sidecars-20260603T142044Z/`
  (with `RESTORE.txt`), which is intentionally NOT on `main`; fetch the tag if you need
  that backup.

The current agent/operator context — the live, maintained description of repo reality — is
**[docs/agent-context.md](docs/agent-context.md)**. Read it before making changes.

## Core commands

This is a pnpm + Turborepo monorepo (Node ≥ 22, pnpm ≥ 11). From the repo root:

| Command          | What it does                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`       | `turbo run dev` — run the apps in development                                                                                                                      |
| `pnpm verify`    | Full gate: prettier check, eslint (zero warnings), TypeScript typecheck, workspace typecheck, stale-plan / hex-literal / queries guards, then per-package `verify` |
| `pnpm lint`      | `eslint . --max-warnings=0`                                                                                                                                        |
| `pnpm typecheck` | Root + per-workspace TypeScript typecheck                                                                                                                          |
| `pnpm build`     | `turbo run build`                                                                                                                                                  |

Run `pnpm verify` before finalizing any change; it is the standard quality gate.

## Repository layout

| Path                 | Purpose                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`           | `@signal-console/api` — Fastify 5 API server serving `/v1/*` routes (with `@fastify/swagger`); opens the gold DB read-only.                                            |
| `apps/web`           | `@signal-console/web` — React 19 + Vite 6 + Tailwind operator console (live board, detectors, backtest, research views) using `@tanstack/react-query`.                 |
| `apps/worker`        | `@signal-console/worker` — ingestion/backfill worker that populates the gold DB from betting-market sources (Bet365, Kalshi-direct, Odds-API.io) and emits heartbeats. |
| `apps/nba-sidecar`   | Python 3.12 FastAPI sidecar over `nba_api` (live boxscore / play-by-play / scoreboard); run via `uvicorn`.                                                             |
| `packages/db`        | `@signal-console/db` — SQLite access layer; canonical `openGoldDb()` (read-only) and the writable cache DB + migration runner.                                         |
| `packages/detectors` | `@signal-console/detectors` — detector implementations (`board-mad`, `off-price-print`, `ensemble-or`) and the detector registry.                                      |
| `packages/shared`    | `@signal-console/shared` — shared domain/runtime modules: board-anomaly family (incidents, fanouts, listings, event-context) and the live repository.                  |
| `docs/`              | Project documentation (see below).                                                                                                                                     |

## Data: gold DB is read-only

There are two SQLite databases, with strict and different postures:

- **`data/signal-console.sqlite` is the gold DB and is READ-ONLY.** All API/UI/cache code
  must open it via `openGoldDb()` (`packages/db/src/open.ts`), which enforces read-only four
  independent ways: `file:…?mode=ro` URI, `better-sqlite3 { readonly: true, fileMustExist:
true }`, `PRAGMA query_only=ON`, and a hard throw if `query_only` does not read back as on.
  Never write to it.
- **`data/detector-cache.sqlite` is writable, derived state and is rebuildable.** It is the
  only writable SQLite the API/UI touches (`packages/db/src/cache-migrations/runner.ts`);
  delete-and-rebuild is safe. Reset it with `pnpm cache:reset`.

## Documentation

Start here:

- **[docs/agent-context.md](docs/agent-context.md)** — current agent/operator context (source of truth for repo reality).
- **[docs/live-data-contract.md](docs/live-data-contract.md)** — the live-data contract (quote-tick semantics, sources, watermarks).

Generated (do not hand-edit; regenerated by tooling):

- [docs/generated/repo-map.md](docs/generated/repo-map.md) — checkout map of the repo.
- [docs/generated/docs-freshness.md](docs/generated/docs-freshness.md) — docs freshness report.
- [docs/diagrams/](docs/diagrams/) — Mermaid source diagrams (decoded PNGs in `docs/generated/diagrams/`).

Repo-wide agent/operator conventions live in `CLAUDE.md` and `AGENTS.md`.
