# Quant Researcher Guide — the hands-on workflow

Hey quant folks — the UI exists so devs, traders, ops, and researchers all look at the
same artifacts. You probably want the real workflow, not the screenshots. Start here.

This is the **hands-on workflow** doc. It is self-contained and usable outside the app.
For the canonical contract (data layout, schemas, leakage rules, the recorded bar) read
**`docs/nba-quant-lab.md`**; for _what model family to try_ and why, read
**`docs/research-menu.md`**. This guide does not re-derive those — it walks you from a
clean checkout to a scored leaderboard.

All shell paths below are **repo-relative**: run them from the repo root unless noted.
`$SNAP` always means "the absolute path to a snapshot directory you exported."

---

## 0. The 60-second mental model

```
  gold DB (read-only SQLite, large multi-GB tick store)   ← authoritative, NEVER read by models
        │  pnpm quant:export   (scripts/export-quant-snapshot.ts, deterministic, seed=42)
        ▼
  SNAPSHOT  outputs/nba-quant-lab/snapshots/<id>/          ← frozen parquet + duckdb, what models read
        │  pnpm quant <subcommand>   (python -m nba_sidecar.research ...)
        ▼
  RUN  outputs/nba-quant-lab/runs/<id>/                    ← metrics.json, casebook.json, leaderboard.json, REPORT.md
```

Three rules that make this honest:

1. **Models never touch the gold DB.** They read a frozen Parquet / DuckDB snapshot.
2. **One shared scorer** grades native Python models and external R/notebook output
   identically.
3. **Causal at decision time.** When scoring bucket _i_ you may use buckets _0..i_ only.
   Label-side fields (incidents, catch windows, tape episodes) are truth, never inputs.

---

## 1. The gold DB, snapshots, and why you score against frozen snapshots

### The gold DB

The **gold DB** is a read-only SQLite tick store that holds the canonical
Kalshi / Polymarket / Bet365 / NBA play-by-play coverage. It is the single
authoritative source of board history. It is large (multi-GB) and append-y: it changes
as new games and corrections land. The exporter opens it **read-only**; nothing at model
or score time ever opens it.

### A snapshot

A **snapshot** is a frozen, reproducible extract of the gold DB, materialized as Parquet
files plus a bundled `snapshot.duckdb`, under
`outputs/nba-quant-lab/snapshots/<id>/`. It contains the causal model-input table
(`board_observations.parquet`), the label-side truth tables (`incidents`,
`score_windows`, `market_outlier_episodes`), provenance (`source_coverage`, `games`,
`manifest.json`, `feature_catalog.{json,md}`), and a seeded train/test split
(`splits.json`). Field-level schemas live in `docs/nba-quant-lab.md` §3 and, normatively,
in the snapshot's own `feature_catalog.json`.

### Why models score against frozen snapshots, never the live gold DB

- **Reproducibility.** A snapshot is immutable. Two people running the same model against
  the same snapshot get the same metrics, today and next month. The gold DB drifts under
  you; a snapshot does not.
- **Leakage-safety.** The exporter is the one place that separates causal model input
  (`board_observations`) from label-side truth. If a model could query the gold DB it
  could trivially read the future of a game (or the incident registry) and inflate
  recall. The snapshot boundary makes that structurally impossible.
- **No drift, and no I/O in models.** A model is a pure function of
  `(GameBucketSeries, params)` — no DB handle, no network, no clock. That purity is what
  lets the evaluator replay any model deterministically and what lets an R script and a
  Python class be scored by the identical join.

The gold DB is large and live; do not point a model loop at it, do not copy it, do not
read it directly. Export a snapshot and work against that.

---

## 2. Export a snapshot (one command)

```bash
pnpm quant:export
```

That runs `scripts/export-quant-snapshot.ts`, which opens the gold DB read-only, joins
the committed incident registry, and writes a snapshot under
`outputs/nba-quant-lab/snapshots/<id>/` (Parquet + `snapshot.duckdb` + `manifest.json` +
`feature_catalog.{json,md}` + `splits.json`).

**There is no pull step before exporting.** The gold DB already holds the canonical
board, so you can export and model straight from gold.

### The default is the FULL corpus; sampling is opt-in

| invocation                         | `manifest.selection.mode` | games selected                                                |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------- |
| `pnpm quant:export` _(no flag)_    | `full-corpus`             | every board-eligible game ∪ every incident game with a window |
| `pnpm quant:export -- --sample 15` | `incident-plus-sample`    | ALL incident games + 15 deterministic regular-season games    |
| `pnpm quant:export -- --games a,b` | `explicit-games`          | exactly the listed ids that have a local window               |

`--limit N`, `--since DATE|ISO`, and `--until DATE|ISO` post-filter whatever was selected
on any path. Date-only `--since` starts at `00:00:00Z`; date-only `--until` is inclusive
through `23:59:59Z`. `--seed N` and `--out <dir>` are also accepted (default seed 42,
default out root `outputs/nba-quant-lab/snapshots`). Sampling is **never** implicit —
omitting `--sample` gives you the full corpus.

> Passing flags through pnpm: put a `--` separator first, e.g.
> `pnpm quant:export -- --sample 15 --since 2026-04-01`.

You can also trigger an export from the app: the **Export snapshot** action on
`/research` POSTs `/v1/research/export`, which enqueues the same
`scripts/export-quant-snapshot.ts` job the CLI runs. The CLI and the button produce the
same artifact tree.

---

## 3. Open and query a snapshot

Everything you need is in the snapshot dir. `board_observations.parquet` is the only
causal model input; the rest are truth / provenance. Point `$SNAP` at the dir:

```bash
SNAP=/absolute/path/to/outputs/nba-quant-lab/snapshots/<id>
```

### DuckDB (CLI or SQL)

```sql
-- the bundled snapshot.duckdb has every table; or read parquet directly
SELECT game_id, count(*) AS buckets, avg(intensity) AS mean_intensity
FROM read_parquet('OUTPUTS/board_observations.parquet')
GROUP BY game_id
ORDER BY buckets DESC
LIMIT 10;

-- or attach the bundled file and query named tables
-- duckdb -c "ATTACH 'OUTPUTS/snapshot.duckdb' AS s; SELECT * FROM s.board_observations LIMIT 5;"
```

(Replace `OUTPUTS` with `$SNAP`.) The bundled `snapshot.duckdb` carries the same tables
as one file — useful for SQL pushdown and to prove the loader is backend-agnostic.

### pandas

```python
import pandas as pd
obs = pd.read_parquet(f"{SNAP}/board_observations.parquet")
incidents = pd.read_parquet(f"{SNAP}/incidents.parquet")
print(obs.groupby("game_id")["intensity"].agg(["count", "mean"]).head())
```

### polars

```python
import polars as pl
obs = pl.read_parquet(f"{SNAP}/board_observations.parquet")
print(obs.group_by("game_id").agg(pl.len().alias("buckets"), pl.col("intensity").mean()))
```

### R (arrow / duckdb)

```r
library(arrow)
obs <- read_parquet(file.path(SNAP, "board_observations.parquet"))

# or via duckdb against the bundled file
library(DBI); library(duckdb)
con <- dbConnect(duckdb(), file.path(SNAP, "snapshot.duckdb"))
obs <- dbGetQuery(con, "SELECT * FROM board_observations")
```

Read `feature_catalog.json` before you choose features: it carries the per-field
`causal_or_noncausal` and `leakage_safe_for_online_scoring` flags. If a field is not
leakage-safe, it is truth, not input.

---

## 4. Run and compare the built-in baselines

Two baselines ship as the bars to beat: `robust_mad` (robust statistics) and
`state_space_current` (Kalman-style state space). `virtual_source_state_space` is a
registered research candidate (per-virtual-source Kalman filters with a
precision-weighted combine — see `docs/moniac-pipeline-plan-and-code-draft.md`),
not a baseline. The remaining registered id, `template_model`, is a copy-me
example — not a real candidate.

```bash
SNAP=/absolute/path/to/outputs/nba-quant-lab/snapshots/<id>

pnpm quant list-models
pnpm quant run-model robust_mad "$SNAP"
pnpm quant compare robust_mad state_space_current virtual_source_state_space --snapshot "$SNAP"
```

`pnpm quant <cmd>` forwards verbatim to `python -m nba_sidecar.research <cmd>` via
`scripts/quant.ts`. If the sidecar venv is not synced yet, the equivalent direct form is:

```bash
cd apps/nba-sidecar
uv sync --extra research   # pandas, pyarrow, duckdb, numpy, matplotlib
uv run --extra research python -m nba_sidecar.research compare \
    robust_mad state_space_current virtual_source_state_space --snapshot "$SNAP"
```

Note the `compare` shape: models are **positional** and `--snapshot` is a **required
flag** (this differs from `run-model` / `score-predictions`, where the snapshot is
positional). `compare` needs ≥ 2 models and writes a leaderboard.

For the recorded baseline numbers (scoreable recall, fires/game, residual coverage) do
not invent fresh figures — cite the recorded `REAL-compare-sample-fixed` run in
`docs/nba-quant-lab.md` §6, or read the `leaderboard.json` from your own run.

Two diagnostic CLIs sit on top of `compare` (both honest-by-construction: missing
dimensions stay `None`/`n/a`, never fabricated — provenance in
`docs/moniac-pipeline-plan-and-code-draft.md`):

```bash
cd apps/nba-sidecar

# Pareto-front dominance over (recall ↑, fires/game ↓ [, ECE ↓ when available]):
# which models are nondominated operating points, which are strictly worse.
uv run --extra research python -m nba_sidecar.research.evaluation.pareto \
    --snapshot "$SNAP" \
    --models robust_mad state_space_current virtual_source_state_space

# Expected Calibration Error: does a bounded 0-1 score (regimeScore diagnostic
# when present, else top-level score) match the empirical fire rate per bin?
# --pareto appends the full three-dimension front with ECE wired in.
uv run --extra research python -m nba_sidecar.research.evaluation.calibration \
    --snapshot "$SNAP" --model virtual_source_state_space --bins 10 --pareto
```

---

## 5. Add a Python model (the `BoardModel` + `@register` pattern)

Models live in `apps/nba-sidecar/src/nba_sidecar/research/models/`. The base class and
registry are in `models/base.py`; the copy-me skeleton is `models/template_model.py`.

```bash
cd apps/nba-sidecar/src/nba_sidecar/research/models
cp template_model.py my_model.py
```

Set the identity ClassVars, then implement `default_params` and `score`. The `@register`
decorator self-registers the class on import. `score` must emit **exactly one
`PredictionRow` per input bucket**, must be **causal** (scoring bucket _i_, read only
buckets _0..i_), and should set `fired=True` only where warmed up.

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
    references = ("arXiv:XXXX.XXXXX",)

    def default_params(self) -> dict[str, Any]:
        return {"warmup_buckets": 8}  # JSON-serializable; callers can override

    def score(self, request: ScoreRequest) -> ScoreResult:
        params = self.resolve_params(request.params)
        preds: list[PredictionRow] = []
        for i, b in enumerate(request.series.buckets):
            # causal logic over buckets[0..i] using b.intensity,
            # b.active_market_count, b.source_count, b.source_dominance,
            # b.source_disagreement, b.game_elapsed_seconds ...
            preds.append(PredictionRow(
                game_id=request.series.game_id,
                bucket_start=b.bucket_start,
                score=...,        # continuous surprise score
                fired=...,        # bool; only where warmed up
                diagnostics={"threshold": ..., "warmed": float(warmed)},
            ))
        return self._validate_result(request, ScoreResult(
            model_id=self.id, game_id=request.series.game_id, predictions=preds))
```

Emit `threshold` and `warmed` in `diagnostics` if you want the residual-coverage
diagnostic to light up (see §7). Then run it:

```bash
pnpm quant list-models                                   # confirm my_model is registered
pnpm quant run-model my_model "$SNAP"
pnpm quant compare my_model robust_mad state_space_current --snapshot "$SNAP"
```

---

## 6. Score an external `predictions.parquet` (R, notebooks, anything)

You do not have to write Python. Any tool can emit a `predictions.parquet` and have it
scored by the **same** evaluator native models use — both paths funnel through one pure
`score_predictions` function.

### The required prediction schema

Exactly these four columns are required (extra diagnostic columns are allowed and
encouraged):

| column         | type                       | meaning                                                  |
| -------------- | -------------------------- | -------------------------------------------------------- |
| `game_id`      | string                     | Game the bucket belongs to (e.g. `nba-0042500222`).      |
| `bucket_start` | datetime / ISO-8601 string | Joins back to `board_observations.bucket_start`.         |
| `score`        | float                      | Continuous alert/surprise score for the bucket.          |
| `fired`        | bool                       | Alert decision; True only where your model is warmed up. |

Optional diagnostic columns that unlock the residual-coverage diagnostic and exact
interval overlap: `bucket_end`, `threshold`, `intensity`, `warmed`. Omit `threshold` and
residual coverage is reported as `null` — unavailable, not penalized. (Required columns
are pinned in `research/contracts/columns.py` as `PREDICTION_COLUMNS`.)

### Score it

```bash
pnpm quant score-predictions /path/to/predictions.parquet "$SNAP" \
    --model-id my_external_model
```

This validates your file against the same column spec native predictions satisfy, then
runs the identical scorer and writes a run directory.

---

## 7. How metrics are computed

The scorer (`research/evaluation/scorer.py`) is a **pure join to pre-materialized
truth**: it reads your predictions and the four label tables, never
`board_observations`. A prediction fires over the half-open interval
`[bucket_start_sec, bucket_end_sec)`.

- **Scoreable-incident recall** — an incident is _caught_ iff some FIRED bucket in its
  game overlaps its catch window `[window_start_sec, window_end_sec]`. Only `scoreable`
  incidents count toward the denominator (e.g. "4 / 15").
- **fires/game** — the mean, over evaluated games, of the fired-bucket count. This is the
  alert-burden number. Do **not** confuse it with `eval_summary.fire_rate`, which is
  fired buckets / warmed buckets — a different burden notion.
- **tape-outlier recall** — a `market_outlier_episode` is caught iff some FIRED bucket
  overlaps the episode span. A denser secondary recall target than incidents.
- **residual / calibration coverage** — over warmed buckets, the fraction whose
  `intensity` stayed within the model's own threshold band (`intensity ≤ threshold`).
  Requires `threshold` / `warmed` diagnostics; `null` when a producer omits them. It
  characterizes the quality of the unmatched fire budget — recall bought by spamming
  fires is not a win.
- **the casebook** (`research/evaluation/casebook.py`) — a per-run narrative of **caught**
  incidents, **missed** incidents, and **worst false positives** (fired buckets in no
  catch window and no tape episode — pure burden). Every caught/missed entry is annotated
  with the game's `source_coverage`, so you can tell a real _model_ miss from a
  _coverage_ miss (little canonical tape to fire on).

The recorded bar (from `docs/nba-quant-lab.md` §6): **better known-case recall at the
same fires/game, plus honest residual coverage.** Lift scoreable recall above the
incumbent at equal burden, or match the incumbent's recall at far lower burden, and you
have moved the bar.

---

## 8. Where outputs land

```
outputs/nba-quant-lab/
  snapshots/<id>/    *.parquet  snapshot.duckdb  manifest.json  feature_catalog.{json,md}  splits.json
  runs/<id>/         metrics.json  casebook.json  leaderboard.json  run-manifest.json  REPORT.md  report.html
```

Every `run-model` / `score-predictions` / `compare` writes a run dir. `REPORT.md` /
`report.html` render the leaderboard + casebook; `pnpm quant report <run_dir>`
re-renders them from the persisted JSON without re-scoring.

---

## 9. Compare models on one leaderboard

```bash
pnpm quant compare my_model my_external_pull robust_mad state_space_current --snapshot "$SNAP"
```

`compare` runs every named model against the same snapshot truth and emits a single
`leaderboard.json` ranking them on the same metrics. To score an external file into the
same comparison, run `score-predictions` first (it writes its own run), or register a
native model and include its id here. Always state which snapshot and which truth
universe a leaderboard was measured on (see `docs/nba-quant-lab.md` §6 on the
games-with-truth universe vs the test holdout).

---

## 10. Pulling / repairing extra source coverage (OPTIONAL)

This is **not** the starting point. The gold DB already holds the canonical board, so you
export and model from gold directly (§2). You only reach for a pull when you want to
**augment** with sources that are not persisted in the gold DB — DraftKings / FanDuel via
Odds-API.io — or to fill **new date windows**.

```bash
pnpm quant:pull   # scripts/research-pull.ts; "Add/repair source data" on /research
```

Pulled data lands as `artifact_only` coverage (`source_coverage.class == "artifact_only"`)
— **non-canonical board input**. Do not treat it as authoritative; it is augmentation,
not gold, and is never required before exporting or modeling the canonical board.

---

## 11. Provenance (every snapshot and run carries a manifest)

Reproducibility is enforced by manifests, not convention.

- **`manifest.json`** (per snapshot) records: `snapshotId`, `schemaVersion`,
  `generatedAt`, the exact `generationCommand`, the **seed**, the **git commit**, the
  gold-DB **path + size + mtime** (the authoritative record of which DB you exported, and
  its exact size at export time), the incident-registry path + **sha256** + count, the
  date range, the live-board config, the eligible sources, per-table counts, the
  `selection.mode`, and per-game tick diagnostics.
- **`splits.json`** (per snapshot) records the seeded (seed 42) game-level train/test
  holdout. All incident games are forced into `train` so incident windows can never leak
  into the test side — which is exactly why incident recall is a truth-universe metric,
  not a test-split metric.
- **`run-manifest.json`** (per run) records the run command and the snapshot it scored.

Re-running the recorded `generationCommand` against the same gold DB + registry
reproduces the snapshot; replaying the same model + params against the same snapshot
reproduces the metrics.

---

## 12. Things quants might actually like

- **DuckDB snapshot.** Every table also ships as one `snapshot.duckdb` file — SQL,
  pushdown, joins, no loader needed.
- **External-predictions bridge.** Score R / Julia / notebook output through the exact
  same scorer as native models — a structural guarantee, not a courtesy path (§6).
- **Casebook.** Caught / missed / worst-false-positive narrative per run, each annotated
  with `source_coverage` so a coverage miss never reads as a model miss (§7).
- **Source-coverage table.** Per game × source × market-family × window coverage class,
  so you always know whether there was canonical tape to fire on.
- **Reproducible seeded splits.** `splits.json`, seed 42, incident games pinned to train.
- **Feature catalog.** `feature_catalog.{json,md}` is the per-field leakage authority —
  `leakage_safe_for_online_scoring` settles every "is this fair game?" question.
- **`bootstrap` subcommand.** `pnpm quant bootstrap` writes a runnable starter notebook
  (`notebooks/quant-lab-starter.ipynb`) pointed at a snapshot — open it and you are
  loading the parquet in one cell.
- **`doctor` preflight.** `pnpm quant doctor "$SNAP"` runs a coverage / leakage /
  scoreability check on a snapshot before you sink time into modeling it.

---

## Where to go next

- Canonical contract, schemas, the recorded bar: **`docs/nba-quant-lab.md`**.
- What model family to try and why (with references): **`docs/research-menu.md`**.
- Base class + registry + one-row-per-bucket contract:
  `apps/nba-sidecar/src/nba_sidecar/research/models/base.py`.
- Copy-me example: `apps/nba-sidecar/src/nba_sidecar/research/models/template_model.py`.
- The shared scorer (how you are graded): `research/evaluation/scorer.py`.
- Column contracts: `research/contracts/columns.py`.
