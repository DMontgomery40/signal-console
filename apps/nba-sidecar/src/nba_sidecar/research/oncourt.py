"""On-court reconstruction from play-by-play — the substrate for the confusability
prior (which on-court players could a rebound have been credited to instead?).

NBA PBP carries substitution events (action_type='substitution', sub_type in/out,
person_id) but no explicit starters. We INFER starters per team and then replay subs
to know the 5-man unit at every action. This is correction-INVARIANT: substitutions
are never re-scored by a stat correction, so the on-court set is a leakage-safe
covariate for the prior.

Starter inference (no boxscore needed): a player started iff, before their first
'sub in', they are subbed OUT or take any non-substitution action — i.e. they were
already on the floor. We take the first 5 such players per team. Edge cases (a
starter who neither acts nor is subbed before a teammate's first sub-in) are rare;
the tracker self-heals on the next sub.

Pure functions over a list of action dicts with keys:
action_number, action_type, sub_type, person_id, team_tricode (others ignored).
"""

from __future__ import annotations

from typing import Any


def player_teams(actions: list[dict[str, Any]]) -> dict[int, str]:
    """person_id -> team_tricode, from each player's first action carrying both."""
    teams: dict[int, str] = {}
    for a in actions:
        pid = a.get("person_id")
        tt = a.get("team_tricode")
        if isinstance(pid, int) and isinstance(tt, str) and tt and pid not in teams:
            teams[pid] = tt
    return teams


def infer_starters(actions: list[dict[str, Any]], teams: dict[int, str]) -> dict[str, set[int]]:
    """First 5 players per team who act or are subbed-out before their first sub-in."""
    seen_in: set[int] = set()
    starters: dict[str, list[int]] = {}
    for a in actions:
        pid = a.get("person_id")
        if not isinstance(pid, int):
            continue
        team = teams.get(pid)
        if team is None:
            continue
        roster = starters.setdefault(team, [])
        if a.get("action_type") == "substitution":
            sub = a.get("sub_type")
            if sub == "in":
                seen_in.add(pid)
            elif sub == "out" and pid not in seen_in and pid not in roster and len(roster) < 5:
                roster.append(pid)
            continue
        # any non-sub action by a not-yet-subbed-in player => they started
        if pid not in seen_in and pid not in roster and len(roster) < 5:
            roster.append(pid)
    return {team: set(roster) for team, roster in starters.items()}


def oncourt_by_action(actions: list[dict[str, Any]]) -> dict[int, dict[str, frozenset[int]]]:
    """Map each action_number -> {team: frozenset(person_ids on court)} as of that
    action (BEFORE applying a substitution that occurs at that same action)."""
    teams = player_teams(actions)
    oncourt: dict[str, set[int]] = {t: set(s) for t, s in infer_starters(actions, teams).items()}
    out: dict[int, dict[str, frozenset[int]]] = {}
    for a in actions:
        num = a.get("action_number")
        if isinstance(num, int):
            out[num] = {t: frozenset(p) for t, p in oncourt.items()}
        if a.get("action_type") == "substitution":
            pid = a.get("person_id")
            team = teams.get(pid) if isinstance(pid, int) else None
            if team is not None:
                if a.get("sub_type") == "in":
                    oncourt.setdefault(team, set()).add(pid)  # type: ignore[arg-type]
                elif a.get("sub_type") == "out":
                    oncourt.get(team, set()).discard(pid)  # type: ignore[arg-type]
    return out


__all__ = ["player_teams", "infer_starters", "oncourt_by_action"]
