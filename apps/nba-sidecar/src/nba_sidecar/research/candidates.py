"""Confusability candidate generator — the prune layer ahead of the re-ranker.

For every player-credited rebound we emit (credited, rightful-candidate) pairs:
the credited player paired with each on-court TEAMMATE who could plausibly have
been the true rebounder. This is the multiple-testing prune, not the signal — the
signed-paired re-ranker (attribution.py) decides which pair, if any, the market
corroborates.

Why teammates (not all 10 on court): a stat *misattribution* credits the right
team's box score to the wrong player; cross-team mis-credits are a different,
rarer error and would not show the anchored "credited drifts against / rightful
drifts toward" market signature within one team's prop set. Without position or
spatial data, `rebounds_so_far` is the correction-INVARIANT confusability rank
(an active rebounder is the plausible alternative); downstream may keep top-K.

Correction-invariant by construction: on-court membership, teammate identity, and
rebound *ordering* are never re-scored by a silent stat correction — only the
*name on the rebound* is. So these candidate sets are leakage-safe.

Pure over a list of PBP action dicts (see oncourt.py for the expected keys, plus
player_name and sub_type/period/clock/time_actual carried through as features).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .oncourt import oncourt_by_action, player_teams


@dataclass(frozen=True)
class ReboundCandidate:
    """One (credited, rightful-candidate) pair for a single rebound event."""

    game_id: str
    action_number: int
    period: int | None
    clock: str | None
    time_actual: str | None
    rebound_type: str | None  # offensive / defensive (PBP sub_type), if present
    team_tricode: str
    credited_person_id: int
    credited_name: str | None
    credited_rebounds_so_far: int
    candidate_person_id: int
    candidate_name: str | None
    candidate_rebounds_so_far: int
    n_oncourt_teammates: int  # FAR denominator contribution for this rebound


def _names(actions: list[dict[str, Any]]) -> dict[int, str]:
    out: dict[int, str] = {}
    for a in actions:
        pid = a.get("person_id")
        name = a.get("player_name")
        if isinstance(pid, int) and isinstance(name, str) and name and pid not in out:
            out[pid] = name
    return out


def rebound_candidates(actions: list[dict[str, Any]], *, game_id: str) -> list[ReboundCandidate]:
    """Emit (credited, rightful-candidate) pairs for every player-credited rebound.

    Team rebounds (no person_id) are skipped — there is no credited player to
    contest. `*_rebounds_so_far` are causal (exclude the current rebound)."""
    oncourt = oncourt_by_action(actions)
    teams = player_teams(actions)
    name_by_pid = _names(actions)
    reb_count: dict[int, int] = {}
    out: list[ReboundCandidate] = []
    for a in actions:
        if a.get("action_type") != "rebound":
            continue
        cid = a.get("person_id")
        if not isinstance(cid, int):
            continue  # team rebound — not a candidate event
        team = a.get("team_tricode") or teams.get(cid)
        if not isinstance(team, str):
            continue
        num = a.get("action_number")
        if not isinstance(num, int):
            continue
        on_court = oncourt.get(num, {}).get(team, frozenset())
        teammates = sorted(p for p in on_court if p != cid)
        credited_so_far = reb_count.get(cid, 0)
        for tid in teammates:
            out.append(
                ReboundCandidate(
                    game_id=game_id,
                    action_number=num,
                    period=a.get("period") if isinstance(a.get("period"), int) else None,
                    clock=a.get("clock") if isinstance(a.get("clock"), str) else None,
                    time_actual=a.get("time_actual") if isinstance(a.get("time_actual"), str) else None,
                    rebound_type=a.get("sub_type") if isinstance(a.get("sub_type"), str) else None,
                    team_tricode=team,
                    credited_person_id=cid,
                    credited_name=name_by_pid.get(cid),
                    credited_rebounds_so_far=credited_so_far,
                    candidate_person_id=tid,
                    candidate_name=name_by_pid.get(tid),
                    candidate_rebounds_so_far=reb_count.get(tid, 0),
                    n_oncourt_teammates=len(teammates),
                )
            )
        reb_count[cid] = credited_so_far + 1
    return out


__all__ = ["ReboundCandidate", "rebound_candidates"]
