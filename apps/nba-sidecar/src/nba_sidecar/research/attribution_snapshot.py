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

from .attribution import (
    AttributionParams,
    LegResult,
    PairedScore,
    leg_drift,
    paired_from_legs,
    signed_paired_score,
)
from .loader import read_player_prop_ticks


def _epoch(iso: object) -> float | None:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


# Generational suffix tokens that are NOT a basketball last name. Without
# stripping them, 'Gary Trent Jr' -> 'jr' (which endswith-matches EVERY -jr
# player slug in the game) and 'Gary Trent Jr.' -> '' (drops out entirely).
_NAME_SUFFIX_RE = re.compile(r"(?:[\s,]+(?:jr|sr|ii|iii|iv|v)\.?)+\s*$", re.IGNORECASE)

# Same suffixes at the END of a participant_key slug ('gary-trent-jr').
_KEY_SUFFIX_RE = re.compile(r"(?:[-_](?:jr|sr|ii|iii|iv|v))+$")


def normalize_player_key(key: str) -> str:
    """'Gary-Trent-Jr' / 'gary-trent-jr' -> 'gary-trent' (lowercased, suffix-free),
    so the last-name suffix match pairs 'trent' with the right slug instead of
    abstaining on (or colliding with) the generational suffix."""
    return _KEY_SUFFIX_RE.sub("", key.strip().lower())


def _normalized_keys(keys: pd.Series) -> pd.Series:
    return keys.map(lambda k: normalize_player_key(str(k)), na_action="ignore")


def _last_name_mask(keys: pd.Series, player_last: str) -> pd.Series:
    """Segment-bounded last-name match on normalized keys: 'hart' matches
    'josh-hart' but NOT 'lockhart' (a plain endswith would)."""
    norm = _normalized_keys(keys)
    last = player_last.lower()
    return (norm == last) | norm.str.endswith("-" + last, na=False)


def resolve_player_key(game_ticks: pd.DataFrame, full_name: str) -> str | None:
    """Resolve a full player NAME to exactly ONE normalized participant_key slug.

    Two same-surname players in one game (two Williams/Thompson/Martin) make a
    last-name suffix join ambiguous: it can blend both players' ticks into one
    series or bind the wrong player, corrupting the signed-paired score. This
    resolver matches the surname at a slug-segment boundary, then — when more
    than one key matches — disambiguates by the name's leading token (full
    first name must equal the slug's first segment; a bare initial must prefix
    it). Unresolvable ambiguity returns None so the leg ABSTAINS rather than
    blending or guessing."""
    last = last_name(full_name)
    if not last or game_ticks.empty:
        return None
    keys = {normalize_player_key(str(k)) for k in game_ticks["player_key"].dropna().unique()}
    matches = sorted(k for k in keys if k == last or k.endswith("-" + last))
    if len(matches) == 1:
        return matches[0]
    if not matches:
        return None
    lead_tokens = _NAME_SUFFIX_RE.sub("", full_name.strip()).strip().split()
    first = lead_tokens[0].rstrip(".").lower() if lead_tokens else ""
    if first and first != last:
        if len(first) == 1:
            narrowed = [k for k in matches if k.split("-")[0].startswith(first)]
        else:
            narrowed = [k for k in matches if k.split("-")[0] == first]
        if len(narrowed) == 1:
            return narrowed[0]
    return None


def grouped_series_for_player_key(
    game_ticks: pd.DataFrame, norm_key: str
) -> list[list[tuple[float, float]]]:
    """Per-(source, line) implied-prob series for ONE resolved player key.

    Rows are matched on the normalized key EXACTLY (never a name suffix), so a
    series can only ever contain one player's ticks."""
    sub = game_ticks[_normalized_keys(game_ticks["player_key"]) == norm_key]
    out: list[list[tuple[float, float]]] = []
    for _, g in sub.groupby(["source", "line"], dropna=False):
        g = g.sort_values("captured_at")
        ser: list[tuple[float, float]] = []
        for captured_at, prob in zip(g["captured_at"], g["implied_probability"]):
            e = _epoch(captured_at)
            if e is not None and pd.notna(prob):
                ser.append((e, float(prob)))
        if ser:
            out.append(ser)
    return out


def series_for_player_key(game_ticks: pd.DataFrame, norm_key: str) -> list[tuple[float, float]]:
    """ONE coherent (source, line) series for a resolved player key — the
    most_active convention, key-exact (see grouped_series_for_player_key)."""
    groups = grouped_series_for_player_key(game_ticks, norm_key)
    if not groups:
        return []
    return max(groups, key=len)


def last_name(player: str) -> str:
    """'V. Wembanyama' / 'Victor Wembanyama' -> 'wembanyama'; '' / 'TEAM ...' -> ''.

    The incident registry's credited/rightful are sometimes descriptive PHRASES
    ('J. Champagnie live rebound display', 'K. Towns (suspected; foul dispute)'),
    where the player NAME leads and prose trails. Prefer a leading 'I. Lastname'
    token so the name wins over the trailing word; only fall back to the trailing
    word for plain names ('Sam Hauser', 'Victor Wembanyama'). Without this, those
    incidents silently mis-parse and drop out of the eval denominator.

    Generational suffixes are stripped FIRST ('Gary Trent Jr.' -> 'trent',
    'Wendell Carter III' -> 'carter'); see _NAME_SUFFIX_RE."""
    if not player or "team" in player.lower():
        return ""
    player = _NAME_SUFFIX_RE.sub("", player.strip())
    lead = re.search(r"\b[A-Z]\.\s*([A-Z][a-zA-Z'\-]+)", player.strip())
    if lead:
        return lead.group(1).lower()
    m = re.search(r"([A-Z][a-zA-Z'\-]+)\s*$", player.strip())
    if m:
        return m.group(1).lower()
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
        (ticks_df["game_id"] == game_id) & _last_name_mask(ticks_df["player_key"], player_last)
    ]
    if sub.empty:
        return []
    # player_key participates in the grouping so two same-surname players can
    # never blend into one series; a NAME this ambiguous should be resolved via
    # resolve_player_key upstream when a full name is available.
    groups = list(sub.groupby(["player_key", "source", "line"], dropna=False))
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


def aggregate_leg_drift(
    ticks_df: pd.DataFrame,
    game_id: str,
    player_last: str,
    event_epoch: float,
    params: AttributionParams,
) -> LegResult:
    """Drift aggregated ACROSS a player's (source, line) series: leg_drift per group,
    then mean of the non-abstaining drifts. Level-invariant (each line's drift is
    post-pre), so it keeps coverage without blending line levels. Abstains only if
    NO (source, line) series has enough ticks in the window."""
    if not player_last:
        return LegResult(drift=None, n_ticks=0, abstain=True)
    sub = ticks_df[
        (ticks_df["game_id"] == game_id) & _last_name_mask(ticks_df["player_key"], player_last)
    ]
    if sub.empty:
        return LegResult(drift=None, n_ticks=0, abstain=True)
    drifts: list[float] = []
    total_ticks = 0
    # player_key in the grouping: same-surname players never blend in a series.
    for _, g in sub.groupby(["player_key", "source", "line"], dropna=False):
        ser: list[tuple[float, float]] = []
        for captured_at, prob in zip(g["captured_at"], g["implied_probability"]):
            e = _epoch(captured_at)
            if e is not None and pd.notna(prob):
                ser.append((e, float(prob)))
        lr = leg_drift(ser, event_epoch, params)
        total_ticks += lr.n_ticks
        if not lr.abstain and lr.drift is not None:
            drifts.append(lr.drift)
    if not drifts:
        return LegResult(drift=None, n_ticks=total_ticks, abstain=True)
    return LegResult(drift=sum(drifts) / len(drifts), n_ticks=total_ticks, abstain=False)


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
    """Score one incident from the snapshot. Returns (PairedScore|None, stratum).

    line_select: 'most_active' | 'closest_to_half' pick ONE coherent series per
    player; 'aggregate_drift' computes per-(source,line) drift then averages
    (keeps coverage, level-invariant -> lower abstention)."""
    p = params or AttributionParams()
    cl, rl = last_name(credited_player), last_name(rightful_player)
    stratum = "player_swap" if (cl and rl) else "team_dispute"
    t = _epoch(event_iso)
    if t is None:
        return None, stratum
    if line_select == "aggregate_drift":
        c = aggregate_leg_drift(ticks_df, game_id, cl, t, p)
        r = aggregate_leg_drift(ticks_df, game_id, rl, t, p)
        return paired_from_legs(c, r), stratum
    credited = select_player_series(ticks_df, game_id, cl, line_select=line_select)
    rightful = select_player_series(ticks_df, game_id, rl, line_select=line_select)
    return signed_paired_score(credited, rightful, t, p), stratum


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


__all__ = [
    "last_name",
    "normalize_player_key",
    "resolve_player_key",
    "grouped_series_for_player_key",
    "series_for_player_key",
    "select_player_series",
    "aggregate_leg_drift",
    "score_incident_snapshot",
    "evaluate_snapshot",
]
