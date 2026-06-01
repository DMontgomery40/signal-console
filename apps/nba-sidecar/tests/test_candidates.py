"""Hermetic tests for the confusability candidate generator."""

from __future__ import annotations

from nba_sidecar.research.candidates import (
    ReboundCandidate,
    TeamReboundCandidate,
    rebound_candidates,
    team_rebound_candidates,
)


def _a(num, at, st=None, pid=None, team=None, name=None):
    return {
        "action_number": num,
        "action_type": at,
        "sub_type": st,
        "person_id": pid,
        "team_tricode": team,
        "player_name": name,
        "period": 1,
        "clock": "PT11M00S",
        "time_actual": None,
    }


# SAS starters 1-5 establish themselves; player 3 is credited two rebounds.
ACTIONS = [
    _a(1, "jumpball", pid=1, team="SAS", name="A. One"),
    _a(2, "2pt", pid=2, team="SAS", name="B. Two"),
    _a(3, "2pt", pid=3, team="SAS", name="C. Three"),
    _a(4, "foul", pid=4, team="SAS", name="D. Four"),
    _a(5, "turnover", pid=5, team="SAS", name="E. Five"),
    _a(6, "2pt", pid=11, team="OKC", name="Z. Opp"),
    _a(7, "rebound", "defensive", pid=3, team="SAS", name="C. Three"),
    _a(8, "rebound", "offensive", pid=3, team="SAS", name="C. Three"),
]


def test_pairs_are_oncourt_teammates_only():
    cands = rebound_candidates(ACTIONS, game_id="nba-test")
    # 2 rebounds * 4 teammates each = 8 pairs
    assert len(cands) == 8
    assert all(isinstance(c, ReboundCandidate) for c in cands)
    # every pair is a SAS teammate of the credited player, never the credited self, never OKC
    for c in cands:
        assert c.team_tricode == "SAS"
        assert c.credited_person_id == 3
        assert c.candidate_person_id in {1, 2, 4, 5}
        assert c.n_oncourt_teammates == 4


def test_rebounds_so_far_is_causal():
    cands = rebound_candidates(ACTIONS, game_id="nba-test")
    first = [c for c in cands if c.action_number == 7]
    second = [c for c in cands if c.action_number == 8]
    # credited player's running count excludes the current rebound
    assert all(c.credited_rebounds_so_far == 0 for c in first)
    assert all(c.credited_rebounds_so_far == 1 for c in second)
    # rebound type carried through
    assert {c.rebound_type for c in first} == {"defensive"}
    assert {c.rebound_type for c in second} == {"offensive"}
    # names resolve for both credited and candidate even before they act
    assert {c.candidate_name for c in first} == {"A. One", "B. Two", "D. Four", "E. Five"}


def test_team_rebound_has_no_player_credited_candidates():
    actions = ACTIONS + [_a(9, "rebound", "defensive", pid=None, team="SAS")]
    cands = rebound_candidates(actions, game_id="nba-test")
    # the person-less team rebound adds nothing to the player-credited path
    assert len(cands) == 8


def test_team_rebound_candidates_emit_oncourt_players():
    actions = ACTIONS + [_a(9, "rebound", "defensive", pid=None, team="SAS")]
    cands = team_rebound_candidates(actions, game_id="nba-test")
    assert all(isinstance(c, TeamReboundCandidate) for c in cands)
    # all 5 on-court SAS players are rightful candidates for the TEAM rebound
    assert {c.candidate_person_id for c in cands} == {1, 2, 3, 4, 5}
    assert all(c.team_tricode == "SAS" and c.action_number == 9 for c in cands)
    assert all(c.rebound_type == "defensive" for c in cands)
    # OKC TEAM rebound on the other team is unaffected; no candidates without a TEAM rebound
    assert team_rebound_candidates(ACTIONS, game_id="nba-test") == []
