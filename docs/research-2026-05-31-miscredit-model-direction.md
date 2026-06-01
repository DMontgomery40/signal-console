# Research note — a better model direction for NBA miscredit/correction detection

**Date:** 2026-05-31
**Scope:** the live board-volatility / state-space detector path and the NBA Quant Lab
research platform. Worktrees in scope: `signal-console` (preserve) and
`signal-console-integration` (the shippable unified branch; the Quant Lab lives here).
**Status of claims:** every quantitative claim below is reproduced from a real run on a
real gold-DB snapshot. N is small and is disclosed throughout (see §5).

---

## 1. Surface inventory (what was inspected and why)

Only surfaces where detector math touches runtime behavior were read.

| Surface                                   | Files                                                                                                                                                                                                                                                                                                                                    | Why                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Live filter math (only runtime)           | `apps/nba-sidecar/src/nba_sidecar/volatility.py`, `models.py`                                                                                                                                                                                                                                                                            | The canonical detector. Establishes latent state, observation, fire rule.                                 |
| Detector config/params + bounds           | `packages/detectors/src/board-mad/state-space-config.ts`, `params.ts`, `config.ts`, `state-space-bounds.json`                                                                                                                                                                                                                            | The tunable surface contract a new covariate must satisfy.                                                |
| Board-intensity construction              | `apps/api/src/services/board-volatility-model.ts`, `board.ts`, `board-mad-context.ts`                                                                                                                                                                                                                                                    | Where raw quotes collapse to the scalar series; the granularity question.                                 |
| Defaults/API/backtest/cache               | `data/detector-defaults.json`, `detector-defaults.ts`, `detector-runner.ts`, routes                                                                                                                                                                                                                                                      | Cache identity + version mechanics.                                                                       |
| UI + explainers                           | `SensitivityDial.tsx`, `state-space-guided-fields.ts`, `packages/ui/src/explainers.ts`                                                                                                                                                                                                                                                   | What the product tells the operator the signal _means_.                                                   |
| **NBA Quant Lab** (the home of the slice) | `apps/nba-sidecar/src/nba_sidecar/research/**` (models/base, robust_mad, state_space_current, template; evaluation/scorer, truth, doctor, casebook; loader; contracts/schemas, columns), `packages/research-truth/**`, `scripts/export-quant-snapshot.ts`, `scripts/quant.ts`, `docs/nba-quant-lab.md`, `docs/quant-researcher-guide.md` | The offline, leakage-aware test-bed where candidate models plug in and are scored against incident truth. |

---

## 2. Research note

### 2.1 What the current platform implicitly assumes

The live detector is a **univariate local-level + local-trend Kalman filter on a single
pooled scalar** per 60-second bucket. The observation is
`y_t = log1p(intensity / breadth_normalizer) + disagreementWeight·sourceDisagreement`,
where `intensity = Σ_markets Σ_ticks w(volume)·|Δp|` pooled across **all** market families
in the game. It fires when the standardized innovation `z⁺ ≥ enterOffset + kMad·enterKScale`,
and reports `regimeScore = clamp01(z⁺/enter_z)` as its confidence.

Baked-in assumptions:

1. **The board is one process.** A player-prop spike and a moneyline spike are
   interchangeable contributions to one scalar.
2. **A miscredit produces a _distinctive, detectable_ board shock** — i.e. magnitude
   surprise is a sufficient statistic for "something around a play deserves review."
3. **Confidence is a deterministic function of magnitude** (`regimeScore = z⁺/enter_z`);
   there is no floor coupling confidence to evidence breadth. A single-source spike can
   report `regimeScore ≈ 1`.
4. Breadth/source-trust enter only as a scalar multiplier on the surprise denominator
   (the `sourceTrust` block: `sourceDominancePenalty`, `sourceAgreementBonus`, …) — a soft
   single-source suppressor, but still inside a pure-magnitude detector.

### 2.2 Why those assumptions may be wrong for miscredit/correction risk

The expensive error in this product is the **false positive** (every fire = an operator
reviews/suspends markets) and the **missed incident** (bad state keeps trading). A
miscredit is a _structural_ event — probability mass that should sit on player B's market
is being priced as if it belongs to player A — and its market footprint need not be a large
_board-wide_ move at all. It can be:

- **moderate** (a single prop repricing), not a board-wide shock;
- **feed-shared** — every book consumes the same wrong official feed and all move _together_
  (low cross-source disagreement), so "disagreement" is the wrong tell for the common case;
- **near-zero** — the correction never moved the snapshot-eligible board enough to see.

A pooled-scalar magnitude detector is geometrically blind to all three.

### 2.3 Three candidate directions (meaningfully different)

- **(A) Evidence-breadth-bounded confidence / fail-closed-on-narrow-support.** Keep a robust
  surprise score but _bound confidence_ by a support vector (source_count, active_market_count,
  1−dominance); a narrow single-source spike cannot earn high confidence and is suppressed.
  This is the "Nash-style uncertainty" inspiration done as a hard geometric floor rather than
  an entropy penalty.
- **(B) Attribution-transfer / bipartite player-pair coupling.** Model the miscredit as a
  _transfer_: expected production leaving one player's markets and arriving at another's (or at
  team/"nobody"). Requires per-player (or at least per-market-family) signed decomposition.
- **(C) Disagreement-conjunction / regime model.** Fire only on the conjunction of magnitude
  surprise _and_ elevated cross-source disagreement.

### 2.4 Strongest objection to each

- **Against A:** breadth-awareness is _already_ in the production model (the `sourceTrust`
  block). "Introduce breadth" is not novel; the only novel part is a hard fail-closed floor —
  and if real incidents are narrow/single-source, that floor _removes recall_. (Confirmed
  below — fatal for A-as-detector.)
- **Against B:** the discriminating per-player data is collapsed at snapshot-export time
  (`loader.py:37-47` whitelists 9 board-level columns); a model never sees a player axis.
  Building the full bipartite model now would be theater on absent data.
- **Against C:** a _feed-shared_ miscredit makes all books move together → disagreement is
  **low, not high**. Requiring high disagreement would miss the most common regime.

### 2.5 Empirical adjudication (the experiment that decides it)

Rather than choose from argument, I exported a real snapshot (`slice-eval`: 44 games, 5,676
board-observation buckets, **15 scoreable incidents** across 12 games — the full scoreable
registry — plus 132 tape-outlier episodes) directly from the 31 GB read-only gold DB, ran the
two shipped baselines through the shared evaluator, and characterized the incident windows in
feature space.

**Baseline eval (incident recall over truth-bearing games):**

| Model                              | incident_recall | caught   | fires/game | burden | tape_outlier_recall |
| ---------------------------------- | --------------- | -------- | ---------- | ------ | ------------------- |
| `robust_mad`                       | 0.267           | 4/15     | 16.2       | 389    | 0.629               |
| `state_space_current` (production) | **0.000**       | **0/15** | 2.25       | 54     | 0.220               |

**The production state-space detector catches 0 of 15 labeled miscredit incidents.**
`robust_mad` catches 4/15 only by firing ~6× as much. `robust_mad` catching 4 on the _same_
windows proves the catch/overlap machinery works and catching is possible, so 0/15 is real
selectivity-misalignment, not a window artifact.

**Feature characterization — does any pooled feature separate incident-window buckets from
_equally-large non-incident_ buckets?** (control = out-of-window buckets at/above the 90th
intensity percentile; single-feature AUC, ~0.5 ⇒ no separating signal):

| Feature             | AUC vs all out-of-window | AUC vs high-intensity control |
| ------------------- | ------------------------ | ----------------------------- |
| intensity           | 0.694                    | **0.061**                     |
| source_count        | 0.599                    | **0.519**                     |
| source_dominance    | 0.383                    | **0.487**                     |
| source_disagreement | 0.557                    | **0.528**                     |
| active_market_count | 0.727                    | **0.323**                     |

- intensity AUC 0.06 vs the high-intensity control ⇒ **incidents are not the big moves**; the
  biggest board moves happen _outside_ incident windows.
- breadth / dominance / disagreement all ≈ 0.5 ⇒ **no separating signal** beyond magnitude,
  which is itself anti-aligned.
- **55.7% of incident-window buckets are single-source** (`source_count==1`), and ~half the
  incidents have max `source_count==1` across their entire window ⇒ a hard breadth gate would
  make ~half the incidents uncatchable.
- several incident windows have `max_intensity ≈ 0` (e.g. `nba-0022500986`, `nba-0022500788`,
  `nba-0042500224`) ⇒ for a meaningful share of incidents the snapshot-eligible board barely
  moved — nothing for any board-volatility model to detect.
- `active_market_count`'s deviation (AUC 0.323, _lower_ in-window) is partly circular — it
  co-varies with `intensity`, the variable the control is selected on — so it is not read as a
  real structural signal.

**Dilution rebuttal (the obvious objection, pre-empted).** The AUCs pool ~6.5 buckets per window,
so a signal living in a single _peak_ bucket would be diluted toward 0.5. But detection only needs
_one_ bucket in the window to fire (the scorer catches on any overlap), so the decision-relevant
question is whether the _best_ bucket per window separates. It does not: per-window **max**
`source_count` is 1–2 and per-window **max** `source_disagreement` ≈ 0 for most windows — the peak
buckets are as structureless as the averages. The clincher is dilution-immune: `state_space_current`
fires on the **peak-surprise** bucket (not an average) and still lands in **zero** of 15 windows, so
the conclusion does not depend on pooling at all.

**Verdict on the candidates:** A is _falsified_ (breadth-gating would cut recall; and
production already has breadth-awareness via `sourceTrust` and still scores 0/15). C is mostly
dead (disagreement ≈ 0 in most windows — the feed-shared regime dominates). The pooled
board-level features do not carry the separating signal.

### 2.6 The direction I would actually pursue first, and why

**The honest, evidence-led answer to the core question** — _what observable market behavior
should make an operator believe a play deserves review?_ — is that, **on this corpus, the
board-volatility magnitude signal the platform is built on is the wrong observable.** The
separating signal is not in pooled board features; it lives in **per-player / per-market-family
attribution structure** (Candidate B), which is collapsed before any model sees it.

Because B is a multi-layer data-plumbing investment that should not be undertaken on faith, the
**smallest honest first slice is the instrument that makes B measurable and that turns this
finding into a permanent platform guard**: a registered **incident-alignment / feature-separation
diagnostic** in the Quant Lab. It quantifies, for any feature (current pooled features today,
per-player features tomorrow), whether it separates incident-window buckets from equally-large
non-incident buckets — the exact bar a future attribution feature must clear — and it _fails
closed_ (reports insufficient support, not a bogus number) when a feature is absent or the board
did not move. This is the slice implemented below.

This deliberately does **not** claim a better detector. Its value is a measured negative result
plus the falsification instrument; see §5 for what it must not claim.

### 2.7 Falsification test

The selected slice is correct iff:

1. On the real snapshot, the diagnostic reports separation AUC ≈ 0.5 for the pooled features
   (the negative result). **If a pooled feature shows AUC well away from 0.5, the negative
   result is wrong and a pooled-feature detector is viable** — pursue it instead of B.
2. Negative control: on an injected synthetic feature that is constructed to separate incident
   from non-incident buckets, the diagnostic must report AUC → 1. If it does not, the
   instrument is broken and its ≈0.5 readings are meaningless.
3. Fail-closed: on a feature column that is absent or all-null, the diagnostic must report
   `insufficient_support`, never a fabricated AUC.

---

## 3. Implementation summary

The slice is the **incident-alignment / feature-separation diagnostic** — a new, registered
Quant Lab evaluation capability that grades whether _any_ feature separates incident-window
buckets from equally-large non-incident buckets. It is the falsification instrument for §2.5–2.7
and the bar a future per-player feature (Candidate B) must clear.

**Files (3 new, 1 isolated edit — no Path-B snapshot/loader/schema change, which is the proof
this is the smallest honest slice):**

- **NEW `apps/nba-sidecar/src/nba_sidecar/research/evaluation/separation.py`** — the diagnostic.
  - `feature_separation(board_obs, truth, *, control_percentile, control_feature, features,
movement_floor) -> SeparationReport` and snapshot entry `run_separation(snapshot_path, …)`.
  - Reuses `evaluation.truth.load_truth` (the same pre-materialized, validated, no-recompute
    truth the scorer joins to — so "scoreable incident window" means exactly what the eval
    means) and `loader.read_board_observations`.
  - For each feature, reports a rank-based **AUC** (`auc_vs_control`, the decisive one;
    `auc_vs_all_out` for context) separating in-window buckets from the **control = top
    `control_percentile` of out-of-window buckets by `control_feature`** (default `intensity`).
  - The control-defining feature is reported but **excluded from the verdict** (its
    AUC-vs-control is circular). The verdict is **direction-aware**: a feature only supports a
    detector if it is _elevated_ in incidents (positive separation).
  - Also reports `in_window_single_source_share` (would a hard breadth gate kill recall?) and
    `windows_with_negligible_movement` (incidents the board barely reacted to).
  - **Fail-closed by construction:** an absent or all-null feature → `insufficient_support`,
    `auc=None`, never a fabricated number; a snapshot with no scoreable window / no in-window
    bucket / no control bucket → the whole report is `insufficient_support`.
  - Standalone-runnable: `python -m nba_sidecar.research.evaluation.separation <snap>`.
- **EDIT `apps/nba-sidecar/src/nba_sidecar/research/cli/main.py`** — one isolated addition
  mirroring `doctor`: a `separation` subcommand →
  `pnpm quant separation <snap> [--control-percentile P] [--movement-floor M]`.
- **NEW `apps/nba-sidecar/tests/test_separation.py`** — hermetic behavior tests (§4).
- **NEW** this research note.

**Surface contract for the declared hyperparameters (Path A — pure run-time knobs, the cheap
path; zero snapshot/loader/schema touch):** `control_percentile` (90), `control_feature`
(`intensity`), `movement_floor` (1.0) are declared as function defaults, surfaced as CLI flags,
and overridable per run (`--control-percentile`, `--movement-floor`). A test asserts the knob
changes the reported output. Because the diagnostic reads only existing causal columns, it does
not need the Path-B cross-language column chain (export → loader → `columns.py` → `schemas.py`);
a future per-player feature _would_, and that chain is documented in `docs/nba-quant-lab.md` §7.

**Real-snapshot output (reproduces §2.5; the negative result):**

```
control_feature=intensity  control_percentile=90  threshold≈23.7
n_scoreable_incidents=15  windows=15  in_window_buckets=97
in_window_single_source_share=0.557   windows_with_negligible_movement=1
auc_vs_control: intensity 0.061(excluded)  source_count 0.519  source_dominance 0.487
                source_disagreement 0.528  active_market_count 0.323  game_elapsed 0.518
verdict: no pooled feature is ELEVATED in incidents (max positive separation 0.028); the only
deviations indicate incidents are SMALLER/NARROWER than ordinary large moves — not viable.
```

**Coordination note:** a concurrent integration pass (Codex) is repo-localizing the research
artifact defaults and making `tests/test_research.py` hermetic (stale `signal-console-quant-lab`
path → `NBA_RESEARCH_SNAPSHOT_PATH`). To avoid colliding with that rewrite, this slice touches no
shared file it is editing — not `test_research.py`, the exporter, or the `docs/nba-quant-lab.md`
command tables. The `pnpm quant separation` row for that command table is a one-line follow-on,
deferred to the integration owner to avoid a merge conflict.

## 4. Tests and verification

**Changed-surface tests (`apps/nba-sidecar`, `uv run --extra research --extra dev python -m
pytest`):**

- `tests/test_separation.py` — **10 passed, 1 skipped** (the optional real-snapshot regression,
  gated on `NBA_RESEARCH_SNAPSHOT_PATH`); with that env var set to the `slice-eval` snapshot the
  regression also **passes** (11/11). Properties pinned:
  - _Negative control:_ a synthetic feature built to separate incident from non-incident buckets
    scores `auc_vs_control == 1.0` (proves the metric detects separation when it exists, so the
    ≈0.5 readings on real features are a finding, not a broken metric).
  - _Null control:_ a flat feature scores exactly `0.5`.
  - _Fail-closed:_ absent feature column and all-null feature → `insufficient_support`, `auc=None`,
    never a number; a snapshot with no scoreable window / no control bucket → whole report
    `insufficient_support`.
  - _Declared knob:_ lowering `control_percentile` enlarges the control set and lowers the
    threshold (knob → output).
  - _Control feature excluded:_ `intensity`'s circular AUC (|AUC−0.5|>0.3) does not move the
    verdict; `max_abs_separation()` over non-control features is 0 → verdict is negative.
  - `rank_auc` unit behavior (perfect / inverse / ties→0.5 / empty→None).
- **Typecheck gate:** `python -m compileall src/.../separation.py cli/main.py tests/test_separation.py` → OK.
- **CLI dispatch:** `pnpm quant list-models` (3 models) and `pnpm quant separation --help` work
  after the `main.py` edit.

**Baseline evidence runs (read-only, on the real gold DB):** `pnpm quant:export -- --sample 30
--snapshot-id slice-eval`; `pnpm quant doctor`; `pnpm quant compare robust_mad
state_space_current` — numbers in §2.5.

**Pre-existing breakage (not mine, not touched):** the full sidecar `pytest` shows
`1 failed, 83 passed, 9 errors` — every failure/error is in `tests/test_research.py`,
`FileNotFoundError` on the dead `signal-console-quant-lab/.../sample-fixed` path. This is the
stale-path defect the concurrent integration pass is already fixing (it reports 84 green after
making those tests hermetic). My changed surface is green independently and depends on no dead
path or the gold DB.

**Full `pnpm verify` was NOT run — stated explicitly per the verification rule.** The repo-wide
gate is already red on pre-existing, unrelated debt that this Python-only change does not touch:
Prettier formatting on `audit/*.md`, a mainline detector-contract lint violation, and the
stale-path `test_research.py` above (all established by the concurrent integration pass). Running
it would re-surface that debt, not exercise this slice. The changed-surface gates that _do_ cover
this slice were run and are green: `pytest tests/test_separation.py` (11/11 with the snapshot
env var; 10 + 1-skipped without), `compileall`, and CLI dispatch.

## 5. Remaining uncertainty (what is not yet calibrated; what the model must not claim)

- **N = 15 scoreable incidents is the entire labeled corpus, not a sample.** The exporter
  unions every incident game; a larger `--sample` only adds _negatives_ (background/tape), not
  incidents. So the recall denominator is fixed at 15. The negative result is **directional and
  bounded by 15 incidents** — the highest-value next investment is _more labels_, not more
  features or more background.
- **Catch-window timing is untested.** If real market reaction lags beyond `CATCH_WINDOW_AFTER`,
  a genuine reaction could fall outside the scored window and inflate the "no separation"
  reading. `robust_mad`'s 4 catches argue against _universal_ misalignment, but the window
  width has not been sensitivity-tested.
- **Single snapshot, single source set** (Kalshi/Polymarket/Bet365/NBA — snapshot-eligible).
  A miscredit might move a non-eligible book (DraftKings/FanDuel via Odds-API.io are
  `artifact_only`, not gold) and be invisible here.
- At N=15, `robust_mad`'s 4 catches (27%) could be partly coincidental — do not over-read it.
- **The slice must not claim** to improve incident recall, to be a better detector, or that
  per-player attribution _will_ separate incidents — only that it _can be measured_ whether it
  does. The negative result says pooled features do not separate; it does **not** prove the
  signal is unrecoverable, only that it is not in the currently-exported features.

### Note on concurrent integration work

A concurrent integration/preservation pass (Codex, in a separate temporary merge worktree) is
repo-localizing the research artifact defaults and making the sidecar research tests hermetic —
this is fixing the stale `/Users/davidmontgomery/signal-console-quant-lab/...` paths in
`test_research.py` and the exporter's incident-registry default, and introduces
`NBA_RESEARCH_SNAPSHOT_PATH` for an explicit snapshot. The slice below is therefore implemented
as **new, self-contained files only** (a new diagnostic module + a fully synthetic test file)
to avoid colliding with that cleanup; it does not depend on any snapshot path or the gold DB to
pass its tests.
