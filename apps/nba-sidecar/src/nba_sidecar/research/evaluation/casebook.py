"""Casebook: per-run narrative of caught / missed incidents + worst false fires.

For one scored model the casebook emits three case lists:

- **caught** incidents (a fired bucket landed in the catch window);
- **missed** incidents (no fired bucket in the window) -- each annotated with
  ``source_coverage`` for the game so a reader can tell a *model* miss
  (good coverage, model still didn't fire) from a *data-absence* miss
  (coverage is partial/artifact_only/missing, so there was little tape to fire
  on);
- **worst false positives** -- the highest-score fired buckets in evaluated
  games that fall in NO catch window and NO tape episode (pure burden).

Each case also carries a tiny, self-contained matplotlib ``chart_snippet``: a
runnable Python string that plots the game's intensity with the window/episode
span and fired markers shaded. Snippets are emitted as text (not rendered) so
the casebook stays cheap and deterministic; the report renderer can exec one on
demand.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from .scorer import ScoreResultBundle
from .truth import SnapshotTruth


def _coverage_annotation(truth: SnapshotTruth, game_id: str) -> dict:
    """Summarize a game's source coverage into a model-vs-data verdict."""
    cov = truth.coverage_for_game(game_id)
    if cov.empty:
        return {
            "verdict": "data_absence",
            "reason": "no source_coverage rows for game",
            "classes": {},
            "eligible_windows": 0,
        }
    classes = cov["class"].astype(str).value_counts().to_dict()
    eligible = int(cov["eligible"].fillna(False).astype(bool).sum()) if "eligible" in cov else 0
    canonical = int(classes.get("canonical", 0)) + int(classes.get("snapshot_eligible", 0))
    verdict = "model" if canonical > 0 else "data_absence"
    return {
        "verdict": verdict,
        "reason": (
            f"{canonical} canonical/eligible coverage rows"
            if verdict == "model"
            else "no canonical/eligible coverage; little tape to fire on"
        ),
        "classes": {str(k): int(v) for k, v in classes.items()},
        "eligible_windows": eligible,
    }


def _chart_snippet(
    *,
    title: str,
    game_id: str,
    span: tuple[int, int] | None,
    span_label: str,
) -> str:
    span_lo = span[0] if span else "None"
    span_hi = span[1] if span else "None"
    return (
        "import matplotlib.pyplot as plt\n"
        "import pandas as pd\n"
        "from nba_sidecar.research.loader import read_board_observations\n"
        "from nba_sidecar.research.evaluation.scorer import _to_unix_sec\n"
        f"SNAPSHOT = '<snapshot dir>'  # e.g. outputs/nba-quant-lab/snapshots/sample-fixed\n"
        f"GAME = {game_id!r}\n"
        f"PREDICTIONS = '<run predictions.parquet>'\n"
        "bo = read_board_observations(SNAPSHOT)\n"
        "bo = bo[bo['game_id'] == GAME].copy()\n"
        "bo['t'] = _to_unix_sec(bo['bucket_start'])\n"
        "preds = pd.read_parquet(PREDICTIONS)\n"
        "preds = preds[preds['game_id'] == GAME].copy()\n"
        "preds['t'] = _to_unix_sec(preds['bucket_start'])\n"
        "fig, ax = plt.subplots(figsize=(10, 3))\n"
        "ax.plot(bo['t'], bo['intensity'], lw=1, color='steelblue', label='intensity')\n"
        "fires = preds[preds['fired']]\n"
        "ax.scatter(fires['t'], [bo['intensity'].max()] * len(fires), "
        "marker='v', color='crimson', label='fired')\n"
        f"if {span_lo} is not None:\n"
        f"    ax.axvspan({span_lo}, {span_hi}, color='gold', alpha=0.3, label={span_label!r})\n"
        f"ax.set_title({title!r}); ax.set_xlabel('unix sec'); ax.legend()\n"
        "plt.tight_layout(); plt.savefig('case.png', dpi=110)\n"
    )


@dataclass(frozen=True)
class CaseEntry:
    kind: str  # caught | missed | false_positive
    game_id: str
    label: str
    detail: dict
    source_coverage: dict
    chart_snippet: str


@dataclass(frozen=True)
class Casebook:
    model_id: str
    caught: list[CaseEntry] = field(default_factory=list)
    missed: list[CaseEntry] = field(default_factory=list)
    worst_false_positives: list[CaseEntry] = field(default_factory=list)

    def to_dict(self) -> dict:
        def ser(entries: list[CaseEntry]) -> list[dict]:
            return [
                {
                    "kind": e.kind,
                    "game_id": e.game_id,
                    "label": e.label,
                    "detail": e.detail,
                    "source_coverage": e.source_coverage,
                    "chart_snippet": e.chart_snippet,
                }
                for e in entries
            ]

        return {
            "model_id": self.model_id,
            "caught": ser(self.caught),
            "missed": ser(self.missed),
            "worst_false_positives": ser(self.worst_false_positives),
        }


def build_casebook(
    bundle: ScoreResultBundle,
    truth: SnapshotTruth,
    predictions: pd.DataFrame,
    *,
    max_false_positives: int = 5,
) -> Casebook:
    """Assemble the per-run casebook from a scored bundle + truth + predictions."""
    caught: list[CaseEntry] = []
    missed: list[CaseEntry] = []

    for r in bundle.incident_results:
        cov = _coverage_annotation(truth, r.game_id)
        entry = CaseEntry(
            kind="caught" if r.caught else "missed",
            game_id=r.game_id,
            label=r.incident_id,
            detail={
                "window_start_sec": r.window_start_sec,
                "window_end_sec": r.window_end_sec,
                "n_fires_in_window": r.n_fires_in_window,
            },
            source_coverage=cov,
            chart_snippet=_chart_snippet(
                title=f"{bundle.model_id} | {r.incident_id} ({'CAUGHT' if r.caught else 'MISSED'})",
                game_id=r.game_id,
                span=(r.window_start_sec, r.window_end_sec),
                span_label="catch window",
            ),
        )
        (caught if r.caught else missed).append(entry)

    # worst false positives: highest-score fired buckets that miss every window
    # and every tape episode in evaluated games (pure burden).
    preds = predictions.copy()
    preds["game_id"] = preds["game_id"].astype(str)
    from .scorer import _to_unix_sec, _intervals_overlap

    preds = preds[preds["game_id"].isin(bundle.games_evaluated)]
    fired = preds[preds["fired"].astype(bool)].copy()
    if not fired.empty:
        fired["bs"] = _to_unix_sec(fired["bucket_start"])
        if "bucket_end" in fired.columns and fired["bucket_end"].notna().any():
            fired["be"] = _to_unix_sec(fired["bucket_end"])
        else:
            fired["be"] = fired["bs"] + 60

        # spans to avoid (windows + episodes) per game
        avoid: dict[str, list[tuple[int, int]]] = {}
        for w in bundle.incident_results:
            avoid.setdefault(w.game_id, []).append((w.window_start_sec, w.window_end_sec))
        for e in bundle.episode_results:
            avoid.setdefault(e.game_id, []).append((e.start_sec, e.end_sec))

        def is_fp(row) -> bool:
            spans = avoid.get(row["game_id"], [])
            return not any(_intervals_overlap(row["bs"], row["be"], s, t) for (s, t) in spans)

        fired = fired[fired.apply(is_fp, axis=1)]
        fired = fired.sort_values("score", ascending=False).head(max_false_positives)

    worst_fps: list[CaseEntry] = []
    for _, row in fired.iterrows() if not fired.empty else []:
        cov = _coverage_annotation(truth, row["game_id"])
        worst_fps.append(
            CaseEntry(
                kind="false_positive",
                game_id=row["game_id"],
                label=f"{row['game_id']}@{int(row['bs'])}",
                detail={
                    "bucket_start_sec": int(row["bs"]),
                    "score": float(row["score"]),
                    "intensity": (float(row["intensity"]) if "intensity" in row else None),
                },
                source_coverage=cov,
                chart_snippet=_chart_snippet(
                    title=f"{bundle.model_id} | worst FP @ {int(row['bs'])}",
                    game_id=row["game_id"],
                    span=None,
                    span_label="(no truth span)",
                ),
            )
        )

    return Casebook(
        model_id=bundle.model_id,
        caught=caught,
        missed=missed,
        worst_false_positives=worst_fps,
    )


__all__ = ["Casebook", "CaseEntry", "build_casebook"]
