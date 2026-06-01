"""Snapshot loader: turn an exported snapshot into per-game model inputs.

This is the *only* place the research package learns how the snapshot is laid
out on disk. Models never touch parquet/duckdb directly; they consume
:class:`~nba_sidecar.research.contracts.schemas.GameBucketSeries` objects built
here.

Two read backends are supported, both pointed at the same snapshot directory:

- ``read_board_observations`` uses pandas+pyarrow (the default; simplest).
- ``read_board_observations_duckdb`` uses the bundled ``snapshot.duckdb`` and is
  there to prove the contract is backend-agnostic and to support pushdown for
  larger snapshots later.

The loader validates every board-observation parquet it reads against
:data:`~nba_sidecar.research.contracts.columns.BOARD_OBSERVATION_COLUMNS`, so a
malformed snapshot fails loudly at load time rather than deep inside a model.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .contracts import (
    BOARD_OBSERVATION_COLUMNS,
    PLAYER_PROP_TICKS_COLUMNS,
    GameBucketSeries,
    ModelInputBucket,
    validate_dataframe,
)

_BOARD_FILE = "board_observations.parquet"
_PLAYER_PROP_TICKS_FILE = "player_prop_ticks.parquet"
_DUCKDB_FILE = "snapshot.duckdb"

# Causal, leakage-safe columns that flow into a model input bucket.
_CAUSAL_COLUMNS = (
    "game_id",
    "bucket_start",
    "bucket_end",
    "intensity",
    "game_elapsed_seconds",
    "active_market_count",
    "source_count",
    "source_dominance",
    "source_disagreement",
)


def _snapshot_dir(snapshot_path: str | Path) -> Path:
    path = Path(snapshot_path)
    if not path.exists():
        raise FileNotFoundError(f"snapshot path does not exist: {path}")
    if not path.is_dir():
        raise NotADirectoryError(f"snapshot path must be a directory: {path}")
    return path


def read_board_observations(snapshot_path: str | Path) -> pd.DataFrame:
    """Read + validate the board_observations parquet from a snapshot dir."""
    path = _snapshot_dir(snapshot_path) / _BOARD_FILE
    if not path.exists():
        raise FileNotFoundError(f"missing {_BOARD_FILE} in snapshot: {path}")
    df = pd.read_parquet(path)
    return validate_dataframe(df, BOARD_OBSERVATION_COLUMNS)


def read_player_prop_ticks(snapshot_path: str | Path) -> pd.DataFrame:
    """Read + validate the player_prop_ticks parquet (the re-ranker's per-player
    rebound-prop microstructure). Returns an empty-but-typed frame is NOT done —
    a missing file raises, mirroring read_board_observations, so a malformed/old
    snapshot fails loudly rather than silently yielding no re-ranker input."""
    path = _snapshot_dir(snapshot_path) / _PLAYER_PROP_TICKS_FILE
    if not path.exists():
        raise FileNotFoundError(f"missing {_PLAYER_PROP_TICKS_FILE} in snapshot: {path}")
    df = pd.read_parquet(path)
    return validate_dataframe(df, PLAYER_PROP_TICKS_COLUMNS)


def read_board_observations_duckdb(snapshot_path: str | Path) -> pd.DataFrame:
    """Read board_observations via the bundled snapshot.duckdb (backend parity).

    Falls back with a clear error if duckdb or the db file is unavailable.
    """
    import duckdb  # local import: optional research dependency

    db_path = _snapshot_dir(snapshot_path) / _DUCKDB_FILE
    if not db_path.exists():
        raise FileNotFoundError(f"missing {_DUCKDB_FILE} in snapshot: {db_path}")
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        df = con.execute("SELECT * FROM board_observations").fetch_df()
    finally:
        con.close()
    return validate_dataframe(df, BOARD_OBSERVATION_COLUMNS)


def _to_int(value: object) -> int | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    return int(value)


def _to_float(value: object) -> float | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    return float(value)


def build_game_series(df: pd.DataFrame) -> dict[str, GameBucketSeries]:
    """Turn a board-observations frame into ordered per-game causal series.

    For each game, buckets are sorted ascending by ``bucket_start`` and assigned
    a contiguous ``index``. The ascending + contiguous invariant is enforced by
    :class:`GameBucketSeries`, so any unexpected ordering raises here.
    """
    cols = [c for c in _CAUSAL_COLUMNS if c in df.columns]
    frame = df[cols].copy()
    frame["bucket_start"] = pd.to_datetime(frame["bucket_start"], utc=True)
    frame["bucket_end"] = pd.to_datetime(frame["bucket_end"], utc=True)

    series: dict[str, GameBucketSeries] = {}
    for game_id, group in frame.groupby("game_id", sort=True):
        ordered = group.sort_values("bucket_start", kind="stable").reset_index(drop=True)
        buckets: list[ModelInputBucket] = []
        for index, row in ordered.iterrows():
            buckets.append(
                ModelInputBucket(
                    index=int(index),
                    bucket_start=row["bucket_start"].to_pydatetime(),
                    bucket_end=row["bucket_end"].to_pydatetime(),
                    intensity=float(row["intensity"]),
                    game_elapsed_seconds=_to_float(row.get("game_elapsed_seconds")),
                    active_market_count=_to_int(row.get("active_market_count")),
                    source_count=_to_int(row.get("source_count")),
                    source_dominance=_to_float(row.get("source_dominance")),
                    source_disagreement=_to_float(row.get("source_disagreement")),
                )
            )
        series[str(game_id)] = GameBucketSeries(game_id=str(game_id), buckets=buckets)
    return series


def load_game_series(
    snapshot_path: str | Path, *, backend: str = "pandas"
) -> dict[str, GameBucketSeries]:
    """Top-level entry: load a snapshot into ``{game_id: GameBucketSeries}``.

    ``backend`` is ``"pandas"`` (default) or ``"duckdb"``.
    """
    if backend == "pandas":
        df = read_board_observations(snapshot_path)
    elif backend == "duckdb":
        df = read_board_observations_duckdb(snapshot_path)
    else:
        raise ValueError(f"unknown backend {backend!r}; use 'pandas' or 'duckdb'")
    return build_game_series(df)


__all__ = [
    "read_board_observations",
    "read_player_prop_ticks",
    "read_board_observations_duckdb",
    "build_game_series",
    "load_game_series",
]
