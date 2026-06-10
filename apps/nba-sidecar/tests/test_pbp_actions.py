"""Hermetic tests for the pbp_actions snapshot contract (loader + columns).
Writes a tiny parquet to a tmp dir — no real snapshot/gold DB needed."""

from __future__ import annotations

import pandas as pd
import pytest

from nba_sidecar.research.contracts import PBP_ACTIONS_COLUMNS, validate_dataframe
from nba_sidecar.research.loader import read_pbp_actions


def _rows() -> list[dict]:
    return [
        {
            "game_id": "nba-g",
            "action_number": 1,
            "action_type": "2pt",
            "sub_type": None,
            "person_id": 101,
            "team_tricode": "AAA",
            "player_name": "Joel Embiid",
            "period": 1,
            "clock": "PT11M00S",
            "time_actual": "2026-05-21T02:00:00Z",
        },
        {
            "game_id": "nba-g",
            "action_number": 2,
            "action_type": "rebound",
            "sub_type": "defensive",
            # Team rebound: nullable person_id/player_name stay null.
            "person_id": None,
            "team_tricode": "AAA",
            "player_name": None,
            "period": 1,
            "clock": "PT10M30S",
            "time_actual": "2026-05-21T02:00:30Z",
        },
    ]


def _write_snapshot(tmp_path, rows: list[dict]):
    d = tmp_path / "snap"
    d.mkdir()
    pd.DataFrame(rows).to_parquet(d / "pbp_actions.parquet")
    return d


def test_read_pbp_actions_validates_and_returns(tmp_path):
    d = _write_snapshot(tmp_path, _rows())
    df = read_pbp_actions(d)
    assert len(df) == 2
    assert set(PBP_ACTIONS_COLUMNS.required_names) <= set(df.columns)


def test_read_missing_file_raises(tmp_path):
    d = tmp_path / "empty"
    d.mkdir()
    with pytest.raises(FileNotFoundError):
        read_pbp_actions(d)


def test_validate_rejects_missing_required_column():
    bad = pd.DataFrame([{"game_id": "g", "action_type": "rebound"}])
    with pytest.raises(ValueError, match="missing required columns"):
        validate_dataframe(bad, PBP_ACTIONS_COLUMNS)


def test_validate_rejects_null_action_number(tmp_path):
    rows = _rows()
    rows[0]["action_number"] = None
    d = _write_snapshot(tmp_path, rows)
    with pytest.raises(ValueError, match="action_number"):
        read_pbp_actions(d)
