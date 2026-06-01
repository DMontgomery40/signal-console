"""False-alarm-rate calibration for the signed-paired re-ranker on control games.

This is the re-ranker's falsification test. On assumed-negative (control) games
the credited player IS the true rebounder, so any (credited, on-court-teammate)
pair whose market shows the anchored "credited drifts against / teammate drifts
toward" signature is a FALSE alarm. We:

1. generate candidate pairs per rebound (candidates.rebound_candidates),
2. score each pair through the SAME path incidents use
   (attribution_snapshot.score_incident_snapshot — apples-to-apples with recall),
3. sweep a decision threshold and report the fire-rate two ways:
   - per candidate pair (the raw market-conditioned FAR), and
   - per rebound = max score over its ~4 candidates (the multiple-testing-inflated
     FAR a live "this rebound looks contested" alert would actually incur).

The honest read (advisor): if no threshold holds a low per-rebound FAR while still
clearing the tiny incident player_swap median (~+0.022), the direction does not
separate at this N — a legitimate, reportable result.

Pure over an injected ``pbp_by_game`` (game_id -> list[action dict]) and a ticks
DataFrame, so it is hermetically testable; the CLI wires the gold/snapshot reads.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from .attribution import AttributionParams, LegResult, leg_drift, paired_from_legs
from .attribution_snapshot import _epoch, last_name, score_incident_snapshot
from .candidates import rebound_candidates
from .oncourt import infer_starters, oncourt_by_action, player_teams

DEFAULT_THRESHOLDS: tuple[float, ...] = (0.0, 0.01, 0.02, 0.05, 0.1, 0.2)


def _agg_from_series(series_list: list[list[tuple[float, float]]], t: float, params: AttributionParams) -> LegResult:
    """Mean of the non-abstaining per-(source,line) drifts — the aggregate_drift
    leg, computed from PRE-GROUPED series (identical to attribution_snapshot.
    aggregate_leg_drift, but the grouping is hoisted out of the per-pair loop)."""
    drifts: list[float] = []
    total = 0
    for ser in series_list:
        lr = leg_drift(ser, t, params)
        total += lr.n_ticks
        if not lr.abstain and lr.drift is not None:
            drifts.append(lr.drift)
    if not drifts:
        return LegResult(drift=None, n_ticks=total, abstain=True)
    return LegResult(drift=sum(drifts) / len(drifts), n_ticks=total, abstain=False)


def _make_aggregate_scorer(game_ticks: pd.DataFrame, params: AttributionParams):
    """Closure scoring (credited, rightful) NAME pairs for ONE game, caching each
    player's (source,line) series so repeated candidates don't re-group the slice."""
    empty = game_ticks.empty
    cache: dict[str, list[list[tuple[float, float]]]] = {}

    def series_for(player_last: str) -> list[list[tuple[float, float]]]:
        if player_last in cache:
            return cache[player_last]
        out: list[list[tuple[float, float]]] = []
        if player_last and not empty:
            sub = game_ticks[game_ticks["player_key"].str.lower().str.endswith(player_last, na=False)]
            for _, g in sub.groupby(["source", "line"], dropna=False):
                ser: list[tuple[float, float]] = []
                for captured_at, prob in zip(g["captured_at"], g["implied_probability"]):
                    e = _epoch(captured_at)
                    if e is not None and pd.notna(prob):
                        ser.append((e, float(prob)))
                out.append(ser)
        cache[player_last] = out
        return out

    def score(credited_name: str, rightful_name: str, event_iso: str):
        cl, rl = last_name(credited_name), last_name(rightful_name)
        stratum = "player_swap" if (cl and rl) else "team_dispute"
        t = _epoch(event_iso)
        if t is None:
            return None, stratum
        c_leg = _agg_from_series(series_for(cl), t, params)
        r_leg = _agg_from_series(series_for(rl), t, params)
        return paired_from_legs(c_leg, r_leg), stratum

    return score


def score_control_pairs(
    ticks_df: pd.DataFrame,
    pbp_by_game: dict[str, list[dict[str, Any]]],
    *,
    params: AttributionParams | None = None,
    line_select: str = "aggregate_drift",
) -> list[dict[str, Any]]:
    """Score every (credited, teammate) candidate pair on the given games.

    Pre-slices ticks per game ONCE (the full df is millions of rows). For the
    default aggregate_drift mode it also caches each player's (source,line) series
    per game, so scoring is O(players + pairs) instead of O(pairs * groupby) while
    staying numerically identical to attribution_snapshot.aggregate_leg_drift."""
    p = params or AttributionParams()
    rows: list[dict[str, Any]] = []
    by_game = {gid: sub for gid, sub in ticks_df.groupby("game_id", sort=False)} if not ticks_df.empty else {}
    for game_id, actions in pbp_by_game.items():
        game_ticks = by_game.get(game_id, ticks_df.iloc[0:0])
        fast = _make_aggregate_scorer(game_ticks, p) if line_select == "aggregate_drift" else None
        for c in rebound_candidates(actions, game_id=game_id):
            base = {
                "game_id": game_id,
                "action_number": c.action_number,
                "candidate_person_id": c.candidate_person_id,
                "rebound_type": c.rebound_type,
            }
            if not c.time_actual or not c.credited_name or not c.candidate_name:
                rows.append({**base, "stratum": "player_swap", "support": "insufficient_inputs", "score": None})
                continue
            if fast is not None:
                ps, stratum = fast(c.credited_name, c.candidate_name, c.time_actual)
            else:
                ps, stratum = score_incident_snapshot(
                    game_ticks,
                    game_id=game_id,
                    credited_player=c.credited_name,
                    rightful_player=c.candidate_name,
                    event_iso=c.time_actual,
                    params=p,
                    line_select=line_select,
                )
            rows.append(
                {
                    **base,
                    "stratum": stratum,
                    "support": "no_event_time" if ps is None else ps.support,
                    "score": None if ps is None else ps.score,
                }
            )
    return rows


def summarize_far(rows: list[dict[str, Any]], thresholds: tuple[float, ...] = DEFAULT_THRESHOLDS) -> dict[str, Any]:
    """Per-pair and per-rebound (max-over-candidates) fire-rates across thresholds."""
    scored = [r for r in rows if r["score"] is not None]
    per_pair = {
        th: (sum(1 for r in scored if r["score"] >= th) / len(scored)) if scored else None for th in thresholds
    }
    by_reb: dict[tuple[str, int], float] = {}
    for r in scored:
        key = (r["game_id"], r["action_number"])
        by_reb[key] = max(by_reb.get(key, float("-inf")), r["score"])
    reb_scores = list(by_reb.values())
    per_rebound = {
        th: (sum(1 for s in reb_scores if s >= th) / len(reb_scores)) if reb_scores else None for th in thresholds
    }
    return {
        "n_pairs": len(rows),
        "n_scored_pairs": len(scored),
        "n_rebounds_scored": len(reb_scores),
        "abstention_rate": (1 - len(scored) / len(rows)) if rows else None,
        "thresholds": list(thresholds),
        "per_pair_far": per_pair,
        "per_rebound_far": per_rebound,
    }


def oncourt_quality(pbp_by_game: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Reconstruction data-quality gate (advisor #4): surface games whose starter
    inference != 5/team and rebounds whose on-court unit != 5, so reconstruction
    failures don't silently pollute the FAR estimate."""
    tot_games = bad_games = tot_reb = bad_reb = 0
    for actions in pbp_by_game.values():
        tot_games += 1
        teams = player_teams(actions)
        starters = infer_starters(actions, teams)
        if len(starters) != 2 or any(len(s) != 5 for s in starters.values()):
            bad_games += 1
        oncourt = oncourt_by_action(actions)
        for a in actions:
            if a.get("action_type") == "rebound" and isinstance(a.get("person_id"), int) and a.get("team_tricode"):
                tot_reb += 1
                unit = oncourt.get(a["action_number"], {}).get(a["team_tricode"], frozenset())
                if len(unit) != 5:
                    bad_reb += 1
    return {
        "games": tot_games,
        "games_bad_starters": bad_games,
        "rebounds": tot_reb,
        "rebounds_oncourt_ne5": bad_reb,
        "rebounds_oncourt_ne5_frac": (bad_reb / tot_reb) if tot_reb else None,
    }


__all__ = ["DEFAULT_THRESHOLDS", "score_control_pairs", "summarize_far", "oncourt_quality"]
