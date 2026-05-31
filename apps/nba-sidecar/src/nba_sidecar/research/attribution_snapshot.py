"""Snapshot-backed signed-paired attribution re-ranker (leakage-safe Quant Lab path).

Unlike :mod:`attribution_eval` (which reads the gold DB directly), this consumes the
snapshot's ``player_prop_ticks`` table via the loader, so it is leakage-safe and
runs the same way an offline Quant Lab model does. It:

1. selects ONE coherent (source, line) series per player (default: the most-active
   line — most ticks — to avoid blending over-5.5/over-9.5 levels);
2. feeds the credited + rightful series to :func:`attribution.signed_paired_score`;
3. stratifies candidates into **player_swap** (both credited & rightful are players)
   vs **team_dispute** (credit went to/from TEAM, so the "rightful" is speculative) —
   the directed hypothesis holds for the former, not the latter (note II).

Fail-closed throughout: a player with no ticks (illiquid role player) yields an empty
series → the leg abstains → see signed_paired_score's support flags.
"""

from __future__ import annotations

import re
from datetime import datetime

import pandas as pd

from .attribution import AttributionParams, PairedScore, signed_paired_score
from .loader import read_player_prop_ticks


def _epoch(iso: object) -> float | None:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def last_name(player: str) -> str:
    """'V. Wembanyama' / 'Victor Wembanyama' -> 'wembanyama'; '' / 'TEAM ...' -> ''."""
    if not player or "team" in player.lower():
        return ""
    m = re.search(r"([A-Z]\.\s*)?([A-Z][a-zA-Z'\-]+)\s*$", player.strip())
    if m:
        return m.group(2).lower()
    m2 = re.search(r"([A-Za-z'\-]+)\s*$", player.strip())
    return m2.group(1).lower() if m2 else ""


def select_player_series(
    ticks_df: pd.DataFrame,
    game_id: str,
    player_last: str,
    *,
    line_select: str = "most_active",
) -> list[tuple[float, float]]:
    """Pick ONE coherent (source, line) implied-prob series for a player in a game.

    ``most_active`` = the (source, line) group with the most ticks (default).
    ``closest_to_half`` = the group whose median implied prob is nearest 0.5 (most
    information-bearing near-the-money line). Returns [] when the player is absent
    (illiquid) so the leg abstains downstream.
    """
    if not player_last:
        return []
    sub = ticks_df[
        (ticks_df["game_id"] == game_id)
        & ticks_df["player_key"].str.lower().str.endswith(player_last.lower(), na=False)
    ]
    if sub.empty:
        return []
    groups = list(sub.groupby(["source", "line"], dropna=False))
    if line_select == "closest_to_half":
        _, best = min(groups, key=lambda kv: abs(float(kv[1]["implied_probability"].median()) - 0.5))
    else:
        _, best = max(groups, key=lambda kv: len(kv[1]))
    g = best.sort_values("captured_at")
    out: list[tuple[float, float]] = []
    for captured_at, prob in zip(g["captured_at"], g["implied_probability"]):
        e = _epoch(captured_at)
        if e is not None and pd.notna(prob):
            out.append((e, float(prob)))
    return out


def score_incident_snapshot(
    ticks_df: pd.DataFrame,
    *,
    game_id: str,
    credited_player: str,
    rightful_player: str,
    event_iso: str,
    params: AttributionParams | None = None,
    line_select: str = "most_active",
) -> tuple[PairedScore | None, str]:
    """Score one incident from the snapshot. Returns (PairedScore|None, stratum)."""
    cl, rl = last_name(credited_player), last_name(rightful_player)
    stratum = "player_swap" if (cl and rl) else "team_dispute"
    t = _epoch(event_iso)
    if t is None:
        return None, stratum
    credited = select_player_series(ticks_df, game_id, cl, line_select=line_select)
    rightful = select_player_series(ticks_df, game_id, rl, line_select=line_select)
    return signed_paired_score(credited, rightful, t, params), stratum


def evaluate_snapshot(
    snapshot_path: str,
    incidents: list[dict],
    params: AttributionParams | None = None,
    line_select: str = "most_active",
) -> dict:
    """Score incident candidates from the snapshot's player_prop_ticks, stratified.

    Each incident dict: {id, game_id, credited_player, rightful_player, event_iso}.
    Returns per-incident rows + per-stratum + overall support/abstention aggregates.
    """
    df = read_player_prop_ticks(snapshot_path)
    rows: list[dict] = []
    for inc in incidents:
        ps, stratum = score_incident_snapshot(
            df,
            game_id=inc["game_id"],
            credited_player=inc.get("credited_player", ""),
            rightful_player=inc.get("rightful_player", ""),
            event_iso=inc["event_iso"],
            params=params,
            line_select=line_select,
        )
        rows.append(
            {
                "id": inc.get("id"),
                "stratum": stratum,
                "support": "no_event_time" if ps is None else ps.support,
                "score": None if ps is None else ps.score,
            }
        )

    def _agg(subset: list[dict]) -> dict:
        n = len(subset)
        scored = [r for r in subset if r["score"] is not None]
        abst = [r for r in subset if r["support"] in ("insufficient_support", "no_event_time")]
        med = None
        if scored:
            vals = sorted(r["score"] for r in scored)
            med = vals[len(vals) // 2] if len(vals) % 2 else (vals[len(vals) // 2 - 1] + vals[len(vals) // 2]) / 2
        return {"n": n, "n_scored": len(scored), "abstention_rate": (len(abst) / n) if n else None, "median_score": med}

    return {
        "overall": _agg(rows),
        "player_swap": _agg([r for r in rows if r["stratum"] == "player_swap"]),
        "team_dispute": _agg([r for r in rows if r["stratum"] == "team_dispute"]),
        "rows": rows,
    }


__all__ = ["last_name", "select_player_series", "score_incident_snapshot", "evaluate_snapshot"]
