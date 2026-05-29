"""The single, shared, pure scorer: predictions x materialized-truth -> metrics.

Both evaluation paths converge here:

- the **native** path (:mod:`.evaluator` ``evaluate_model``) runs a registered
  ``BoardModel`` over the loaded series to build a predictions frame, then calls
  :func:`score_predictions`;
- the **external** path (``score_external_predictions``) validates an
  externally produced ``predictions.parquet`` against ``PREDICTION_COLUMNS`` and
  calls the *same* :func:`score_predictions`.

Because both paths funnel through one function, "external predictions are scored
IDENTICALLY to a native model" is a structural fact, not a hope.

Scoring is a pure JOIN to pre-materialized truth (:class:`SnapshotTruth`). It
reads predictions + the four label tables and nothing else; it never touches
``board_observations`` and so cannot recompute scoreability, catch windows, or
tape episodes.

Join semantics (chosen once, here, and tested in the unit suite):

- A prediction bucket fires over the half-open interval
  ``[bucket_start_sec, bucket_end_sec)``.
- **Incident caught** iff some FIRED bucket in the incident's game overlaps the
  incident's catch window ``[window_start_sec, window_end_sec]``
  (overlap: ``bucket_end_sec > window_start_sec and bucket_start_sec <
  window_end_sec``). Only ``scoreable`` incidents count.
- **Tape-outlier caught** iff some FIRED bucket in the episode's game overlaps
  the episode span ``[start_sec, end_sec]``.
- **fires/game** = mean over evaluated games of fired-bucket count.
- **burden** = total fired buckets; **per-game outlier burden** = total fired
  buckets / number of distinct tape episodes in evaluated games (how many alerts
  you pay per real tape outlier).
- **residual / calibration coverage** = over warmed buckets, fraction whose
  intensity stayed within the model's own threshold band
  (``intensity <= threshold``). Requires the ``threshold``/``warmed``
  diagnostics; ``None`` when a producer (e.g. an external parquet) omits them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from .truth import SnapshotTruth

_BUCKET_DEFAULT_SECONDS = 60  # board buckets are 1 minute; used only if end missing


def _to_unix_sec(series: pd.Series) -> pd.Series:
    """ISO-8601 (or datetime) -> integer unix seconds, UTC."""
    from pandas.api import types as pdt

    if pdt.is_datetime64_any_dtype(series):
        dt = pd.to_datetime(series, utc=True, errors="raise")
    else:
        # string inputs may carry mixed fractional-second precision; ISO8601
        # parses them uniformly where plain inference would NaT a subset.
        dt = pd.to_datetime(series, utc=True, errors="raise", format="ISO8601")
    return (dt.astype("int64") // 1_000_000_000).astype("int64")


def _intervals_overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return a_end > b_start and a_start < b_end


@dataclass(frozen=True)
class IncidentResult:
    incident_id: str
    game_id: str
    caught: bool
    window_start_sec: int
    window_end_sec: int
    n_fires_in_window: int


@dataclass(frozen=True)
class EpisodeResult:
    episode_id: str
    game_id: str
    caught: bool
    start_sec: int
    end_sec: int
    peak_severity: float
    diagnosis: str | None


@dataclass(frozen=True)
class GameMetrics:
    game_id: str
    fired_buckets: int
    warmed_buckets: int
    total_buckets: int
    incidents_total: int
    incidents_caught: int
    episodes_total: int
    episodes_caught: int


@dataclass(frozen=True)
class ScoreResultBundle:
    """Everything the leaderboard, casebook, and report need from one scoring."""

    model_id: str
    games_evaluated: list[str]
    incident_results: list[IncidentResult]
    episode_results: list[EpisodeResult]
    per_game: list[GameMetrics]
    # headline metrics
    incidents_total: int
    incidents_caught: int
    incident_recall: float
    episodes_total: int
    episodes_caught: int
    tape_outlier_recall: float
    total_fires: int
    fires_per_game: float
    per_game_outlier_burden: float | None
    residual_coverage: float | None
    warmed_buckets: int
    has_threshold_diagnostics: bool
    extra: dict = field(default_factory=dict)

    def summary_dict(self) -> dict:
        return {
            "model_id": self.model_id,
            "games_evaluated": len(self.games_evaluated),
            "incidents_total": self.incidents_total,
            "incidents_caught": self.incidents_caught,
            "incident_recall": self.incident_recall,
            "episodes_total": self.episodes_total,
            "episodes_caught": self.episodes_caught,
            "tape_outlier_recall": self.tape_outlier_recall,
            "total_fires": self.total_fires,
            "fires_per_game": self.fires_per_game,
            "per_game_outlier_burden": self.per_game_outlier_burden,
            "residual_coverage": self.residual_coverage,
            "warmed_buckets": self.warmed_buckets,
            "has_threshold_diagnostics": self.has_threshold_diagnostics,
        }


def _prepare_predictions(predictions: pd.DataFrame) -> pd.DataFrame:
    df = predictions.copy()
    df["game_id"] = df["game_id"].astype(str)
    df["bucket_start_sec"] = _to_unix_sec(df["bucket_start"])
    if "bucket_end" in df.columns and df["bucket_end"].notna().any():
        df["bucket_end_sec"] = _to_unix_sec(df["bucket_end"])
    else:
        df["bucket_end_sec"] = df["bucket_start_sec"] + _BUCKET_DEFAULT_SECONDS
    df["fired"] = df["fired"].astype(bool)
    return df


def score_predictions(
    predictions: pd.DataFrame,
    truth: SnapshotTruth,
    *,
    model_id: str,
    games: list[str] | None = None,
) -> ScoreResultBundle:
    """Score a predictions frame against pre-materialized truth by JOINING.

    Parameters
    ----------
    predictions:
        Validated predictions frame. Required columns: ``game_id``,
        ``bucket_start``, ``score``, ``fired``. Optional diagnostic columns
        ``bucket_end``, ``threshold``, ``intensity``, ``warmed`` enable the
        residual-coverage diagnostic and exact-interval overlap.
    truth:
        The four materialized truth tables. **Not** board_observations.
    games:
        Evaluation universe. Defaults to every game that carries at least one
        scoreable window or tape episode (``truth.games_with_truth()``) -- which
        is the honest universe; using the snapshot's test holdout would yield
        0/0 incident recall.
    """
    preds = _prepare_predictions(predictions)
    universe = set(games) if games is not None else truth.games_with_truth()
    # only evaluate games we actually have predictions for AND that are in scope
    pred_games = set(preds["game_id"].unique())
    games_evaluated = sorted(universe & pred_games)

    preds = preds[preds["game_id"].isin(games_evaluated)].copy()
    fired = preds[preds["fired"]].copy()

    # Pre-group fired intervals per game for fast overlap checks.
    fired_by_game: dict[str, list[tuple[int, int]]] = {}
    for gid, grp in fired.groupby("game_id"):
        fired_by_game[str(gid)] = list(
            zip(grp["bucket_start_sec"].tolist(), grp["bucket_end_sec"].tolist())
        )

    # -- incidents (scoreable only) ----------------------------------------
    windows = truth.scoreable_windows()
    windows = windows[windows["game_id"].astype(str).isin(games_evaluated)]
    incident_results: list[IncidentResult] = []
    for _, w in windows.iterrows():
        gid = str(w["game_id"])
        ws, we = int(w["window_start_sec"]), int(w["window_end_sec"])
        intervals = fired_by_game.get(gid, [])
        hits = [(bs, be) for (bs, be) in intervals if _intervals_overlap(bs, be, ws, we)]
        incident_results.append(
            IncidentResult(
                incident_id=str(w["incident_id"]),
                game_id=gid,
                caught=len(hits) > 0,
                window_start_sec=ws,
                window_end_sec=we,
                n_fires_in_window=len(hits),
            )
        )

    incidents_total = len(incident_results)
    incidents_caught = sum(1 for r in incident_results if r.caught)
    incident_recall = (incidents_caught / incidents_total) if incidents_total else 0.0

    # -- tape-outlier episodes ---------------------------------------------
    episodes = truth.market_outlier_episodes
    episodes = episodes[episodes["game_id"].astype(str).isin(games_evaluated)]
    episode_results: list[EpisodeResult] = []
    for _, e in episodes.iterrows():
        gid = str(e["game_id"])
        es, ee = int(e["start_sec"]), int(e["end_sec"])
        intervals = fired_by_game.get(gid, [])
        caught = any(_intervals_overlap(bs, be, es, ee) for (bs, be) in intervals)
        episode_results.append(
            EpisodeResult(
                episode_id=str(e["episode_id"]),
                game_id=gid,
                caught=caught,
                start_sec=es,
                end_sec=ee,
                peak_severity=float(e["peak_severity"]),
                diagnosis=(None if pd.isna(e.get("diagnosis")) else str(e.get("diagnosis"))),
            )
        )

    episodes_total = len(episode_results)
    episodes_caught = sum(1 for r in episode_results if r.caught)
    tape_outlier_recall = (episodes_caught / episodes_total) if episodes_total else 0.0

    # -- burden + per-game metrics -----------------------------------------
    total_fires = int(preds["fired"].sum())
    fires_per_game = (total_fires / len(games_evaluated)) if games_evaluated else 0.0
    per_game_outlier_burden = (total_fires / episodes_total) if episodes_total else None

    # -- residual / calibration coverage -----------------------------------
    has_threshold = "threshold" in preds.columns and "intensity" in preds.columns
    warmed_total = 0
    residual_coverage: float | None = None
    if "warmed" in preds.columns:
        warmed_mask = preds["warmed"].astype(float) >= 1.0
    else:
        warmed_mask = pd.Series(False, index=preds.index)
    warmed_total = int(warmed_mask.sum())
    if has_threshold and warmed_total > 0:
        warmed = preds[warmed_mask]
        within = (warmed["intensity"] <= warmed["threshold"]).sum()
        residual_coverage = float(within / warmed_total)

    # -- per-game rollup ----------------------------------------------------
    per_game: list[GameMetrics] = []
    inc_by_game: dict[str, list[IncidentResult]] = {}
    for r in incident_results:
        inc_by_game.setdefault(r.game_id, []).append(r)
    ep_by_game: dict[str, list[EpisodeResult]] = {}
    for r in episode_results:
        ep_by_game.setdefault(r.game_id, []).append(r)
    for gid in games_evaluated:
        gp = preds[preds["game_id"] == gid]
        gincs = inc_by_game.get(gid, [])
        geps = ep_by_game.get(gid, [])
        if "warmed" in gp.columns:
            gwarm = int((gp["warmed"].astype(float) >= 1.0).sum())
        else:
            gwarm = 0
        per_game.append(
            GameMetrics(
                game_id=gid,
                fired_buckets=int(gp["fired"].sum()),
                warmed_buckets=gwarm,
                total_buckets=len(gp),
                incidents_total=len(gincs),
                incidents_caught=sum(1 for r in gincs if r.caught),
                episodes_total=len(geps),
                episodes_caught=sum(1 for r in geps if r.caught),
            )
        )

    return ScoreResultBundle(
        model_id=model_id,
        games_evaluated=games_evaluated,
        incident_results=incident_results,
        episode_results=episode_results,
        per_game=per_game,
        incidents_total=incidents_total,
        incidents_caught=incidents_caught,
        incident_recall=incident_recall,
        episodes_total=episodes_total,
        episodes_caught=episodes_caught,
        tape_outlier_recall=tape_outlier_recall,
        total_fires=total_fires,
        fires_per_game=fires_per_game,
        per_game_outlier_burden=per_game_outlier_burden,
        residual_coverage=residual_coverage,
        warmed_buckets=warmed_total,
        has_threshold_diagnostics=has_threshold,
    )


__all__ = [
    "score_predictions",
    "ScoreResultBundle",
    "IncidentResult",
    "EpisodeResult",
    "GameMetrics",
]
