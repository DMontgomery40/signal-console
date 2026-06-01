"""Runtime-agnostic contracts for the quant-lab research package.

The contracts are split into two layers:

1. **Pydantic models** (this package) — validate a single row or a single
   request/result object. Used for unit-level validation and for constructing
   model inputs in Python.

2. **Parquet column specs** (:mod:`.columns`) — a documented, declarative
   description of every column we expect in each snapshot parquet, in the
   prediction parquet, and in the evaluation-output parquet. These specs are the
   bridge that lets an *external* producer (an R script, a notebook, a different
   language entirely) write a ``predictions.parquet`` that validates identically
   to one written here: validation is performed against the column spec, not
   against any Python-specific serialization.
"""

from __future__ import annotations

from .columns import (
    BOARD_OBSERVATION_COLUMNS,
    EVAL_GAME_COLUMNS,
    EVAL_SUMMARY_COLUMNS,
    INCIDENT_COLUMNS,
    MARKET_OUTLIER_EPISODE_COLUMNS,
    PLAYER_PROP_TICKS_COLUMNS,
    PREDICTION_COLUMNS,
    SCORE_WINDOW_COLUMNS,
    SOURCE_COVERAGE_COLUMNS,
    ColumnSpec,
    ParquetTableSpec,
    validate_dataframe,
)
from .schemas import (
    BoardObservationRow,
    EvalGameRow,
    EvalSummaryRow,
    GameBucketSeries,
    IncidentRow,
    MarketOutlierEpisodeRow,
    ModelInputBucket,
    PlayerPropTickRow,
    PredictionRow,
    ScoreWindowRow,
    SourceCoverageRow,
)

__all__ = [
    # column specs
    "ColumnSpec",
    "ParquetTableSpec",
    "validate_dataframe",
    "BOARD_OBSERVATION_COLUMNS",
    "INCIDENT_COLUMNS",
    "SCORE_WINDOW_COLUMNS",
    "MARKET_OUTLIER_EPISODE_COLUMNS",
    "SOURCE_COVERAGE_COLUMNS",
    "PLAYER_PROP_TICKS_COLUMNS",
    "PREDICTION_COLUMNS",
    "EVAL_GAME_COLUMNS",
    "EVAL_SUMMARY_COLUMNS",
    # pydantic schemas
    "BoardObservationRow",
    "IncidentRow",
    "ScoreWindowRow",
    "MarketOutlierEpisodeRow",
    "SourceCoverageRow",
    "PlayerPropTickRow",
    "ModelInputBucket",
    "GameBucketSeries",
    "PredictionRow",
    "EvalGameRow",
    "EvalSummaryRow",
]
