"""Hermetic tests for the snapshot-backed re-ranker (line-selection + stratification).

Writes a tiny player_prop_ticks parquet and drives the scorer through the loader —
no gold DB, no real snapshot.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from nba_sidecar.research.attribution_snapshot import (
    aggregate_leg_drift,
    evaluate_snapshot,
    last_name,
    score_incident_snapshot,
    select_player_series,
)
from nba_sidecar.research.attribution import AttributionParams
from nba_sidecar.research.loader import read_player_prop_ticks

EVENT = "2026-05-21T02:00:43.6Z"
_COLS = ["game_id", "player_key", "source", "line", "stat", "captured_at", "implied_probability", "volume"]


def _iso(off: float) -> str:
    base = datetime.fromisoformat(EVENT.replace("Z", "+00:00")).timestamp()
    return datetime.fromtimestamp(base + off, tz=timezone.utc).isoformat()


def _ticks(game, player, source, line, series):
    return [
        {"game_id": game, "player_key": player, "source": source, "line": line, "stat": "rebounds",
         "captured_at": _iso(o), "implied_probability": p, "volume": 1.0}
        for o, p in series
    ]


def _snap(tmp_path, rows):
    d = tmp_path / "snap"
    d.mkdir()
    pd.DataFrame(rows, columns=_COLS).to_parquet(d / "player_prop_ticks.parquet")
    return str(d)


def test_last_name_handles_initials_full_and_team():
    assert last_name("V. Wembanyama") == "wembanyama"
    assert last_name("Victor Wembanyama") == "wembanyama"
    assert last_name("TEAM offensive rebound") == ""
    assert last_name("") == ""


def test_select_picks_most_active_line(tmp_path):
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.55), (280, 0.55)])
    rows += _ticks("g", "victor-wembanyama", "bet365", 5.5, [(-100, 0.90), (280, 0.90)])  # fewer ticks
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    ser = select_player_series(df, "g", "wembanyama")
    # the 9.5 series (4 ticks) wins over 5.5 (2 ticks); levels 0.30/0.55, not 0.90
    assert len(ser) == 4
    assert max(p for _, p in ser) == pytest.approx(0.55)


def test_player_swap_scores_positive(tmp_path):
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.55), (280, 0.55)])
    rows += _ticks("g", "julian-champagnie", "bet365", 7.5, [(-100, 0.60), (-40, 0.60), (200, 0.45), (280, 0.45)])
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    ps, stratum = score_incident_snapshot(
        df, game_id="g", credited_player="J. Champagnie", rightful_player="V. Wembanyama", event_iso=EVENT
    )
    assert stratum == "player_swap"
    assert ps is not None and ps.support == "ok"
    assert ps.score == pytest.approx(0.40)  # rightful +0.25 - credited (-0.15)


def test_hart_suffix_does_not_match_hartenstein(tmp_path):
    rows = _ticks("g", "isaiah-hartenstein", "bet365", 9.5, [(-100, 0.5), (-40, 0.5), (200, 0.6), (280, 0.6)])
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    assert select_player_series(df, "g", "hart") == []  # no josh-hart present


def test_evaluate_stratifies_player_swap_vs_team_dispute(tmp_path):
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.50), (280, 0.50)])
    incs = [
        {"id": "a", "game_id": "g", "credited_player": "J. Champagnie", "rightful_player": "V. Wembanyama", "event_iso": EVENT},
        {"id": "b", "game_id": "g", "credited_player": "TEAM offensive rebound", "rightful_player": "V. Wembanyama", "event_iso": EVENT},
    ]
    rep = evaluate_snapshot(_snap(tmp_path, rows), incs)
    assert rep["overall"]["n"] == 2
    assert rep["player_swap"]["n"] == 1
    assert rep["team_dispute"]["n"] == 1
    # 'a': champagnie illiquid -> rightful_only (scored); 'b': team_dispute, rightful only too
    assert rep["player_swap"]["n_scored"] == 1


def test_aggregate_drift_is_level_invariant_across_lines(tmp_path):
    # two lines, DIFFERENT levels, SAME +0.20 drift -> aggregate is +0.20 (the mean of
    # per-line drifts), not a blended-level artifact.
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.50), (280, 0.50)])
    rows += _ticks("g", "victor-wembanyama", "kalshi", 9.5, [(-100, 0.70), (-40, 0.70), (200, 0.90), (280, 0.90)])
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    event = datetime.fromisoformat(EVENT.replace("Z", "+00:00")).timestamp()
    lr = aggregate_leg_drift(df, "g", "wembanyama", event, AttributionParams())
    assert not lr.abstain
    assert lr.drift == pytest.approx(0.20)


def test_aggregate_drift_path_scores_player_swap(tmp_path):
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.55), (280, 0.55)])
    rows += _ticks("g", "julian-champagnie", "bet365", 7.5, [(-100, 0.60), (-40, 0.60), (200, 0.45), (280, 0.45)])
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    ps, stratum = score_incident_snapshot(
        df, game_id="g", credited_player="J. Champagnie", rightful_player="V. Wembanyama",
        event_iso=EVENT, line_select="aggregate_drift",
    )
    assert stratum == "player_swap"
    assert ps is not None and ps.support == "ok"
    assert ps.score == pytest.approx(0.40)
