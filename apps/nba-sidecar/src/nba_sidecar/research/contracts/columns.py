"""Declarative parquet column specs + a dataframe validator.

A :class:`ColumnSpec` documents one column: its name, the logical dtype family
it must coerce to, whether nulls are allowed, and a short human-readable meaning
(mirrored from the snapshot ``feature_catalog``). A :class:`ParquetTableSpec`
bundles the columns for one table and knows how to validate a pandas DataFrame.

Why a column spec layer at all, when we also have pydantic models? Because the
prediction / eval contract has to be *runtime-agnostic*. An external producer
(R, a notebook, a different service) may write ``predictions.parquet`` directly.
We validate that file against :data:`PREDICTION_COLUMNS` exactly the way we'd
validate one we produced ourselves — no Python object round-trip required.

Dtype families
--------------
We deliberately keep the dtype vocabulary small and *logical* rather than
pinning exact numpy/arrow dtypes, so that ``int32`` vs ``int64`` or
``float64`` vs ``float32`` differences between producers do not spuriously fail
validation:

- ``"string"``  : object/str-like
- ``"int"``     : any integer width
- ``"float"``   : any float width (ints are also accepted and upcast)
- ``"bool"``    : boolean
- ``"datetime"``: ISO-8601 string or pandas/py datetime (tz-aware preferred)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:  # pragma: no cover - typing only
    import pandas as pd

DtypeFamily = Literal["string", "int", "float", "bool", "datetime"]


@dataclass(frozen=True, slots=True)
class ColumnSpec:
    """One documented column in a parquet contract."""

    name: str
    dtype: DtypeFamily
    nullable: bool = False
    meaning: str = ""


@dataclass(frozen=True, slots=True)
class ParquetTableSpec:
    """A documented set of columns for one parquet table.

    ``required`` columns must be present. Extra columns in the dataframe are
    allowed (snapshots and external producers may carry diagnostics we do not
    model) unless ``allow_extra`` is False.
    """

    name: str
    columns: tuple[ColumnSpec, ...]
    allow_extra: bool = True

    @property
    def required_names(self) -> tuple[str, ...]:
        return tuple(col.name for col in self.columns)

    def column(self, name: str) -> ColumnSpec:
        for col in self.columns:
            if col.name == name:
                return col
        raise KeyError(f"{self.name} has no column {name!r}")


def _family_ok(series: "pd.Series", family: DtypeFamily) -> bool:
    import pandas as pd
    from pandas.api import types as pdt

    non_null = series.dropna()
    if non_null.empty:
        # All-null column: only acceptable if the spec allows nulls; the caller
        # checks nullability separately, so here we accept it dtype-wise.
        return True
    if family == "string":
        return bool((non_null.map(lambda v: isinstance(v, str))).all())
    if family == "int":
        # Accept integer dtypes, or float columns whose values are whole.
        if pdt.is_integer_dtype(series):
            return True
        if pdt.is_float_dtype(series):
            return bool((non_null == non_null.round()).all())
        return False
    if family == "float":
        return bool(pdt.is_float_dtype(series) or pdt.is_integer_dtype(series))
    if family == "bool":
        if pdt.is_bool_dtype(series):
            return True
        return bool(non_null.map(lambda v: isinstance(v, (bool,))).all())
    if family == "datetime":
        if pdt.is_datetime64_any_dtype(series):
            return True
        # ISO-8601 strings are accepted (snapshot stores bucket_start as string).
        if non_null.map(lambda v: isinstance(v, str)).all():
            # format="ISO8601" tolerates mixed fractional-second precision within
            # one column (e.g. "...40.2Z" alongside "...43Z"), which plain
            # inference would NaT-out as a heterogeneous format.
            parsed = pd.to_datetime(non_null, errors="coerce", utc=True, format="ISO8601")
            return bool(parsed.notna().all())
        return False
    return False


def validate_dataframe(df: "pd.DataFrame", spec: ParquetTableSpec) -> "pd.DataFrame":
    """Validate ``df`` against ``spec``; return it unchanged on success.

    Raises ``ValueError`` with a precise message on the first violation. This is
    the single entry point used by both internally-produced and externally
    produced parquet files, which is what makes the contract runtime-agnostic.
    """
    missing = [c.name for c in spec.columns if c.name not in df.columns]
    if missing:
        raise ValueError(
            f"{spec.name}: missing required columns {missing}; got {list(df.columns)}"
        )
    if not spec.allow_extra:
        extra = [c for c in df.columns if c not in spec.required_names]
        if extra:
            raise ValueError(f"{spec.name}: unexpected extra columns {extra}")
    for col in spec.columns:
        series = df[col.name]
        if not col.nullable and series.isna().any():
            raise ValueError(f"{spec.name}.{col.name}: contains nulls but is not nullable")
        if not _family_ok(series, col.dtype):
            raise ValueError(
                f"{spec.name}.{col.name}: values are not coercible to dtype family "
                f"{col.dtype!r}"
            )
    return df


# ---------------------------------------------------------------------------
# Snapshot table specs (mirrors outputs/nba-quant-lab/snapshots/<id> parquet).
# Meanings copied from the snapshot feature_catalog so the contract is
# self-documenting next to the data.
# ---------------------------------------------------------------------------

BOARD_OBSERVATION_COLUMNS = ParquetTableSpec(
    name="board_observations",
    columns=(
        ColumnSpec("game_id", "string", meaning="Snapshot game identifier (e.g. nba-0042500222)."),
        ColumnSpec("bucket_start", "datetime", meaning="Bucket start wall-clock instant (ISO-8601 Z)."),
        ColumnSpec("bucket_end", "datetime", meaning="Bucket end wall-clock instant (ISO-8601 Z)."),
        ColumnSpec(
            "game_elapsed_seconds",
            "float",
            nullable=True,
            meaning="NBA game-clock seconds elapsed at bucket, from PBP. Causal.",
        ),
        ColumnSpec(
            "intensity",
            "float",
            meaning="Volume-weighted sum of |delta implied prob| across markets in bucket. Causal.",
        ),
        ColumnSpec(
            "active_market_count",
            "int",
            nullable=True,
            meaning="Distinct source_market_ids contributing a delta in the bucket. Causal.",
        ),
        ColumnSpec(
            "source_count",
            "int",
            nullable=True,
            meaning="Distinct sources (book/exchange) contributing in the bucket. Causal.",
        ),
        ColumnSpec(
            "source_dominance",
            "float",
            nullable=True,
            meaning="Share of bucket intensity from the single most active source (0..1). Causal.",
        ),
        ColumnSpec(
            "source_disagreement",
            "float",
            nullable=True,
            meaning="1 - |net signed move| / total |signed move| across sources (0..1). Causal.",
        ),
    ),
)

INCIDENT_COLUMNS = ParquetTableSpec(
    name="incidents",
    columns=(
        ColumnSpec("incident_id", "string", meaning="Stable incident identifier."),
        ColumnSpec(
            "canonical_game_id",
            "string",
            nullable=True,
            meaning=(
                "Game the incident belongs to. Null for non-scoreable / unanchored "
                "incidents (no exact game attribution yet)."
            ),
        ),
        ColumnSpec("has_local_window", "bool", meaning="Whether a local catch window exists."),
        ColumnSpec(
            "scoreable",
            "bool",
            meaning="Incident has exact anchor + window (label-side). Non-causal label.",
        ),
        ColumnSpec("confidence", "string", nullable=True, meaning="Label confidence tier."),
        ColumnSpec("anchor_type", "string", nullable=True, meaning="Anchor kind for the label."),
        ColumnSpec("utc_time", "datetime", nullable=True, meaning="Label anchor wall-clock time."),
        ColumnSpec(
            "event_sec",
            "int",
            nullable=True,
            meaning=(
                "Truth event unix-seconds timestamp (label anchor). Non-causal. "
                "Null for non-scoreable incidents that lack an exact anchor."
            ),
        ),
        ColumnSpec("stat", "string", nullable=True, meaning="Misattributed stat category."),
        ColumnSpec("credited_player", "string", nullable=True, meaning="Player wrongly credited."),
        ColumnSpec("rightful_player", "string", nullable=True, meaning="Player who should be credited."),
        ColumnSpec("official_correction", "bool", nullable=True, meaning="Official box-score correction flag."),
    ),
)

SCORE_WINDOW_COLUMNS = ParquetTableSpec(
    name="score_windows",
    columns=(
        ColumnSpec("incident_id", "string", meaning="Incident this catch window scores."),
        ColumnSpec("game_id", "string", meaning="Game identifier."),
        ColumnSpec("window_start", "datetime", nullable=True, meaning="Catch window start (ISO)."),
        ColumnSpec("window_end", "datetime", nullable=True, meaning="Catch window end (ISO)."),
        ColumnSpec(
            "window_start_sec",
            "int",
            meaning="Catch-window start unix-seconds (event + CATCH_WINDOW_BEFORE). Label-derived.",
        ),
        ColumnSpec(
            "window_end_sec",
            "int",
            meaning="Catch-window end unix-seconds (event + CATCH_WINDOW_AFTER). Label-derived.",
        ),
    ),
)

MARKET_OUTLIER_EPISODE_COLUMNS = ParquetTableSpec(
    name="market_outlier_episodes",
    columns=(
        ColumnSpec("episode_id", "string", meaning="Stable episode identifier."),
        ColumnSpec("game_id", "string", meaning="Game identifier."),
        ColumnSpec("start_sec", "int", meaning="Episode start unix-seconds."),
        ColumnSpec("end_sec", "int", meaning="Episode end unix-seconds."),
        ColumnSpec("bucket_seconds", "int", meaning="Bucketization used for the episode."),
        ColumnSpec("bucket_count", "int", meaning="Number of buckets spanned."),
        ColumnSpec(
            "peak_severity",
            "float",
            meaning="Peak tape-outlier severity (whole-game robust-z composite). Non-causal.",
        ),
        ColumnSpec(
            "peak_price_move_z",
            "float",
            meaning="Peak robust-z of coverage-normalized price-move intensity. Non-causal.",
        ),
        ColumnSpec("diagnosis", "string", nullable=True, meaning="Episode diagnosis label."),
    ),
)

SOURCE_COVERAGE_COLUMNS = ParquetTableSpec(
    name="source_coverage",
    columns=(
        ColumnSpec("game_id", "string", meaning="Game identifier."),
        ColumnSpec("source", "string", meaning="Source key (book/exchange)."),
        ColumnSpec("market_family", "string", meaning="Market family."),
        ColumnSpec("window", "string", meaning="Coverage window key."),
        ColumnSpec(
            "class",
            "string",
            meaning="Coverage class (canonical|snapshot_eligible|partial|artifact_only|missing).",
        ),
        ColumnSpec("market_count", "int", nullable=True, meaning="Distinct markets in window."),
        ColumnSpec("tick_count", "int", nullable=True, meaning="Quote ticks in window."),
        ColumnSpec("eligible", "bool", nullable=True, meaning="Whether the window is snapshot-eligible."),
    ),
)

# Per-player rebound-prop microstructure (re-ranker input). Raw causal ticks the
# signed-paired attribution re-ranker windows around candidate events; leakage-safe.
PLAYER_PROP_TICKS_COLUMNS = ParquetTableSpec(
    name="player_prop_ticks",
    columns=(
        ColumnSpec("game_id", "string", meaning="Game identifier."),
        ColumnSpec("player_key", "string", meaning="Player participant key (e.g. victor-wembanyama)."),
        ColumnSpec("source", "string", meaning="Book/exchange (kalshi/bet365/polymarket) for per-source series + cross-source divergence."),
        ColumnSpec("line", "float", nullable=True, meaning="Over/under threshold (e.g. 5.5); select one coherent line per player/source."),
        ColumnSpec("stat", "string", meaning="Prop stat family (currently 'rebounds')."),
        ColumnSpec("captured_at", "datetime", meaning="Tick wall-clock instant (ISO-8601 Z). Causal."),
        ColumnSpec(
            "implied_probability",
            "float",
            meaning="Per-player rebound-OVER implied probability at the tick (0..1). Causal.",
        ),
        ColumnSpec(
            "volume",
            "float",
            nullable=True,
            meaning="Traded volume at the tick (source-native; for signed-flow/BVC features).",
        ),
    ),
)


# Raw play-by-play actions for every snapshot game — the attribution surfaces'
# raw material. The research package derives rebound events + confusability
# candidate pairs from these rows (candidates.rebound_candidates + oncourt
# reconstruction); the snapshot carries the RAW causal actions, not a derived
# event table. Credit fields are the EARLIEST observed revision state (the
# live actions table is upserted in place, so a silent correction would
# otherwise present the corrected rightful player as the causal credit).
PBP_ACTIONS_COLUMNS = ParquetTableSpec(
    name="pbp_actions",
    columns=(
        ColumnSpec("game_id", "string", meaning="Game identifier."),
        ColumnSpec("action_number", "int", meaning="PBP action sequence number (unique per game)."),
        ColumnSpec("action_type", "string", nullable=True, meaning="PBP action type (e.g. 'rebound', 'substitution')."),
        ColumnSpec("sub_type", "string", nullable=True, meaning="PBP sub-type (e.g. 'offensive'/'defensive' for rebounds)."),
        ColumnSpec(
            "person_id",
            "int",
            nullable=True,
            meaning=(
                "NBA person id credited on the action (earliest observed state; "
                "null = team-credited). Causal."
            ),
        ),
        ColumnSpec("team_tricode", "string", nullable=True, meaning="Team tricode on the action."),
        ColumnSpec("player_name", "string", nullable=True, meaning="Player display name on the action."),
        ColumnSpec("period", "int", nullable=True, meaning="Game period of the action."),
        ColumnSpec("clock", "string", nullable=True, meaning="Game-clock string at the action."),
        ColumnSpec(
            "time_actual",
            "datetime",
            nullable=True,
            meaning="Wall-clock instant of the action — the attribution event anchor. Causal.",
        ),
    ),
)


# ---------------------------------------------------------------------------
# Model output contract: predictions.parquet
#
# One row per input bucket. ``score`` is the model's continuous surprise/alert
# score for that bucket; ``fired`` is the boolean alert decision (only True
# where the model is warmed up). Diagnostics are optional and free-form numeric
# columns are allowed via allow_extra=True. The four required columns are the
# stable cross-runtime contract.
# ---------------------------------------------------------------------------

PREDICTION_COLUMNS = ParquetTableSpec(
    name="predictions",
    columns=(
        ColumnSpec("game_id", "string", meaning="Game the prediction bucket belongs to."),
        ColumnSpec(
            "bucket_start",
            "datetime",
            meaning="Bucket start instant; joins back to board_observations.bucket_start.",
        ),
        ColumnSpec("score", "float", meaning="Continuous alert/surprise score for the bucket."),
        ColumnSpec("fired", "bool", meaning="Alert decision; True only where the model is warmed up."),
    ),
)


# ---------------------------------------------------------------------------
# Evaluation output contracts (consumed next phase by evaluation/). Documented
# here so the contract layer is complete and external scorers can target it.
# ---------------------------------------------------------------------------

EVAL_GAME_COLUMNS = ParquetTableSpec(
    name="eval_game",
    columns=(
        ColumnSpec("model_id", "string", meaning="Model identifier evaluated."),
        ColumnSpec("game_id", "string", meaning="Game identifier."),
        ColumnSpec("incidents_total", "int", meaning="Scoreable incidents in this game."),
        ColumnSpec("incidents_caught", "int", meaning="Incidents whose catch window saw a fire."),
        ColumnSpec("fired_buckets", "int", meaning="Buckets where the model fired."),
        ColumnSpec("warmed_buckets", "int", meaning="Buckets where the model was warmed up."),
    ),
)

EVAL_SUMMARY_COLUMNS = ParquetTableSpec(
    name="eval_summary",
    columns=(
        ColumnSpec("model_id", "string", meaning="Model identifier evaluated."),
        ColumnSpec("recall", "float", meaning="Fraction of scoreable incidents caught (0..1)."),
        ColumnSpec("fire_rate", "float", meaning="Fired buckets / warmed buckets (alert burden)."),
        ColumnSpec("incidents_total", "int", meaning="Scoreable incidents across evaluated games."),
        ColumnSpec("incidents_caught", "int", meaning="Incidents caught across evaluated games."),
    ),
)


__all__ = [
    "ColumnSpec",
    "ParquetTableSpec",
    "DtypeFamily",
    "validate_dataframe",
    "BOARD_OBSERVATION_COLUMNS",
    "INCIDENT_COLUMNS",
    "SCORE_WINDOW_COLUMNS",
    "MARKET_OUTLIER_EPISODE_COLUMNS",
    "SOURCE_COVERAGE_COLUMNS",
    "PLAYER_PROP_TICKS_COLUMNS",
    "PBP_ACTIONS_COLUMNS",
    "PREDICTION_COLUMNS",
    "EVAL_GAME_COLUMNS",
    "EVAL_SUMMARY_COLUMNS",
]
