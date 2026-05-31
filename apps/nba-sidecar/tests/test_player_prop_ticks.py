"""Hermetic tests for the player_prop_ticks snapshot contract (loader + columns +
pydantic). Writes a tiny parquet to a tmp dir — no real snapshot/gold DB needed."""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest
from pydantic import ValidationError

from nba_sidecar.research.contracts import (
    PLAYER_PROP_TICKS_COLUMNS,
    PlayerPropTickRow,
    validate_dataframe,
)
from nba_sidecar.research.loader import read_player_prop_ticks


def _write_snapshot(tmp_path, rows: list[dict]):
    d = tmp_path / "snap"
    d.mkdir()
    pd.DataFrame(rows).to_parquet(d / "player_prop_ticks.parquet")
    return d


def test_read_player_prop_ticks_validates_and_returns(tmp_path):
    d = _write_snapshot(
        tmp_path,
        [
            {"game_id": "nba-g", "player_key": "victor-wembanyama", "stat": "rebounds",
             "captured_at": "2026-05-21T02:00:43Z", "implied_probability": 0.55, "volume": 12.0},
            {"game_id": "nba-g", "player_key": "victor-wembanyama", "stat": "rebounds",
             "captured_at": "2026-05-21T02:01:00Z", "implied_probability": 0.60, "volume": None},
        ],
    )
    df = read_player_prop_ticks(d)
    assert len(df) == 2
    assert {"game_id", "player_key", "stat", "captured_at", "implied_probability", "volume"} <= set(df.columns)


def test_read_missing_file_raises(tmp_path):
    d = tmp_path / "empty"
    d.mkdir()
    with pytest.raises(FileNotFoundError):
        read_player_prop_ticks(d)


def test_validate_rejects_missing_required_column():
    bad = pd.DataFrame([{"game_id": "g", "player_key": "p", "implied_probability": 0.5}])
    with pytest.raises(ValueError, match="missing required columns"):
        validate_dataframe(bad, PLAYER_PROP_TICKS_COLUMNS)


def test_pydantic_row_requires_aware_time_and_prob_range():
    ok = PlayerPropTickRow(
        game_id="g", player_key="p", stat="rebounds",
        captured_at=datetime(2026, 5, 21, 2, 0, tzinfo=timezone.utc), implied_probability=0.5,
    )
    assert ok.captured_at.tzinfo is not None and ok.volume is None
    with pytest.raises(ValidationError):  # prob > 1
        PlayerPropTickRow(
            game_id="g", player_key="p", stat="rebounds",
            captured_at=datetime(2026, 5, 21, 2, 0, tzinfo=timezone.utc), implied_probability=1.5,
        )
    with pytest.raises(ValidationError):  # naive datetime
        PlayerPropTickRow(
            game_id="g", player_key="p", stat="rebounds",
            captured_at=datetime(2026, 5, 21, 2, 0), implied_probability=0.5,
        )
