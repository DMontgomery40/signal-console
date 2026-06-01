"""Build / validate the predictions frame both scoring paths consume.

``predictions_from_model`` runs a registered :class:`BoardModel` over the loaded
per-game series and flattens its prediction rows (plus diagnostics, plus the
causal ``intensity`` and ``bucket_end`` carried for the residual-coverage
diagnostic and exact-interval overlap) into one tidy DataFrame.

``load_external_predictions`` reads an externally produced ``predictions.parquet``
and validates it against the SAME :data:`PREDICTION_COLUMNS` spec, so an R script
or notebook can feed the identical scorer. This is the R/notebook bridge.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ..contracts import PREDICTION_COLUMNS, GameBucketSeries, validate_dataframe
from ..models import get_model
from ..models.base import ScoreRequest


def predictions_from_model(
    model_id: str,
    series_by_game: dict[str, GameBucketSeries],
    *,
    params: dict | None = None,
) -> pd.DataFrame:
    """Run a registered model over every game series; return a predictions frame.

    The frame carries the four contract columns (game_id, bucket_start, score,
    fired) plus ``bucket_end`` and ``intensity`` (from the causal input bucket)
    and any model diagnostics (``threshold``, ``warmed``, ...). The extra columns
    are what enable exact-interval overlap and the residual-coverage diagnostic;
    they are optional from the scorer's perspective.
    """
    model = get_model(model_id)
    rows: list[dict] = []
    for gid, series in series_by_game.items():
        result = model.score(ScoreRequest(series=series, params=params or {}))
        # zip predictions back to input buckets to recover intensity + bucket_end
        for pred, bucket in zip(result.predictions, series.buckets, strict=True):
            row = {
                "game_id": pred.game_id,
                "bucket_start": pred.bucket_start.isoformat(),
                "bucket_end": bucket.bucket_end.isoformat(),
                "score": float(pred.score),
                "fired": bool(pred.fired),
                "intensity": float(bucket.intensity),
            }
            for k, v in pred.diagnostics.items():
                # do not clobber contract columns; namespace nothing else needed
                row[k] = float(v)
            rows.append(row)
    df = pd.DataFrame(rows)
    # the model output is, by construction, a valid predictions frame
    validate_dataframe(df, PREDICTION_COLUMNS)
    return df


def load_external_predictions(path: str | Path) -> pd.DataFrame:
    """Read + validate an external predictions.parquet (R / notebook bridge).

    Validates against the same column spec native predictions satisfy, so the
    downstream scorer treats both identically. Extra diagnostic columns (e.g. a
    producer that also emits ``threshold``/``intensity``) are allowed and will
    light up the residual-coverage diagnostic.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"external predictions not found: {p}")
    if p.suffix == ".csv":
        df = pd.read_csv(p)
    else:
        df = pd.read_parquet(p)
    return validate_dataframe(df, PREDICTION_COLUMNS)


__all__ = ["predictions_from_model", "load_external_predictions"]
