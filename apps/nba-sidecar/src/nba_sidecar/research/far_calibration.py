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
from .candidates import rebound_candidates, team_rebound_candidates
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


def incident_recall_matched(
    ticks_df: pd.DataFrame,
    pbp_by_game: dict[str, list[dict[str, Any]]],
    incidents: list[dict[str, Any]],
    *,
    params: AttributionParams | None = None,
    thresholds: tuple[float, ...] = DEFAULT_THRESHOLDS,
    match_window_sec: float = 300.0,
) -> dict[str, Any]:
    """Push each known incident through the SAME candidate path used for FAR, so
    recall (TPR) and false-alarm rate share an operating point (advisor).

    For each incident {id, game_id, credited_last, rightful_last, event_epoch}:
    locate the rebound credited to ``credited_last`` nearest ``event_epoch`` (within
    ``match_window_sec``), score all its (credited, teammate) candidates, and record
    whether the rightful is on court, its score, its rank among candidates BY SCORE
    and BY the rebounds_so_far prior, and whether it is the score-argmax. The
    by-prior vs by-score ranks directly test whether prior-pruning would keep or
    discard the true rightful.

    TEAM-credited incidents (credited_last == "") are the inverse miscredit (the box
    score credited the team, not a player): matched against a TEAM rebound and scored
    ONE-LEGGED (no TEAM prop). Structural coverage only — the one-legged score is the
    rightful's own drift, not the paired signature, so it does not move the headline.

    Honest denominators are all reported separately (n_incidents >= n_matched >=
    n_rightful_oncourt >= n_scored); with a handful of incidents every rate has a
    CI spanning most of [0,1] — the caller MUST surface N alongside any TPR."""
    p = params or AttributionParams()
    by_game = {gid: sub for gid, sub in ticks_df.groupby("game_id", sort=False)} if not ticks_df.empty else {}
    out_rows: list[dict[str, Any]] = []
    for inc in incidents:
        gid = inc["game_id"]
        row: dict[str, Any] = {
            "id": inc.get("id"),
            "game_id": gid,
            "credited_last": inc.get("credited_last"),
            "rightful_last": inc.get("rightful_last"),
            "source": inc.get("source", "registry"),
            "matched": False,
            "rightful_oncourt": None,
            "rightful_score": None,
            "max_score": None,
            "rank_by_score": None,
            "rank_by_prior": None,
            "is_score_argmax": None,
        }
        actions = pbp_by_game.get(gid)
        cl, rl, ev = inc.get("credited_last") or "", inc.get("rightful_last") or "", inc.get("event_epoch")
        if not actions or not rl or ev is None:
            row["reason"] = "missing pbp/rightful/event"
            out_rows.append(row)
            continue
        if not cl:
            # TEAM-credited (inverse miscredit): match a TEAM rebound near the event
            # where the rightful is on-court for the rebounding team, score one-legged
            # (credited=TEAM has no prop -> abstains -> just the rightful's own drift).
            # Structural coverage; the score is NOT the paired signature.
            row["stratum"] = "team_dispute"
            by_team: dict[int, list] = {}
            for tc in team_rebound_candidates(actions, game_id=gid):
                by_team.setdefault(tc.action_number, []).append(tc)
            best_team_action, best_team_dt = None, match_window_sec
            for action_number, tcs in by_team.items():
                t = _epoch(tcs[0].time_actual)
                if t is None:
                    continue
                if rl not in {last_name(tc.candidate_name or "") for tc in tcs}:
                    continue  # rightful must be on-court for this TEAM rebound
                dt = abs(t - ev)
                if dt <= best_team_dt:
                    best_team_dt, best_team_action = dt, action_number
            if best_team_action is None:
                row["reason"] = "no team rebound within match window"
                out_rows.append(row)
                continue
            row["matched"] = True
            row["match_dt_sec"] = round(best_team_dt)
            tcs = by_team[best_team_action]
            scorer = _make_aggregate_scorer(by_game.get(gid, ticks_df.iloc[0:0]), p)
            tscored = [
                {
                    "last": last_name(tc.candidate_name or ""),
                    "score": (lambda ps: None if ps is None else ps.score)(
                        scorer("", tc.candidate_name or "", tc.time_actual or "")[0]
                    ),
                }
                for tc in tcs
            ]
            trightful = next((s for s in tscored if s["last"] == rl), None)
            row["rightful_oncourt"] = trightful is not None
            if trightful is not None and trightful["score"] is not None:
                tvals = [s["score"] for s in tscored if s["score"] is not None]
                row["rightful_score"] = trightful["score"]
                row["max_score"] = max(tvals) if tvals else None
                row["rank_by_score"] = sorted(tvals, reverse=True).index(trightful["score"]) + 1
                row["is_score_argmax"] = trightful["score"] == max(tvals)
            out_rows.append(row)
            continue
        by_action: dict[int, list] = {}
        for c in rebound_candidates(actions, game_id=gid):
            by_action.setdefault(c.action_number, []).append(c)
        best_action, best_dt = None, match_window_sec
        for action_number, cs in by_action.items():
            if last_name(cs[0].credited_name or "") != cl:
                continue
            t = _epoch(cs[0].time_actual)
            if t is None:
                continue
            dt = abs(t - ev)
            if dt <= best_dt:
                best_dt, best_action = dt, action_number
        if best_action is None:
            row["reason"] = "no credited rebound within match window"
            out_rows.append(row)
            continue
        row["matched"] = True
        row["match_dt_sec"] = round(best_dt)
        cs = by_action[best_action]
        scorer = _make_aggregate_scorer(by_game.get(gid, ticks_df.iloc[0:0]), p)
        scored = []
        for c in cs:
            ps, _ = scorer(c.credited_name or "", c.candidate_name or "", c.time_actual or "")
            scored.append(
                {
                    "last": last_name(c.candidate_name or ""),
                    "score": None if ps is None else ps.score,
                    "prior": c.candidate_rebounds_so_far,
                }
            )
        rightful = next((s for s in scored if s["last"] == rl), None)
        row["rightful_oncourt"] = rightful is not None
        if rightful is None:
            out_rows.append(row)
            continue
        scored_vals = [s["score"] for s in scored if s["score"] is not None]
        row["rank_by_prior"] = sorted(scored, key=lambda s: -s["prior"]).index(rightful) + 1
        if rightful["score"] is not None:
            row["rightful_score"] = rightful["score"]
            row["max_score"] = max(scored_vals) if scored_vals else None
            row["rank_by_score"] = sorted(scored_vals, reverse=True).index(rightful["score"]) + 1
            row["is_score_argmax"] = rightful["score"] == max(scored_vals)
        out_rows.append(row)

    matched = [r for r in out_rows if r["matched"]]
    oncourt = [r for r in matched if r["rightful_oncourt"]]
    scored = [r for r in oncourt if r["rightful_score"] is not None]
    tpr_per_pair = {
        th: (sum(1 for r in scored if r["rightful_score"] >= th) / len(scored)) if scored else None
        for th in thresholds
    }
    tpr_argmax = {
        th: (sum(1 for r in scored if r["is_score_argmax"] and r["max_score"] >= th) / len(scored)) if scored else None
        for th in thresholds
    }
    return {
        "n_incidents": len(out_rows),
        "n_matched": len(matched),
        "n_rightful_oncourt": len(oncourt),
        "n_scored": len(scored),
        "thresholds": list(thresholds),
        # TPR over the n_scored denominator (NOT n_incidents) — recall conditional
        # on a recoverable, liquid rebound. With n_scored tiny the CI ~= [0,1].
        "tpr_per_pair": tpr_per_pair,
        "tpr_correct_argmax": tpr_argmax,
        "rank_by_prior": [r["rank_by_prior"] for r in oncourt if r["rank_by_prior"] is not None],
        "rank_by_score": [r["rank_by_score"] for r in scored if r["rank_by_score"] is not None],
        "incidents": out_rows,
    }


def harvested_label_specs(report: Any, stat: str = "rebound") -> list[dict[str, Any]]:
    """Convert a parsed harvested_incidents.json report into incident specs for
    incident_recall_matched. Keeps stat-bearing labels with a parseable credited,
    rightful, and event time. Closes the loop: capture -> harvest -> eval."""
    out: list[dict[str, Any]] = []
    incidents = report.get("incidents", []) if isinstance(report, dict) else []
    if not isinstance(incidents, list):
        return out
    for inc in incidents:
        if not isinstance(inc, dict):
            continue
        if str(inc.get("stat", "")).lower() != stat:
            continue
        cl = last_name(str(inc.get("creditedPlayer", "")))
        rl = last_name(str(inc.get("rightfulPlayer", "")))
        ev = _epoch(inc.get("utcTime"))
        gid = str(inc.get("gameId", ""))
        if cl and rl and ev is not None and gid:
            out.append(
                {"id": inc.get("id"), "game_id": gid, "credited_last": cl, "rightful_last": rl, "event_epoch": ev}
            )
    return out


def merge_incident_specs(
    registry: list[dict[str, Any]], harvested: list[dict[str, Any]]
) -> dict[str, Any]:
    """Merge curated registry incidents with harvested labels, deduped by
    (game_id, credited_last, rightful_last). Registry wins (same miscredit). Tags
    each spec with its source so recall can report the harvested contribution."""
    seen = {(s["game_id"], s["credited_last"], s["rightful_last"]) for s in registry}
    merged: list[dict[str, Any]] = [{**s, "source": "registry"} for s in registry]
    added = duplicate = 0
    for s in harvested:
        key = (s["game_id"], s["credited_last"], s["rightful_last"])
        if key in seen:
            duplicate += 1
            continue
        seen.add(key)
        merged.append({**s, "source": "harvested"})
        added += 1
    return {
        "specs": merged,
        "n_registry": len(registry),
        "n_harvested_added": added,
        "n_harvested_duplicate": duplicate,
    }


__all__ = [
    "DEFAULT_THRESHOLDS",
    "score_control_pairs",
    "summarize_far",
    "oncourt_quality",
    "incident_recall_matched",
    "harvested_label_specs",
    "merge_incident_specs",
]
