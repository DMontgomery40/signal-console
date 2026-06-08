"""Hermetic tests for FAR calibration (scoring + summary + data-quality gate)."""

from __future__ import annotations

import pandas as pd

from nba_sidecar.research.attribution_snapshot import _epoch
from nba_sidecar.research.far_calibration import (
    harvested_label_specs,
    incident_recall_matched,
    merge_incident_specs,
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


def test_incident_recall_matched_locates_ranks_and_scores_rightful():
    # anchored signature: credited (A. One) falls, rightful teammate (B. Two) rises
    pre0, pre1 = "2026-01-01T00:08:30Z", "2026-01-01T00:09:00Z"
    post0, post1 = "2026-01-01T00:13:30Z", "2026-01-01T00:14:00Z"
    rows = []
    for cap, p in ((pre0, 0.60), (pre1, 0.60), (post0, 0.40), (post1, 0.40)):
        rows.append(("nba-x", "a-one", "bet365", 8.5, "rebounds", cap, p, 100))
    for cap, p in ((pre0, 0.40), (pre1, 0.40), (post0, 0.60), (post1, 0.60)):
        rows.append(("nba-x", "b-two", "bet365", 6.5, "rebounds", cap, p, 100))
    inc = [{"id": "i1", "game_id": "nba-x", "credited_last": "one", "rightful_last": "two",
            "event_epoch": _epoch("2026-01-01T00:10:00Z")}]
    res = incident_recall_matched(_ticks(rows), PBP, inc, thresholds=(0.0, 0.02))
    assert (res["n_incidents"], res["n_matched"], res["n_rightful_oncourt"], res["n_scored"]) == (1, 1, 1, 1)
    r = res["incidents"][0]
    assert r["rightful_oncourt"] and r["rightful_score"] > 0 and r["is_score_argmax"] is True
    assert res["tpr_per_pair"][0.0] == 1.0
    assert res["tpr_correct_argmax"][0.0] == 1.0
    # line_select is HONORED (threaded to the recall scorer), not silently forced to
    # aggregate_drift — non-default operating points must match the control FAR's.
    res_ma = incident_recall_matched(
        _ticks(rows), PBP, inc, thresholds=(0.0,), line_select="most_active"
    )
    assert res_ma["n_scored"] == 1
    assert res_ma["incidents"][0]["rightful_score"] is not None


def test_incident_recall_matched_unmatched_when_no_credited_rebound():
    inc = [{"id": "i2", "game_id": "nba-x", "credited_last": "nobody", "rightful_last": "two",
            "event_epoch": _epoch("2026-01-01T00:10:00Z")}]
    res = incident_recall_matched(_ticks([]), PBP, inc)
    assert res["n_incidents"] == 1 and res["n_matched"] == 0
    assert res["incidents"][0]["reason"] == "no credited rebound within match window"


def test_harvested_label_specs_parses_rebound_labels_only():
    report = {
        "incidents": [
            {"id": "h1", "gameId": "nba-x", "creditedPlayer": "S. Merrill", "rightfulPlayer": "J. Allen",
             "stat": "rebound", "utcTime": "2026-01-01T00:10:00Z"},
            # a non-rebound (assist) label is dropped
            {"id": "h2", "gameId": "nba-y", "creditedPlayer": "A. One", "rightfulPlayer": "B. Two",
             "stat": "assist", "utcTime": "2026-01-01T00:10:00Z"},
            # missing rightful -> dropped
            {"id": "h3", "gameId": "nba-z", "creditedPlayer": "C. Three", "rightfulPlayer": "",
             "stat": "rebound", "utcTime": "2026-01-01T00:10:00Z"},
            # TEAM-credited (harvester sentinel) -> kept with credited_last="" for the TEAM branch
            {"id": "h4", "gameId": "nba-w", "creditedPlayer": "TEAM", "rightfulPlayer": "V. Wembanyama",
             "stat": "rebound", "utcTime": "2026-01-01T00:10:00Z"},
        ]
    }
    specs = harvested_label_specs(report)
    assert len(specs) == 2
    swap = next(s for s in specs if s["game_id"] == "nba-x")
    assert (swap["credited_last"], swap["rightful_last"]) == ("merrill", "allen")
    team = next(s for s in specs if s["game_id"] == "nba-w")
    assert (team["credited_last"], team["rightful_last"]) == ("", "wembanyama")
    assert harvested_label_specs({}) == []  # absent/empty report is safe


def test_merge_incident_specs_dedups_registry_wins():
    registry = [
        {"id": "r1", "game_id": "nba-x", "credited_last": "merrill", "rightful_last": "allen", "event_epoch": 1.0},
    ]
    harvested = [
        # duplicate of r1 (same game + names) -> skipped, registry wins
        {"id": "h1", "game_id": "nba-x", "credited_last": "merrill", "rightful_last": "allen", "event_epoch": 2.0},
        # genuinely new label -> added
        {"id": "h2", "game_id": "nba-q", "credited_last": "smith", "rightful_last": "jones", "event_epoch": 3.0},
    ]
    merged = merge_incident_specs(registry, harvested)
    assert merged["n_registry"] == 1
    assert merged["n_harvested_added"] == 1
    assert merged["n_harvested_duplicate"] == 1
    assert len(merged["specs"]) == 2
    assert {s["source"] for s in merged["specs"]} == {"registry", "harvested"}
    # registry spec retained over the duplicate harvested one
    nba_x = next(s for s in merged["specs"] if s["game_id"] == "nba-x")
    assert nba_x["id"] == "r1" and nba_x["source"] == "registry"


def test_incident_recall_matched_team_credited_one_legged():
    # TEAM-credited (inverse miscredit): a TEAM rebound that should have been a player.
    team_pbp = {
        "nba-tm": [
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
            # TEAM rebound (no person_id) credited to SAS at the event time
            _a(6, "rebound", "defensive", pid=None, team="SAS", t="2026-01-01T00:10:00Z"),
        ]
    }
    # rightful (B. Two) drifts up around the event; credited is TEAM (no prop -> abstains)
    pre0, pre1 = "2026-01-01T00:08:30Z", "2026-01-01T00:09:00Z"
    post0, post1 = "2026-01-01T00:13:30Z", "2026-01-01T00:14:00Z"
    rows = [("nba-tm", "b-two", "bet365", 6.5, "rebounds", c, p, 100) for c, p in
            ((pre0, 0.40), (pre1, 0.40), (post0, 0.60), (post1, 0.60))]
    inc = [{"id": "team1", "game_id": "nba-tm", "credited_last": "", "rightful_last": "two",
            "event_epoch": _epoch("2026-01-01T00:10:00Z")}]
    res = incident_recall_matched(_ticks(rows), team_pbp, inc, thresholds=(0.0,))
    r = res["incidents"][0]
    assert r["matched"] is True and r["match_dt_sec"] == 0
    assert r["rightful_oncourt"] is True
    assert r["stratum"] == "team_dispute"
    # one-legged: the rightful's own drift is scored (rightful-only), positive here
    assert r["rightful_score"] is not None and r["rightful_score"] > 0
    assert res["n_matched"] == 1 and res["n_scored"] == 1


def test_oncourt_quality_clean_game():
    q = oncourt_quality(PBP)
    assert q["games"] == 1
    assert q["games_bad_starters"] == 0
    assert q["rebounds"] == 1
    assert q["rebounds_oncourt_ne5"] == 0
