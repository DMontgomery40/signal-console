# NBA Quant Lab — Canonical Guide

> Audience: a strong quant or ML researcher who has never seen this repo. This
> document is self-contained. You do not need to read the rest of the codebase to
> propose, implement, and score a model.

---

## 0. TL;DR

The NBA Quant Lab is an **offline research test-bed**. Its single purpose is to let
you search for a model that predicts, from a live betting/prediction-market board,
_when an NBA in-game stat-misattribution incident is about to surface_ — and to do
so **better than the current baselines**, on a frozen, reproducible dataset, scored
by one shared evaluator.

### The workflow (gold-first)

The canonical order is:

1. **Check gold DB status.** The gold SQLite DB already holds canonical
   Kalshi / Polymarket / Bet365 / NBA coverage. Confirm it is present and how
   many games it carries (`GET /v1/research/gold`, or the "Gold dataset status"
   panel on the `/research` page).
2. **Export a snapshot.** The exporter reads the gold DB **directly** — there is
   **no pull step required** to start modeling. (`pnpm quant:export`, or the
   "Export snapshot" CTA on `/research` which POSTs `/v1/research/export` to
   enqueue an export job the worker runs via `scripts/export-quant-snapshot.ts`.)
3. **Run / score models** against that frozen snapshot (`pnpm quant ...`).
4. **(Optional) Add or repair source data.** This is the old "Pull" step,
   demoted: it is only for sources **not** persisted in the gold DB
   (DraftKings / FanDuel via Odds-API.io) or for new date windows. Pulled data
   lands as `artifact_only` coverage — non-canonical board input (see §2) — so it
   is never required before exporting and never required to model the canonical
   board.

It is **not** a claim that the problem is solved. The two baselines shipped here are
deliberately framed as **bars to beat**, not answers:

| baseline              | family                   | scoreable-incident recall | fires/game | residual coverage |
| --------------------- | ------------------------ | ------------------------- | ---------- | ----------------- |
| `robust_mad`          | robust statistics        | **4 / 15** (0.267)        | **15.55**  | 0.888             |
| `state_space_current` | Kalman-style state space | **0 / 15** (0.000)        | **0.75**   | 0.994             |

(Real numbers from the recorded `REAL-compare-sample-fixed` run on the `sample-fixed`
snapshot; see §6.) `robust_mad` catches more known incidents but at ~20× the alert
burden; the production state-space filter is quiet but currently catches none of the
scoreable incidents in this snapshot. Neither is "the answer." The whole point of the
lab is that there is headroom.

The contract that keeps the search honest:

- **Models never read the production database.** They consume a frozen
  **Parquet / DuckDB snapshot** exported from the read-only gold DB. SQLite is never
  touched at model or score time.
- **One shared scorer** evaluates every candidate — native Python models and external
  R/notebook outputs — identically.
- **Causal at decision time.** A model scoring bucket _i_ may only use buckets _0..i_.
  Label-derived fields (incident anchors, catch windows, whole-game robust-z episodes)
  are explicitly flagged as leakage-prone and are **truth only**, never inputs.

---

## 1. What problem this is solving

In live NBA games, the official scorer occasionally mis-credits a stat (a rebound, an
assist, a block) to the wrong player, and sometimes issues an official correction
later. These **misattribution incidents** are the "known cases." When one happens, the
betting/prediction markets that price player props (Kalshi, Polymarket, sportsbooks)
can twitch — a burst of disagreeing, high-volume repricing across the board — before or
around the moment the truth surfaces.

The research question: **is there a signal in the live board that flags these incidents
with acceptable alert burden?** A useful model fires a manageable number of times per
game and still catches the known incidents. A useless model either never fires (misses
everything) or fires constantly (catches things by spamming).

This lab does **not** assert that such a model exists or that the current production
detector is good. It gives you the frozen data, the labels, the baselines, and the
scorer, and asks you to beat the bar.

---

## 2. Where the data comes from (and what you must never trust)

### The pipeline

```
  gold DB (read-only SQLite, ~54 GB tick store)        ← authoritative, NEVER read by models
        │
        │  scripts/export-quant-snapshot.ts  (TS-owned exporter, deterministic, seed=42)
        │  uses the SHARED @signal-console/research-truth functions, so the snapshot's
        │  truth equals the production NBA detector bake-off's truth (no second code path)
        │  DEFAULT = FULL CORPUS: every board-eligible game (>=1 non-heartbeat quote
        │  tick from an eligible source via source_markets) UNION every incident game.
        │  Sampling is OPT-IN (`--sample N`, `--games a,b`, `--limit N`).
        ▼
  SNAPSHOT  outputs/nba-quant-lab/snapshots/<id>/        ← what models actually read
    *.parquet  +  snapshot.duckdb  +  manifest.json  +  feature_catalog.{json,md}  +  splits.json
        │
        │  python -m nba_sidecar.research  (loader → model → shared scorer)
        ▼
  RUN  outputs/nba-quant-lab/runs/<id>/                  ← metrics, casebook, leaderboard, report
```

The exporter reads the gold DB **read-only** via `openGoldDb()`, joins the committed
incident registry, and materializes the snapshot with `@duckdb/node-api` (which also
emits `snapshot.duckdb` via `COPY TO`). The board observations come from the **live
board lane shape** (`buildLiveBoardObservationsForGame`), restricted to the
snapshot-eligible source set (`kalshi`, `polymarket`, `bet365`, `nba`). The tape-outlier
episodes come from the byte-identical bake-off path on each game's full natural window.

### Selection: the default is the FULL corpus

The exporter's **default (no selection flag) is the full corpus**: every
board-eligible game — defined as a game with at least one non-heartbeat quote
tick carrying a numeric implied probability from a snapshot-eligible source
(`kalshi`/`polymarket`/`bet365`; `nba` is the PBP feed and never contributes
ticks) joined through `source_markets` — **unioned with every incident game that
has a local window** (so the scoreable-incident truth set never regresses). On
the current gold DB that is **1 260 board-eligible games (1 256 with a local PBP
window)**, recorded in `manifest.selection.mode == "full-corpus"`.

Sampling is **opt-in**, never the default:

| invocation    | `selection.mode`       | games selected                                            |
| ------------- | ---------------------- | --------------------------------------------------------- |
| _(no flag)_   | `full-corpus`          | all board-eligible games ∪ all incident games             |
| `--sample N`  | `incident-plus-sample` | ALL incident games + N deterministic regular-season games |
| `--games a,b` | `explicit-games`       | exactly the listed ids that have a local window           |

`--limit N`, `--since DATE|ISO`, and `--until DATE|ISO` post-filter whatever was selected
on any path. Date-only `--since` starts at `00:00:00Z`; date-only `--until` is inclusive
through `23:59:59Z`. The `sample-fixed` snapshot below was built with the **opt-in
`--sample 15`** path (29 games), kept frozen as a small, fast reference; it is
**not** what a default `pnpm quant:export` produces today.

### The hard rule

**Models read the snapshot, never SQLite.** The Python research package's loader
(`research/loader.py`) is the _only_ place that knows how the snapshot is laid out, and
it reads only `board_observations` (the causal lane) — either via pandas+pyarrow or via
the bundled `snapshot.duckdb` (a backend-parity option). A model is a pure function of
`(GameBucketSeries, params)`: no I/O, no DB handle, no network. That purity is what lets
the evaluator replay any model deterministically.

### What NOT to trust

- **`artifact_only` coverage is not canonical.** `source_coverage.class` is one of
  `canonical | snapshot_eligible | partial | artifact_only | missing`. `artifact_only`
  rows describe coverage that exists only as a cached artifact (e.g. an odds-api.io
  pull) and has not been promoted into the canonical tick store. This is exactly what
  the **optional** "add/repair source data" pull (DraftKings / FanDuel via
  Odds-API.io; §0 step 4) lands: `artifact_only`, never gold. Do not treat
  `artifact_only` coverage as authoritative board input. (In the `sample-fixed`
  snapshot, all 278 coverage rows happen to be `canonical` — but the enum exists because
  other snapshots will not be, and a model must not assume otherwise.)
- **Incident-window flags are leakage-prone.** Every field in `incidents`,
  `score_windows`, and `market_outlier_episodes` is label-side, non-causal truth. They
  are derived from the incident registry and/or whole-game robust statistics that an
  online scorer would not have at decision time. They are **scoring inputs, not model
  inputs.** Using them as features is leakage and the bar is meaningless if you do.

### Reproducibility / provenance

Every snapshot carries a `manifest.json` recording: `snapshotId`, `schemaVersion`,
`generatedAt`, the exact `generationCommand`, `seed`, the git commit, the gold-DB path +
size + mtime, the incident-registry path + **sha256** + count, the date range, the live
board config (bucket seconds, freshness cap, weighting), the eligible sources, and
per-table counts + per-game tick diagnostics. Every run carries a `run-manifest.json`
recording the command and the snapshot it scored. Two people running the same command
against the same gold DB + registry get the same snapshot.

---

## 3. The dataset: files + schemas

All paths below are under
`/Users/davidmontgomery/signal-console/outputs/nba-quant-lab/snapshots/sample-fixed/`.
Schemas are read from the real parquet files. The authoritative per-field provenance
(units, causal/non-causal, leakage flag) lives in `feature_catalog.json` /
`feature_catalog.md` next to the data.

`sample-fixed` contents: **29 games** (14 incident games + 15 sampled regular games —
the **opt-in `--sample 15`** path, kept frozen as a small reference, NOT the
full-corpus default of ~1 256 games), **3 862 board observations**, **26 incidents**
(15 scoreable), **15 score windows**, **99 market-outlier episodes**, **278
source-coverage rows**.

### 3.1 `board_observations.parquet` — THE MODEL INPUT (causal, leakage-safe)

One row per 60-second bucket per game (3 862 rows). This is the **only** table a model
sees. Every column is causal and safe for online scoring.

| column                 | type                  | meaning                                                                                                                                 |
| ---------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `game_id`              | string                | Snapshot game id, e.g. `nba-0042500222`.                                                                                                |
| `bucket_start`         | datetime (ISO-8601 Z) | Bucket start wall-clock instant.                                                                                                        |
| `bucket_end`           | datetime (ISO-8601 Z) | Bucket end wall-clock instant.                                                                                                          |
| `game_elapsed_seconds` | double (nullable)     | NBA game-clock seconds elapsed at bucket, from play-by-play period/clock.                                                               |
| `intensity`            | double                | **Volume-weighted sum of \|Δ implied probability\| across markets in the bucket.** The core board-lane intensity signal.                |
| `active_market_count`  | int (nullable)        | Distinct `source_market_id`s contributing a delta in the bucket.                                                                        |
| `source_count`         | int (nullable)        | Distinct sources (book/exchange) contributing in the bucket.                                                                            |
| `source_dominance`     | double (nullable)     | Share of bucket intensity from the single most active source (0..1).                                                                    |
| `source_disagreement`  | double (nullable)     | `1 − \|net signed contribution\| / total \|signed contribution\|` across sources; high when sources move in opposite directions (0..1). |

### 3.2 `incidents.parquet` — TRUTH (non-causal, leakage-prone — do not use as features)

26 rows; 15 are `scoreable`. Confidence mix: 12 high / 8 medium / 6 low.

| column                | type                | meaning                                                                            |
| --------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `incident_id`         | string              | Stable incident id.                                                                |
| `canonical_game_id`   | string (nullable)   | Game the incident belongs to; null for unanchored incidents.                       |
| `has_local_window`    | bool                | Whether a local catch window exists.                                               |
| `scoreable`           | bool                | Has exact anchor + local window. **Only scoreable incidents count toward recall.** |
| `confidence`          | string (nullable)   | Label confidence tier (high/medium/low).                                           |
| `anchor_type`         | string (nullable)   | Anchor kind for the label.                                                         |
| `utc_time`            | datetime (nullable) | Label anchor wall-clock time.                                                      |
| `event_sec`           | int (nullable)      | Truth event unix-seconds (label anchor). Null when not scoreable.                  |
| `stat`                | string (nullable)   | Misattributed stat category.                                                       |
| `credited_player`     | string (nullable)   | Player wrongly credited.                                                           |
| `rightful_player`     | string (nullable)   | Player who should have been credited.                                              |
| `official_correction` | bool (nullable)     | Official box-score correction flag.                                                |

### 3.3 `score_windows.parquet` — TRUTH (the catch windows, non-causal)

15 rows — one per scoreable incident. A model "catches" an incident iff some **fired**
bucket overlaps that incident's window.

| column                        | type                | meaning                                                    |
| ----------------------------- | ------------------- | ---------------------------------------------------------- |
| `incident_id`                 | string              | Incident this window scores.                               |
| `game_id`                     | string              | Game id.                                                   |
| `window_start` / `window_end` | datetime (nullable) | Catch window bounds (ISO).                                 |
| `window_start_sec`            | int                 | Window start unix-seconds (`event + CATCH_WINDOW_BEFORE`). |
| `window_end_sec`              | int                 | Window end unix-seconds (`event + CATCH_WINDOW_AFTER`).    |

### 3.4 `market_outlier_episodes.parquet` — TRUTH (tape outliers, non-causal)

99 rows. These are whole-game robust-z "tape outlier" episodes — a secondary, denser
recall target. Diagnosis mix: 63 "extreme price move; broad market participation",
36 "price move outlier; broad market participation". **`peak_severity` /
`peak_price_move_z` use whole-game robust stats and are therefore non-causal** — truth
only.

| column                                                   | type   | meaning                                                     |
| -------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `episode_id`                                             | string | Stable episode id.                                          |
| `game_id`, `scheduled_start`, `matchup`                  | string | Game context.                                               |
| `start_sec` / `end_sec`                                  | int    | Episode span, unix-seconds.                                 |
| `start_iso` / `end_iso`                                  | string | Episode span, ISO.                                          |
| `bucket_seconds`, `bucket_count`                         | int    | Bucketization used.                                         |
| `peak_severity`                                          | double | Peak tape-outlier severity (whole-game robust-z composite). |
| `peak_price_move_z`, `peak_breadth_z`, `peak_offprice_z` | double | Peak component robust-z's.                                  |
| `peak_active_markets`, `peak_sources`, `peak_families`   | int    | Peak breadth counts.                                        |
| `diagnosis`                                              | string | Episode diagnosis label.                                    |

### 3.5 `source_coverage.parquet` — provenance (non-causal)

278 rows (game × source × market_family × window). Sources in this snapshot:
polymarket 101, bet365 96, kalshi 81.

| column                                         | type            | meaning                                                                  |
| ---------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| `game_id`, `source`, `market_family`, `window` | string          | Coverage key.                                                            |
| `class`                                        | string          | `canonical \| snapshot_eligible \| partial \| artifact_only \| missing`. |
| `market_count`                                 | int (nullable)  | Distinct markets in window.                                              |
| `tick_count`                                   | int (nullable)  | Quote ticks in window.                                                   |
| `eligible`                                     | bool (nullable) | Whether the window is snapshot-eligible.                                 |

### 3.6 `games.parquet` — game index

29 rows. `game_id`, `scheduled_start`, `home_key`/`away_key`, full-window bounds
(`window_start_iso`/`window_end_iso`/`window_start_sec`/`window_end_sec`),
`pbp_point_count`, `quote_pair_count` (board input volume; **non-causal** whole-window
count), `micro_event_count`, `is_incident_game`.

### 3.7 `manifest.json`, `feature_catalog.{json,md}`, `splits.json`, `snapshot.duckdb`

- **`manifest.json`** — provenance (§2). The source of truth for "how this snapshot was
  made."
- **`feature_catalog.json` / `.md`** — per-field provenance with the `causal_or_noncausal`
  and `leakage_safe_for_online_scoring` flags. **Read this before choosing features.**
- **`splits.json`** — game-level holdout (see §5).
- **`snapshot.duckdb`** — the same tables as one DuckDB file, for SQL/pushdown. The
  loader can read board observations from it (`backend="duckdb"`) to prove the contract
  is backend-agnostic.

---

## 4. How to add a Python model — in 3 steps

Models live in
`apps/nba-sidecar/src/nba_sidecar/research/models/`. The base class + registry are in
`models/base.py`; the copy-me example is `models/template_model.py`.

**Step 1 — copy the template.**

```bash
cd /Users/davidmontgomery/signal-console/apps/nba-sidecar/src/nba_sidecar/research/models
cp template_model.py my_model.py
```

**Step 2 — set the four identity ClassVars and implement `default_params` + `score`.**
The `@register` decorator self-registers the class on import (it validates that `id`,
`name`, `summary`, `family` are non-empty and that the id is unique). `score` must emit
**exactly one `PredictionRow` per input bucket**, must be **causal** (when scoring bucket
_i_, look only at buckets _0..i_), and must only set `fired=True` where the model is
warmed up. The skeleton:

```python
from __future__ import annotations
from typing import Any
from ..contracts import PredictionRow
from .base import BoardModel, ScoreRequest, ScoreResult, register

@register
class MyModel(BoardModel):
    id = "my_model"
    name = "My candidate"
    summary = "One honest paragraph: what it does and its known burden."
    family = "robust-baseline"  # or state-space / online / forecasting / ...
    references = ("arXiv:XXXX.XXXXX", "lib: ...")

    def default_params(self) -> dict[str, Any]:
        return {"warmup_buckets": 8}  # JSON-serializable; callers can override

    def score(self, request: ScoreRequest) -> ScoreResult:
        params = self.resolve_params(request.params)
        preds: list[PredictionRow] = []
        for i, b in enumerate(request.series.buckets):
            # ... causal logic over buckets[0..i] using b.intensity,
            #     b.active_market_count, b.source_count, b.source_dominance,
            #     b.source_disagreement, b.game_elapsed_seconds ...
            preds.append(PredictionRow(
                game_id=request.series.game_id,
                bucket_start=b.bucket_start,
                score=...,          # continuous surprise score
                fired=...,          # bool; only where warmed up
                diagnostics={"threshold": ..., "warmed": float(warmed)},
            ))
        return self._validate_result(request, ScoreResult(
            model_id=self.id, game_id=request.series.game_id, predictions=preds))
```

Emit `threshold`, `intensity` is carried for you, and `warmed` in `diagnostics` if you
want the **residual-coverage** diagnostic to light up (see §5).

**Step 3 — run it.** First install the research extras (the research package is optional
and not part of the base sidecar service):

```bash
cd /Users/davidmontgomery/signal-console/apps/nba-sidecar
uv sync --extra research          # installs pandas, pyarrow, duckdb, numpy, matplotlib
SNAP=/Users/davidmontgomery/signal-console/outputs/nba-quant-lab/snapshots/sample-fixed

uv run --extra research python -m nba_sidecar.research list-models
uv run --extra research python -m nba_sidecar.research run-model my_model "$SNAP"
uv run --extra research python -m nba_sidecar.research compare my_model robust_mad state_space_current --snapshot "$SNAP"
```

`run-model` / `compare` write a run directory under
`outputs/nba-quant-lab/runs/<id>/` with `metrics.json`, `casebook.json`,
`leaderboard.json`, and a rendered `REPORT.md` / `report.html`.

> The currently-registered models are `robust_mad` and `state_space_current` (the two
> baselines), `virtual_source_state_space` (a registered research candidate:
> per-virtual-source Kalman filters combined by precision weighting, approximating the
> source split from aggregate dominance/disagreement columns — see
> `docs/moniac-pipeline-plan-and-code-draft.md`), and `template_model` (a non-candidate
> example — do not enter it in a bake-off as if it were real).

---

## 5. How to score an external R / notebook `predictions.parquet`

You do **not** have to write Python. Any tool (R, a Jupyter notebook, a Julia script)
can produce a `predictions.parquet` and have it scored by the **same** evaluator that
scores native models — this is a structural guarantee, because both paths funnel through
one pure `score_predictions` function.

**The contract.** Your file must have these four columns (extra diagnostic columns are
allowed and encouraged):

| column         | type                       | meaning                                                  |
| -------------- | -------------------------- | -------------------------------------------------------- |
| `game_id`      | string                     | Game the bucket belongs to (e.g. `nba-0042500222`).      |
| `bucket_start` | datetime / ISO-8601 string | Joins back to `board_observations.bucket_start`.         |
| `score`        | float                      | Continuous alert/surprise score for the bucket.          |
| `fired`        | bool                       | Alert decision; True only where your model is warmed up. |

Optional columns that unlock the residual-coverage diagnostic and exact-interval
overlap: `bucket_end`, `threshold`, `intensity`, `warmed`. If you omit `threshold` /
`intensity`, residual coverage is reported as `null` (not penalized — just unavailable).

**Score it:**

```bash
cd /Users/davidmontgomery/signal-console/apps/nba-sidecar
SNAP=/Users/davidmontgomery/signal-console/outputs/nba-quant-lab/snapshots/sample-fixed

uv run --extra research python -m nba_sidecar.research \
    score-predictions /path/to/predictions.parquet "$SNAP" \
    --model-id my_external_model
```

This validates your file against the same column spec native predictions satisfy, then
runs the identical scorer and writes a run directory.

> **Command forms.** Two equivalent ways to invoke the model/eval CLI:
> the wired npm shorthand **`pnpm quant <cmd>`** (e.g. `pnpm quant score-predictions ...`,
> `pnpm quant compare ...`, `pnpm quant list-models`), which forwards to the Python CLI via
> `scripts/quant.ts`, or the underlying **`uv run --extra research python -m nba_sidecar.research <cmd>`**
> (useful if the venv isn't synced). The snapshot is exported separately via **`pnpm quant:export`**
> (→ `scripts/export-quant-snapshot.ts`; **default = full corpus**, sampling is opt-in via
> `--sample N` / `--games a,b` / `--limit N`). The exporter reads the **gold DB directly**, so
> there is **no pull step before exporting** — you can export and score the canonical board
> straight from gold. **`pnpm quant:pull`** (→ `scripts/research-pull.ts`; the old "Pull",
> surfaced as "Add/repair source data" on `/research`) is **optional**: use it only to add
> sources not persisted in the gold DB (DraftKings / FanDuel via Odds-API.io) or to fill new
> date windows, and it lands `artifact_only` coverage (non-canonical — see §2), not gold.
> Do not confuse the export step with the scoring step.

---

## 6. What "better" means (the metrics, and the recorded bar)

### The recorded research bar

The bar a candidate must clear, recorded for this lab, is:

> **better known-case recall at the same fires/game plus honest residual coverage.**

Unpacked: a model wins by catching **more of the known scoreable incidents** while
holding **alert burden (fires/game) fixed**, and without buying that recall with junk —
i.e. its un-matched fires still tend to sit on genuine board activity (high residual
coverage). Recall bought by spamming fires is not a win; quiet that catches nothing is
not a win.

The canonical definition of residual coverage, from the product explainer
(`packages/ui/src/explainers.ts`), is worth quoting because it is the honest framing:

> "Residual coverage is computed over the fires NOT matched to a labelled incident (the
> residual set). It is the fraction of that residual set whose buckets still clear an
> independent board-activity criterion … It complements recall@fires/game: recall
> measures hits against the known corpus; residual coverage characterizes the quality of
> the remaining fire budget. A research-snapshot metric only — it is not a live
> production gate."

### How the scorer computes it (the join, defined once in `evaluation/scorer.py`)

- A prediction bucket fires over the half-open interval `[bucket_start_sec, bucket_end_sec)`.
- **Incident caught** iff some FIRED bucket in the incident's game overlaps the
  incident's catch window `[window_start_sec, window_end_sec]`. Only `scoreable`
  incidents count.
- **Tape-outlier caught** iff some FIRED bucket overlaps the episode span.
- **fires/game** = mean over evaluated games of fired-bucket count.
- **per-game outlier burden** = total fired buckets / number of distinct tape episodes
  (how many alerts you pay per real tape outlier).
- **residual / calibration coverage** = over warmed buckets, the fraction whose
  intensity stayed within the model's own threshold band (`intensity ≤ threshold`).
  Requires `threshold`/`warmed` diagnostics; `null` when a producer omits them.

The scorer is a **pure join to pre-materialized truth**. It reads only your predictions
and the four label tables — never `board_observations` — so it cannot recompute
scoreability, catch windows, or tape episodes. That is what makes external and native
scoring identical.

### The honest current baseline numbers (the bar to beat)

From the recorded `REAL-compare-sample-fixed` run
(`outputs/nba-quant-lab/runs/REAL-compare-sample-fixed/metrics.json`), 20 games
evaluated, 15 scoreable incidents, 99 tape episodes:

| model                 | scoreable recall   | tape-outlier recall | total fires | fires/game | per-game outlier burden | residual coverage |
| --------------------- | ------------------ | ------------------- | ----------- | ---------- | ----------------------- | ----------------- |
| `robust_mad`          | **4 / 15** (0.267) | 57 / 99 (0.576)     | 311         | **15.55**  | 3.14                    | 0.888             |
| `state_space_current` | **0 / 15** (0.000) | 8 / 99 (0.081)      | 15          | **0.75**   | 0.15                    | 0.994             |

Read this as the headroom, not the verdict. `robust_mad` is the incumbent high-recall /
high-burden line: it catches 4 of 15 known incidents but fires ~15.5×/game. The current
production state-space filter is extremely quiet (0.75 fires/game, residual coverage
0.994) but currently catches **none** of the scoreable incidents in this snapshot.
Neither is "solved math." A candidate that lifts scoreable recall above 4/15 at
`robust_mad`'s burden, or matches `robust_mad`'s recall at far lower burden, has moved
the bar.

> **Why 20 games and "/15" — read this carefully.** The evaluation universe is _not_ the
> 4-game test split. The scorer defaults to **games-with-truth** (`games_with_truth()` in
> `evaluation/truth.py`) — every game carrying at least one scoreable window or tape
> episode — which is ~20 games here. This is deliberate: `splits.json` forces **all
> incident games into the train side** so that incident windows/labels can never leak
> into a test holdout. Scoring against the test holdout would therefore yield 0/0
> incident recall (the test games have no scoreable incidents). The "/15" denominator is
> the count of scoreable incidents across the truth universe. When you report a number,
> say which universe it was measured on.

---

## 7. The train/test split (`splits.json`)

- **seed** 42.
- **strategy:** game-level holdout. **All incident games are forced into `train`** so
  incident windows/labels cannot leak into test. 30% of the non-incident games are
  sampled into `test`.
- `train`: 25 games (all 14 incident games + 11 sampled regular games).
- `test`: 4 games (`nba-0022500268`, `nba-0022500374`, `nba-0022500704`,
  `nba-0022501069`) — all non-incident.

Use the split for honest generalization of _causal-feature behavior_ (does your model's
fire rate / residual coverage hold on unseen games), not for incident recall — by
construction the test side has no scoreable incidents. Incident recall is a
truth-universe metric (§6).

---

## 8. Reproducibility checklist

1. `manifest.json` pins the gold-DB path/size/mtime, the incident-registry **sha256**,
   the seed, the git commit, and the exact `generationCommand`. Re-running that command
   against the same gold DB + registry reproduces the snapshot.
2. Models are pure `(series, params)` functions — replayable, no hidden state.
3. The scorer is a pure join — same predictions ⇒ same metrics.
4. Every run writes a `run-manifest.json` recording its command + snapshot.
5. `feature_catalog.json` is the per-field leakage authority; if you are unsure whether a
   field is fair game, its `leakage_safe_for_online_scoring` flag is the answer.

---

## 9. Where to go next

- Candidate model families, their fit for this _causal streaming bucket_ dataset, and
  real references: **`docs/research-menu.md`**.
- Base class + registry + one-row-per-bucket contract: `research/models/base.py`.
- Copy-me example: `research/models/template_model.py`.
- The two baselines: `research/models/robust_mad.py`,
  `research/models/state_space_current.py`.
- The shared scorer (read this to understand exactly how you are graded):
  `research/evaluation/scorer.py`.
- Column contracts (what every parquet must satisfy): `research/contracts/columns.py`.
