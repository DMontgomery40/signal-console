"""Hermetic tests for FAR calibration (scoring + summary + data-quality gate)."""

from __future__ import annotations

import pandas as pd

from nba_sidecar.research.far_calibration import (
    oncourt_quality,
    score_control_pairs,
    summarize_far,
)


def _a(num, at, st=None, pid=None, team=None, name=None, t=None):
    return {
        "action_number": num,
        "action_type": at,
        "sub_type": st,
        "person_id": pid,
        "team_tricode": team,
        "player_name": name,
        "period": 1,
        "clock": "PT11M00S",
        "time_actual": t,
    }


PBP = {
    "nba-x": [
        _a(1, "2pt", pid=1, team="SAS", name="A. One"),
        _a(2, "2pt", pid=2, team="SAS", name="B. Two"),
        _a(3, "2pt", pid=3, team="SAS", name="C. Three"),
        _a(4, "2pt", pid=4, team="SAS", name="D. Four"),
        _a(5, "2pt", pid=5, team="SAS", name="E. Five"),
        _a(11, "2pt", pid=11, team="OKC", name="Z. Eleven"),
        _a(12, "2pt", pid=12, team="OKC", name="Y. Twelve"),
        _a(13, "2pt", pid=13, team="OKC", name="X. Thirteen"),
        _a(14, "2pt", pid=14, team="OKC", name="W. Fourteen"),
        _a(15, "2pt", pid=15, team="OKC", name="V. Fifteen"),
        _a(6, "rebound", "defensive", pid=1, team="SAS", name="A. One", t="2026-01-01T00:10:00Z"),
    ]
}


def _ticks(rows):
    return pd.DataFrame(rows, columns=["game_id", "player_key", "source", "line", "stat", "captured_at", "implied_probability", "volume"])


def test_summary_shapes_and_abstention_without_ticks():
    rows = score_control_pairs(_ticks([]), PBP)
    # 1 rebound * 4 teammates = 4 candidate pairs, all abstain (no ticks)
    assert len(rows) == 4
    summary = summarize_far(rows)
    assert summary["n_pairs"] == 4
    assert summary["n_scored_pairs"] == 0
    assert summary["abstention_rate"] == 1.0
    # no scored pairs -> rates are None, not crashes
    assert all(v is None for v in summary["per_pair_far"].values())


def test_scored_pair_fires_above_threshold():
    # Build a clean anchored signature: credited (A. One) drifts AGAINST its over
    # (prob down) while teammate (B. Two) drifts TOWARD (prob up) around the event.
    # Event 00:10:00 -> pre window [00:08:00,00:09:30], post window [00:13:00,00:15:00].
    pre0, pre1 = "2026-01-01T00:08:30Z", "2026-01-01T00:09:00Z"
    post0, post1 = "2026-01-01T00:13:30Z", "2026-01-01T00:14:00Z"
    rows = []
    for cap, p in ((pre0, 0.60), (pre1, 0.60), (post0, 0.40), (post1, 0.40)):  # credited falls
        rows.append(("nba-x", "a-one", "bet365", 8.5, "rebounds", cap, p, 100))
    for cap, p in ((pre0, 0.40), (pre1, 0.40), (post0, 0.60), (post1, 0.60)):  # teammate rises
        rows.append(("nba-x", "b-two", "bet365", 6.5, "rebounds", cap, p, 100))
    scored = score_control_pairs(_ticks(rows), PBP, line_select="aggregate_drift")
    by_cand = {r["candidate_person_id"]: r for r in scored}
    # the B. Two pair should score (have support) and be positive
    b = by_cand[2]
    assert b["score"] is not None
    assert b["score"] > 0
    summary = summarize_far(scored, thresholds=(0.0,))
    assert summary["n_scored_pairs"] >= 1
    assert summary["per_pair_far"][0.0] is not None


def test_oncourt_quality_clean_game():
    q = oncourt_quality(PBP)
    assert q["games"] == 1
    assert q["games_bad_starters"] == 0
    assert q["rebounds"] == 1
    assert q["rebounds_oncourt_ne5"] == 0
