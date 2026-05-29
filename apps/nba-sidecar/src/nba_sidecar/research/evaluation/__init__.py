"""Evaluation subpackage: score model/external predictions against snapshot truth.

The defining property of this package is that it **scores by joining to the
snapshot's pre-materialized truth** (``score_windows``,
``market_outlier_episodes``, ``incidents.scoreable``) and never recomputes
scoreability or episodes from the raw board observations. The scorer
(:func:`scorer.score_predictions`) consumes only a
:class:`truth.SnapshotTruth`, which has no handle on ``board_observations`` --
making the no-recompute property structural rather than aspirational.

Native (``evaluate_model``) and external (``evaluate_external``) paths both
converge on the one shared scorer, so an external ``predictions.parquet`` is
scored identically to a registered model.
"""

from __future__ import annotations

from .artifacts import build_leaderboard, write_run
from .casebook import Casebook, build_casebook
from .doctor import run_doctor
from .evaluator import evaluate_external, evaluate_model
from .predictions import load_external_predictions, predictions_from_model
from .scorer import ScoreResultBundle, score_predictions
from .truth import SnapshotTruth, load_truth

__all__ = [
    "SnapshotTruth",
    "load_truth",
    "score_predictions",
    "ScoreResultBundle",
    "predictions_from_model",
    "load_external_predictions",
    "evaluate_model",
    "evaluate_external",
    "build_casebook",
    "Casebook",
    "build_leaderboard",
    "write_run",
    "run_doctor",
]
