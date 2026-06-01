"""Hermetic tests for on-court reconstruction from PBP (starter inference + subs)."""

from __future__ import annotations

from nba_sidecar.research.oncourt import infer_starters, oncourt_by_action, player_teams


def _a(num, at, st=None, pid=None, team=None):
    return {"action_number": num, "action_type": at, "sub_type": st, "person_id": pid, "team_tricode": team}


ACTIONS = [
    _a(1, "jumpball", pid=1, team="SAS"),
    _a(2, "2pt", pid=2, team="SAS"),
    _a(3, "rebound", pid=11, team="OKC"),
    _a(4, "2pt", pid=12, team="OKC"),
    _a(5, "rebound", pid=3, team="SAS"),
    _a(6, "foul", pid=4, team="SAS"),
    _a(7, "turnover", pid=5, team="SAS"),
    _a(8, "steal", pid=13, team="OKC"),
    _a(9, "2pt", pid=14, team="OKC"),
    _a(10, "rebound", pid=15, team="OKC"),
    _a(11, "substitution", "out", 5, "SAS"),
    _a(12, "substitution", "in", 6, "SAS"),
    _a(13, "rebound", pid=6, team="SAS"),
]


def test_player_teams_from_first_appearance():
    teams = player_teams(ACTIONS)
    assert teams[6] == "SAS"
    assert teams[11] == "OKC"


def test_infer_starters():
    teams = player_teams(ACTIONS)
    starters = infer_starters(ACTIONS, teams)
    assert starters["SAS"] == {1, 2, 3, 4, 5}
    assert starters["OKC"] == {11, 12, 13, 14, 15}


def test_oncourt_tracks_substitution():
    oc = oncourt_by_action(ACTIONS)
    # before the sub, SAS is the starting five
    assert oc[10]["SAS"] == {1, 2, 3, 4, 5}
    # after 5 OUT / 6 IN, the unit reflects the swap
    assert oc[13]["SAS"] == {1, 2, 3, 4, 6}
    assert 5 not in oc[13]["SAS"]
    # OKC untouched
    assert oc[13]["OKC"] == {11, 12, 13, 14, 15}
