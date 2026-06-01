"""Evaluator: orchestrate native + external scoring against snapshot truth.

Two entry points, both converging on the single shared scorer
:func:`~.scorer.score_predictions`:

- :func:`evaluate_model` -- load the snapshot series, run a registered model to
  build predictions, then score by JOINING to materialized truth.
- :func:`evaluate_external` -- validate an external ``predictions.parquet`` and
  score it IDENTICALLY (same scorer, same truth, same join, same metrics).

Neither path recomputes scoreability, catch windows, or tape episodes: the
scorer only ever sees a :class:`~.truth.SnapshotTruth`, which has no handle on
board_observations.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ..loader import load_game_series
from .casebook import Casebook, build_casebook
from .predictions import load_external_predictions, predictions_from_model
from .scorer import ScoreResultBundle, score_predictions
from .truth import SnapshotTruth, load_truth


def _resolve_games(truth: SnapshotTruth, games: list[str] | None) -> list[str]:
    if games is not None:
        return sorted(games)
    return sorted(truth.games_with_truth())


def evaluate_model(
    model_id: str,
    snapshot_path: str | Path,
    *,
    params: dict | None = None,
    games: list[str] | None = None,
    truth: SnapshotTruth | None = None,
) -> tuple[ScoreResultBundle, Casebook, pd.DataFrame]:
    """Run a registered model over the snapshot and score against truth.

    Returns ``(bundle, casebook, predictions_df)``. The predictions frame is
    returned so callers can persist the exact predictions that produced the
    metrics (run reproducibility).
    """
    truth = truth or load_truth(snapshot_path)
    series = load_game_series(snapshot_path)
    eval_games = _resolve_games(truth, games)
    preds = predictions_from_model(model_id, series, params=params)
    bundle = score_predictions(preds, truth, model_id=model_id, games=eval_games)
    casebook = build_casebook(bundle, truth, preds)
    return bundle, casebook, preds


def evaluate_external(
    predictions_path: str | Path,
    snapshot_path: str | Path,
    *,
    model_id: str = "external",
    games: list[str] | None = None,
    truth: SnapshotTruth | None = None,
) -> tuple[ScoreResultBundle, Casebook, pd.DataFrame]:
    """Validate + score an external predictions.parquet, IDENTICALLY to a model."""
    truth = truth or load_truth(snapshot_path)
    preds = load_external_predictions(predictions_path)
    eval_games = _resolve_games(truth, games)
    bundle = score_predictions(preds, truth, model_id=model_id, games=eval_games)
    casebook = build_casebook(bundle, truth, preds)
    return bundle, casebook, preds


__all__ = ["evaluate_model", "evaluate_external"]
