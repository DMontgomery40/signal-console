# Codex memory — signal-console

Last verified: 2026-06-09

Per-repo persistent notes for the Codex agent. Update entries when they become stale; date entries when context decays fast.

---

## Authority + repo identity (2026-06-09)

`main` is the only living branch; the long-lived side branches
(`ralph/signal-console-v2`, `preserve/main-statespace-20260529`) were reconciled
into `main`, archived as `archive/*` tags, and deleted. Do not resurrect them as
working branches; fetch the tags only for history or the gold-DB LFS archive
(preserve tag only).

`signal-console-mlb` and `signal-console-nfl` are SEPARATE projects — never
current Signal Console authority, in either direction. Any other local
`signal-console*` directory or git worktree (e.g. `signal-console-v2`,
`signal-console-research`) is a checkout of THIS repo: land its work on `main`
via PR, then delete the worktree. `git -C <dir> remote -v` decides identity.

Sibling-project memory paths such as AnalogLabor, `nba-predict`,
`signal-console-mlb`, or `signal-console-nfl` are not current Signal Console
authority. The root `PRD.md` and the PRD-driven Ralph loop are historical
context, not the controlling spec (the 2026-05-31 authority cleanup on the
preserve branch retired them; `main` keeps the files for history).

## Math home architecture (decided 2026-05-25, not yet implemented)

When the codebase grows beyond NBA (NFL, NCAA, PGA, etc.), numerical/derived state will be split across four named buckets, not unified into one registry. This was decided after a multi-round design conversation comparing the proposal against the ragweld experience.

The four buckets:

- **`packages/math`** — pure formulas, units, probability transforms, MAD, vig, kelly, sport-specific calculations. Answers *"how is this number computed?"*. Filed by concept-per-sport (`math/nba/board-volatility.ts`, `math/nfl/win-probability.ts`), NOT one mega-file per sport. Must remain pure: no I/O, no mutation, no config reads. Enforced by `eslint-plugin-functional` (already deployed for `packages/detectors` at `eslint.config.js:113-122` — extend the same block to `packages/math/**`).
- **`packages/detectors`** — detector orchestration, params, cache-facing run shapes. Imports from `packages/math`. Today this package contains both pure formulas and orchestration; the split is to pull formulas out into `math/`, leaving detectors as the thin orchestration layer.
- **`packages/calibration`** (new) — generated empirical baselines and bakeoff-derived constants WITH PROVENANCE. Answers *"where did this measured number come from?"*. Every exported value must carry: `value + sport + detector/version + source dataset + generation command/run id + generatedAt`. Never hand-edited. Emitted only by `scripts/run-*-bakeoff.ts`. The producer is part of the taxonomy — the rule "nothing in calibration is hand-edited" is what makes the provenance loop mechanical instead of discipline-dependent.
- **`packages/domain`** (exists) — API/domain schemas and bounded-context language. Can import math constants but doesn't own math.

Operator settings (mutable runtime config) are a fourth category answering *"what did the operator choose right now?"* — they live with the detector/settings layer, not in math or calibration.

### Why this shape (not "everything in one math registry")

Previous attempt in ragweld unified types + params + behavior + config into 4 Pydantic registries; only 1 got used consistently, the discipline broke down. The literature predicts that failure: Sandi Metz "the wrong abstraction", Fowler/Evans on shared kernels, Atwood's Rule of Three. The salvageable instinct is "pure calculations have one home" (Bernhardt's Functional Core / Imperative Shell, Normand's Calculations/Actions/Data) — NOT "all numerical knowledge has one home." Splitting by knowledge *type* (pure math vs measured-with-provenance vs operator-tunable vs schema) is what makes the pattern durable.

### Enforcement (boring and narrow, not universal)

- `eslint-plugin-functional` for purity in `packages/math/**` (already deployed for detectors).
- Custom verify scripts in `scripts/verify-*.ts` (existing pattern: `verify-no-hex-literals.ts`, `verify-no-stale-plan.ts`). A future `verify-calibration-provenance.ts` should scan `packages/calibration/**` for the required generated-by header and ban matching empirical-constant symbol patterns from other packages.
- Do NOT add a blanket "no numeric literal exports outside math" rule — that goes noisy fast. Start narrower: ban detector thresholds/calibration constants outside approved packages.

### First test case

`packages/shared/src/board-volatility-baselines.ts:57-66` defines `FALLBACK_BASELINES` — hand-written p50/p75/p90/p99 per phase kind with zero provenance, currently in the wrong package. This is the canonical first thing to move into `packages/calibration` with a proper provenance header.

### Staging rule (very important — do not skip)

Do NOT write the math/calibration/settings/domain framing into `CLAUDE.md` or `AGENTS.md` until at least one concept (start with `FALLBACK_BASELINES`) has actually been moved through the new boundaries and the cuts have held in practice. Writing the law before the test case is the documented ragweld failure mode. Once one concept is through cleanly, the framing earns its place in the durable docs.

The three-question framing is the durable bit, worth keeping verbatim:
- math: *how is this number computed?*
- calibration: *where did this measured number come from?*
- settings: *what did the operator choose right now?*

(domain: *what shapes move between layers?*)

---

## NBA data stack — already correct, not a wrapper

`apps/nba-sidecar` is a thin FastAPI service that uses Python `nba_api` (`>=1.11.4,<2` per `pyproject.toml`) directly via `from nba_api.live.nba.endpoints import boxscore, playbyplay, scoreboard` and `from nba_api.stats.endpoints import scoreboardv3`. It is NOT a hand-rolled wrapper of `nbastatR` (which is R-only and unusable from this stack). The 366-line `normalizers.py` is doing project-specific schema translation from `nba_api` payload shape into signal-console's domain shape — no community library exists for that and one shouldn't.

The TS `packages/adapters/{kalshi,polymarket,bet365,odds-api}` are BETTING-MARKET adapters, not NBA stat sources — different category, no community wrapper exists for those vendors either.

## Live/PBP contract (implemented 2026-06-07)

`/v1/live/:gameId` is not raw ticks only. It returns bounded market ticks plus an
`activity` object with replay-scoped game state and official PBP. The activity
path reads `game_states` and `nba_pbp_revisions` at or before the request
`windowEnd` so historical `at=` replay does not leak final score or later
official PBP corrections.

NBA PBP now carries `sub_type`, `person_id`, and `player_name`. The worker
writes the latest row to `nba_play_by_play_actions` and writes changed snapshots
to `nba_pbp_revisions`; `listPbpAttributionTransitions` reports credited-player
or subtype corrections. Durable docs for this contract live in
`docs/live-data-contract.md`.

Settings source freshness now comes from successful live `adapter_runs`
(`capture_mode = 'live'`), not `MAX(quote_ticks.captured_at)`. Historical
backfill and discovery runs must set `capture_mode` explicitly so they do not
pretend a source is live-fresh.

## State-space tunables (implemented 2026-05-28)

The board-volatility runtime no longer treats the Python sidecar's inner filter coefficients as invisible code literals. Advanced model terms now live in a structured `stateSpace` object (`packages/detectors/src/board-mad/state-space-config.ts`) that flows through:

- detector params / backtest payloads
- detector defaults JSON (`data/detector-defaults.json`)
- `/v1/settings` and `/settings`
- Backtest's advanced JSON editor
- the Python sidecar request contract

This is the current sanctioned home for trigger-shape coefficients, breadth normalization, observation-embedding terms (including cross-source directional disagreement), anchor floors, process-noise terms, observation-noise weights, and variance-adaptation limits.

## Bakeoff runtime row (implemented 2026-05-28)

The NBA detector bakeoff now evaluates the actual live Python board runtime as first-class rows derived from detector defaults, not only the older TypeScript research comparators. `scripts/run-nba-detector-bakeoff.ts` builds:

- a current-live row from `readDetectorDefaults()` / `data/detector-defaults.json`
- a packaged-baseline row from `BASELINE_DEFAULTS` when it differs

Those rows carry the full nested `stateSpace` object in the machine-readable payload and call the Python sidecar contract instead of re-implementing the filter math in TypeScript. The operator-facing reference doc for this contract is `docs/board-volatility-state-space.md`.
