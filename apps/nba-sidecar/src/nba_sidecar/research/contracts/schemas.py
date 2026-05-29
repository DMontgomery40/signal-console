"""Pydantic row/series schemas for the research package.

These complement the declarative :mod:`.columns` specs. The column specs guard
parquet files (including externally produced ones); these pydantic models guard
*in-Python* objects — single rows, the per-game ordered bucket series that feeds
a model, prediction rows, and evaluation outputs.

The model-input schema (:class:`GameBucketSeries`) is the object a
:class:`~nba_sidecar.research.models.base.BoardModel` actually scores. It is
deliberately a thin, ordered, causal view over the snapshot board observations:
one game, buckets sorted ascending, each carrying only leakage-safe causal
fields.
"""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Snapshot row schemas
# ---------------------------------------------------------------------------


class BoardObservationRow(BaseModel):
    """One board-observation bucket row from the snapshot. All fields causal."""

    game_id: str
    bucket_start: datetime
    bucket_end: datetime
    intensity: float = Field(ge=0)
    game_elapsed_seconds: float | None = Field(default=None, ge=0)
    active_market_count: int | None = Field(default=None, ge=0)
    source_count: int | None = Field(default=None, ge=0)
    source_dominance: float | None = Field(default=None, ge=0, le=1)
    source_disagreement: float | None = Field(default=None, ge=0, le=1)

    @field_validator("bucket_start", "bucket_end")
    @classmethod
    def _aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("bucket timestamps must be timezone-aware")
        return value.astimezone(timezone.utc)


class IncidentRow(BaseModel):
    """One misattribution-incident label row (non-causal label-side data)."""

    incident_id: str
    canonical_game_id: str
    scoreable: bool
    event_sec: int
    has_local_window: bool | None = None
    confidence: str | None = None
    stat: str | None = None
    credited_player: str | None = None
    rightful_player: str | None = None


class ScoreWindowRow(BaseModel):
    """One incident catch-window (label-derived; defines the eval target span)."""

    incident_id: str
    game_id: str
    window_start_sec: int
    window_end_sec: int

    @model_validator(mode="after")
    def _ordered(self) -> "ScoreWindowRow":
        if self.window_end_sec < self.window_start_sec:
            raise ValueError("window_end_sec must be >= window_start_sec")
        return self


class MarketOutlierEpisodeRow(BaseModel):
    """One tape-outlier episode (whole-game robust stats; non-causal)."""

    episode_id: str
    game_id: str
    start_sec: int
    end_sec: int
    peak_severity: float
    peak_price_move_z: float | None = None
    diagnosis: str | None = None


class SourceCoverageRow(BaseModel):
    """One source x market_family x window coverage classification row."""

    game_id: str
    source: str
    market_family: str
    window: str
    coverage_class: str = Field(alias="class")
    market_count: int | None = None
    tick_count: int | None = None
    eligible: bool | None = None

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# Model input schemas
# ---------------------------------------------------------------------------


class ModelInputBucket(BaseModel):
    """One causal bucket as presented to a model.

    Identical field set to a leakage-safe board observation, minus the game id
    (carried by the enclosing series). Bucket index is the position in the
    ascending-ordered series and is what a causal model uses to enforce that
    bucket ``i`` only sees buckets ``0..i``.
    """

    index: int = Field(ge=0)
    bucket_start: datetime
    bucket_end: datetime
    intensity: float = Field(ge=0)
    game_elapsed_seconds: float | None = Field(default=None, ge=0)
    active_market_count: int | None = Field(default=None, ge=0)
    source_count: int | None = Field(default=None, ge=0)
    source_dominance: float | None = Field(default=None, ge=0, le=1)
    source_disagreement: float | None = Field(default=None, ge=0, le=1)

    @field_validator("bucket_start", "bucket_end")
    @classmethod
    def _aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("bucket timestamps must be timezone-aware")
        return value.astimezone(timezone.utc)


class GameBucketSeries(BaseModel):
    """One game's ordered, causal bucket series — the unit a model scores."""

    game_id: str
    buckets: list[ModelInputBucket]

    @model_validator(mode="after")
    def _ascending_contiguous_index(self) -> "GameBucketSeries":
        for expected, bucket in enumerate(self.buckets):
            if bucket.index != expected:
                raise ValueError(
                    f"{self.game_id}: bucket index {bucket.index} out of order "
                    f"(expected {expected})"
                )
        starts = [b.bucket_start for b in self.buckets]
        if starts != sorted(starts):
            raise ValueError(f"{self.game_id}: bucket_start not ascending")
        return self

    def __len__(self) -> int:
        return len(self.buckets)


# ---------------------------------------------------------------------------
# Output schemas
# ---------------------------------------------------------------------------


class PredictionRow(BaseModel):
    """One prediction row — exactly one per input bucket.

    Mirrors :data:`.columns.PREDICTION_COLUMNS`. ``fired`` must be False wherever
    the model is not warmed up; the model enforces that, this schema just carries
    it. ``diagnostics`` is optional free-form numeric metadata that gets flattened
    into extra parquet columns by the writer.
    """

    game_id: str
    bucket_start: datetime
    score: float
    fired: bool
    diagnostics: dict[str, float] = Field(default_factory=dict)

    @field_validator("bucket_start")
    @classmethod
    def _aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("bucket_start must be timezone-aware")
        return value.astimezone(timezone.utc)


class EvalGameRow(BaseModel):
    """Per-game evaluation row (consumed by the evaluation phase)."""

    model_id: str
    game_id: str
    incidents_total: int = Field(ge=0)
    incidents_caught: int = Field(ge=0)
    fired_buckets: int = Field(ge=0)
    warmed_buckets: int = Field(ge=0)


class EvalSummaryRow(BaseModel):
    """Cross-game evaluation summary row."""

    model_id: str
    recall: float = Field(ge=0, le=1)
    fire_rate: float = Field(ge=0)
    incidents_total: int = Field(ge=0)
    incidents_caught: int = Field(ge=0)


__all__ = [
    "BoardObservationRow",
    "IncidentRow",
    "ScoreWindowRow",
    "MarketOutlierEpisodeRow",
    "SourceCoverageRow",
    "ModelInputBucket",
    "GameBucketSeries",
    "PredictionRow",
    "EvalGameRow",
    "EvalSummaryRow",
]
