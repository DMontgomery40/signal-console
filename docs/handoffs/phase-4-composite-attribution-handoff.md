# Handoff: Fully Build Out Moniac Phase 4 (Composite Board×Attribution)

**Branch:** `claude/moniac-pipeline-branch-xpx7uh` on `DMontgomery40/signal-console` (continue here unless instructed otherwise).
**Date written:** 2026-06-10.

## STATUS — 2026-06-10, build complete; real-data proof run pending (operator)

Both gaps below are CLOSED on `claude/phase-4-handoff-1qu8qg` (continued from this
branch's tip after the remote `claude/phase-4-handoff-1qu8qg` session branch was
designated for the work):

- `player_prop_ticks.parquet` export: adopted the parity-consolidation port
  (`--control-ticks N`, explicit `missing` coverage rows, catalog + contract-test
  coverage) onto this lineage.
- Rebound-event/candidate snapshot representation: **raw `pbp_actions.parquet`**
  (exact far-calibration gold-DB column set) instead of the draft's derived
  bucket-indexed table — candidate derivation stays in the tested Python path
  (`candidates.rebound_candidates` + oncourt), and `load_attribution_inputs`
  buckets events against the same board-prediction frame the producer consumes.
- `write_composite_predictions` loads real inputs; board-only degradation now
  triggers only on genuinely missing tables (reason printed).
- Verified: sidecar 304 passed / 19 gold-gated skips, compileall, prettier,
  eslint, scripts tsc, stale-plan + citation guards, web 186 passed,
  api 202 passed, ui 90 passed. `packages/research-truth` `game-data.test.ts`
  fails only where the gold DB is absent (by design).

**Remaining: the real proof run needs the operator's gold DB.**

```bash
# 1. Fresh snapshot with the new tables (control sample sized for FAR work too):
GOLD_DB_PATH=~/signal-console/data/signal-console.sqlite \
  pnpm quant:export -- --control-ticks 40 --snapshot-id phase4-proof

# 2. Composite predictions (board virtual_source_state_space x signed-paired):
SNAP=outputs/nba-quant-lab/snapshots/phase4-proof
cd apps/nba-sidecar && uv run --extra research python -m \
  nba_sidecar.research.experiments.composite_attribution \
  --snapshot "../../$SNAP" --out ../../outputs/nba-quant-lab/external/composite_attribution/predictions.parquet
cd ../..
# Expect the "composite attribution inputs: N rebound events bucketed ..." line,
# NOT the BOARD-ONLY warning. BOARD-ONLY on a fresh export is a bug — report it.

# 3. Score into a run dir + leaderboard row:
pnpm quant score-predictions \
  outputs/nba-quant-lab/external/composite_attribution/predictions.parquet \
  "$SNAP" --model-id composite_attribution

# 4. (Optional sweep) --strategy weighted_sum|gate|max and --fire-threshold.
```

If the candidate still scores 0/15 recall at low burden on real data, that is a
reportable result, not a failure to hide. Rollback: revert the three commits on
the branch tip; old snapshots keep working (the producer degrades loudly).

## Read this first: the plan is source material, not gospel

The original plan in `docs/moniac-pipeline-plan-and-code-draft.md` was written by an
inferior codex model. The repo owner has explicitly said it must NOT be taken as
gospel. In particular, the draft's "copy-first execution rule" (use its code blocks
verbatim, justify every deviation) is **waived by the user**. You are expected to
exercise your own judgment: if you see a better architecture, data path, contract,
or test strategy than the draft describes, take it — just document what you changed
and why in your commit message. The draft is useful for its inventory of surfaces,
its fixture list, and its Definition of Done; its code shapes and mechanics are
suggestions only.

What is NOT waivable (these are honesty contracts already enforced in the shipped
code and tests, keep them whatever path you choose):

- Absence of paired attribution signal contributes `0.0` to the composite — never
  `0.5`. Negative drift is not positive evidence.
- Abstention support classes (`ok`, `rightful_only`, `credited_only`,
  `insufficient_support`) stay explicit end-to-end (currently the `pairedSupport`
  column); never convert an abstention into fabricated signal.
- The attribution layer fails open: if its inputs are missing, the board layer
  keeps operating and the producer says so loudly.
- Never invent snapshot fixtures and present them as real provider/DB data. If a
  data path isn't wired, say "pending" — do not fabricate a fallback.
- Exactly one prediction row per board bucket; per-game hysteresis state is
  isolated across games.

## Where things stand (verified on the branch)

- Phases 1–3 are done and pushed: `1c15a00` (virtual_source_state_space candidate
  model), `a1dddd8` (Pareto front + ECE calibration diagnostics).
- Phase 4's **non-gated scaffold** is done and pushed in `aedd814`:
  - `apps/nba-sidecar/src/nba_sidecar/research/experiments/composite_attribution.py`
    — pure composition strategies (`product`, `weighted_sum`, `gate`, `max`),
    one-sided paired-score normalization, per-game hysteresis trigger, and a
    `CompositeAttributionProducer.build_predictions(...)` that takes board
    predictions + `events_by_bucket` + `ticks_by_game_player` and emits one row
    per board bucket.
  - `apps/nba-sidecar/tests/test_composite_attribution.py` — 25 hermetic tests
    over strategies, normalization, support-class preservation, multi-event
    buckets, warmup gating, hysteresis enter/sustain/exit, two-game isolation.
  - `docs/quant-researcher-guide.md` (~lines 233–246) documents the producer +
    `pnpm quant score-predictions` commands with a pending-fixture caveat.
- It is deliberately an **external `predictions.parquet` producer** scored via
  `pnpm quant score-predictions` — NOT a registered `BoardModel` — because it
  needs prop ticks, candidate pairs, and event anchors outside the bucket
  contract. `write_composite_predictions` currently degrades to board-only
  composition with an explicit "BOARD-ONLY, not a Phase 4 result" warning because
  two data inputs do not exist yet.

## The two real gaps (this is the actual work)

1. **`player_prop_ticks.parquet` is not in the snapshot.** The sidecar loader
   contract already exists and is strict
   (`apps/nba-sidecar/src/nba_sidecar/research/loader.py` —
   `read_player_prop_ticks`, file constant at line ~35), but
   `scripts/export-quant-snapshot.ts` writes only 7 tables (games,
   board_observations, market_outlier_episodes, incidents, score_windows,
   source_coverage, + manifest) and has zero prop-tick output. Extend the
   exporter (and its manifest) to write `player_prop_ticks.parquet` from the
   gold DB. First, re-verify whether anything else produces this file today —
   `attribution-eval` / `far-calibration` CLI paths consume it via the loader, so
   find out how existing snapshots (if any) got it, or whether those paths are
   also fixture-only right now.
2. **No bucket-indexed rebound-event/candidate table.** Per test game you need
   rebound events keyed by `(game_id, bucket_start)` with `event_epoch`, credited
   player, candidate player ids, and on-court context. The raw material likely
   already exists in the repo's PBP attribution surfaces — start from
   `scripts/backfill-pbp-attribution.ts`, `scripts/capture-pbp-revisions.ts`,
   `apps/nba-sidecar/src/nba_sidecar/research/candidates.py`, and
   `attribution_snapshot.py`, plus the DB schema — but the snapshot
   representation, its name, and its schema are **yours to design**. The draft
   sketches one; you are free to do better (e.g. you may decide a joined
   event+candidate long table beats two tables, or that the existing candidates
   path can be reused directly).

## Definition of Done (adapted from the draft; deviate with reasons)

- Exporter writes the new table(s) + `player_prop_ticks.parquet`, listed in the
  snapshot manifest.
- `write_composite_predictions` loads real inputs through the snapshot loaders;
  the board-only degradation path remains but only triggers on genuinely missing
  data.
- Fixture coverage (hermetic, no gold DB needed): support classes, multi-event
  bucket, two-game interleaving, and a small snapshot fixture exercising the new
  exporter tables end-to-end through `score-predictions`. Check
  `scripts/extract-fixtures.ts` for the existing fixture-extraction convention
  before inventing a new one.
- `pnpm quant score-predictions <out> <snap> --model-id composite_attribution`
  produces a run dir + leaderboard row; `/research` Leaderboard renders
  `composite_attribution` beside `robust_mad`, `state_space_current`,
  `virtual_source_state_space` without replacing any row (update
  `apps/web/src/features/research/__tests__/ResearchPage.test.tsx` fixtures).
  Model lab stays registered-`BoardModel`-only unless you decide an
  external-producer registry is genuinely better.
- Do not register `composite_attribution` in `nba_sidecar.research.models` unless
  you conclude a formal `BoardModel` contract extension is the better path — the
  draft forbids it; you may override that with explicit reasoning.
- Docs: remove the pending-fixture caveat from `docs/quant-researcher-guide.md`
  once real; touch `docs/nba-quant-lab.md`, `docs/research-menu.md`, and
  `packages/ui/src/explainers.ts` only if UI copy changes. State clearly that
  this is offline Research evidence, not live suspend behavior.

## Environment constraint — plan the proof run as an operator handback

The gold DB lives only on the operator's machine; remote sessions cannot run a
real `pnpm quant:export`. Build everything to be hermetically verifiable (the
exporter change can be tested against a fixture DB or unit-level), and end your
session with exact copy-paste commands for the operator to run the real snapshot
export + composite scoring locally. If the candidate still scores 0/15 recall at
low burden on real data, that is a reportable result, not a failure to hide.

## Process requirements (repo rules, not optional)

- Follow the CLAUDE.md Change Inventory Checklist; run GitNexus impact analysis
  before editing existing symbols (especially `export-quant-snapshot.ts` writers
  and the loader module) and `gitnexus_detect_changes()` before committing.
- Verify gate used by the prior commits, match it: sidecar pytest (full suite,
  was 291 passing), `python -m compileall`, prettier, `pnpm` citation and
  stale-plan guards, plus the narrow changed-surface TS tests
  (`research.test.ts`, `ResearchPage.test.tsx`). Run `rg` for retired terms
  before finalizing.
- Commit per coherent step with descriptive messages; push with
  `git push -u origin claude/moniac-pipeline-branch-xpx7uh`. Do not create a PR
  unless asked.
