"""Pre-materialized truth, loaded from a snapshot, for the evaluator to JOIN to.

The evaluator's single most important property is that it **scores by joining to
truth that was materialized when the snapshot was built** -- it never recomputes
scoreability, catch windows, or tape-outlier episodes from the raw board
observations. This module is the structural enforcement of that property:

- :class:`SnapshotTruth` carries ONLY the four label-side tables:
  ``incidents`` (for ``scoreable``), ``score_windows`` (incident catch windows),
  ``market_outlier_episodes`` (tape outliers), and ``source_coverage``
  (per-game/source coverage, used to annotate casebook misses as model-vs-data).
- It deliberately does **not** carry ``board_observations``. The scorer in
  :mod:`.scorer` consumes a ``SnapshotTruth`` and a predictions frame; because
  the truth object has no access to the raw signal, the scorer *cannot* rederive
  any label. Corrupting / scrambling ``board_observations`` therefore cannot move
  a single metric -- which is exactly what the no-recompute test asserts.

All time joins are in unix-seconds. ``score_windows`` and
``market_outlier_episodes`` already store ``*_sec`` columns; a fired prediction
bucket is converted to ``[bucket_start_sec, bucket_end_sec)`` at score time.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from ..contracts import (
    INCIDENT_COLUMNS,
    MARKET_OUTLIER_EPISODE_COLUMNS,
    SCORE_WINDOW_COLUMNS,
    SOURCE_COVERAGE_COLUMNS,
    validate_dataframe,
)

_INCIDENTS_FILE = "incidents.parquet"
_SCORE_WINDOWS_FILE = "score_windows.parquet"
_EPISODES_FILE = "market_outlier_episodes.parquet"
_COVERAGE_FILE = "source_coverage.parquet"


@dataclass(frozen=True)
class SnapshotTruth:
    """The pre-materialized label-side tables the evaluator joins predictions to.

    Intentionally has no handle on ``board_observations``; the scorer that
    consumes this object is therefore incapable of recomputing scoreability,
    catch windows, or tape-outlier episodes. It can only *read* what was
    materialized at snapshot-build time.
    """

    incidents: pd.DataFrame
    score_windows: pd.DataFrame
    market_outlier_episodes: pd.DataFrame
    source_coverage: pd.DataFrame

    # -- derived, read-only views ------------------------------------------

    @property
    def scoreable_incident_ids(self) -> set[str]:
        inc = self.incidents
        return set(inc.loc[inc["scoreable"] == True, "incident_id"].astype(str))  # noqa: E712

    def scoreable_windows(self) -> pd.DataFrame:
        """score_windows rows for scoreable incidents only (the eval target)."""
        ids = self.scoreable_incident_ids
        sw = self.score_windows
        return sw[sw["incident_id"].astype(str).isin(ids)].copy()

    def games_with_truth(self) -> set[str]:
        """Games that carry at least one scoreable window or one tape episode.

        This is the honest evaluation universe: games where joining to truth can
        actually produce a non-trivial recall. (The snapshot's train/test split
        forces every incident game into ``train``; evaluating on the ``test``
        holdout alone would yield 0/0 incident recall, which would be a
        measurement artifact, not a result.)
        """
        games: set[str] = set()
        games.update(self.scoreable_windows()["game_id"].astype(str))
        games.update(self.market_outlier_episodes["game_id"].astype(str))
        return games

    def coverage_for_game(self, game_id: str) -> pd.DataFrame:
        sc = self.source_coverage
        return sc[sc["game_id"].astype(str) == game_id].copy()


def _read(path: Path, spec) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"missing {path.name} in snapshot: {path}")
    df = pd.read_parquet(path)
    return validate_dataframe(df, spec)


def load_truth(snapshot_path: str | Path) -> SnapshotTruth:
    """Load the four materialized truth tables from a snapshot directory.

    Each table is validated against its declarative column spec, so a malformed
    snapshot fails loudly here rather than mid-join.
    """
    base = Path(snapshot_path)
    if not base.is_dir():
        raise NotADirectoryError(f"snapshot path must be a directory: {base}")
    return SnapshotTruth(
        incidents=_read(base / _INCIDENTS_FILE, INCIDENT_COLUMNS),
        score_windows=_read(base / _SCORE_WINDOWS_FILE, SCORE_WINDOW_COLUMNS),
        market_outlier_episodes=_read(base / _EPISODES_FILE, MARKET_OUTLIER_EPISODE_COLUMNS),
        source_coverage=_read(base / _COVERAGE_FILE, SOURCE_COVERAGE_COLUMNS),
    )


__all__ = ["SnapshotTruth", "load_truth"]
