"""Offline evaluation of the signed-paired attribution re-ranker over a gold-DB
prop-tick surface. This is a DIAGNOSTIC (it reads the gold DB directly), not a
leakage-safe Quant Lab snapshot model — it answers "on the labeled incidents, what
does the directed-paired score say, and how often must it abstain?".

It joins each (credited, rightful) candidate to its players' rebound-OVER prop ticks
(source_markets x market_instruments x quote_ticks), feeds them to
:func:`attribution.signed_paired_score`, and aggregates support/score. Expect an
abstention-dominant result at the current N: the wrongly-credited player is usually
an illiquid role player, so the credited leg has no ticks (see
docs/research-2026-05-31b...). That abstention rate IS the honest output.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from .attribution import AttributionParams, PairedScore, signed_paired_score


def _epoch(iso: object) -> float | None:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def player_rebound_over_ticks(
    conn: sqlite3.Connection,
    game_id: str,
    player_last: str,
    lo_epoch: float,
    hi_epoch: float,
) -> list[tuple[float, float]]:
    """Rebound-OVER prop ticks for one player in [lo, hi], as (epoch, implied_prob).

    Player resolved by a suffix match on ``market_instruments.participant_key`` so
    'hart' does not match 'hartenstein'. captured_at is ISO text; ISO compares
    lexicographically so the BETWEEN bound is correct.
    """
    lo = datetime.fromtimestamp(lo_epoch, tz=timezone.utc).isoformat()
    hi = datetime.fromtimestamp(hi_epoch, tz=timezone.utc).isoformat()
    rows = conn.execute(
        """
        SELECT q.captured_at, q.implied_probability
        FROM source_markets s
        JOIN market_instruments mi ON s.instrument_id = mi.id
        JOIN quote_ticks q ON q.source_market_id = s.id
        WHERE s.game_id = ?
          AND lower(mi.participant_key) LIKE ?
          AND lower(mi.display_label) LIKE '%rebound%'
          AND mi.selection = 'over'
          AND q.captured_at BETWEEN ? AND ?
        """,
        (game_id, f"%{player_last.lower()}", lo, hi),
    ).fetchall()
    out: list[tuple[float, float]] = []
    for captured_at, prob in rows:
        e = _epoch(captured_at)
        if e is not None and prob is not None:
            out.append((e, float(prob)))
    return out


def score_incident(
    conn: sqlite3.Connection,
    *,
    game_id: str,
    credited_last: str,
    rightful_last: str,
    event_iso: str,
    params: AttributionParams | None = None,
) -> PairedScore | None:
    """Directed-paired score for one incident candidate from gold prop ticks."""
    p = params or AttributionParams()
    t = _epoch(event_iso)
    if t is None:
        return None
    lo, hi = t - p.pre_lo - 60.0, t + p.post_hi + 60.0
    credited = player_rebound_over_ticks(conn, game_id, credited_last, lo, hi) if credited_last else []
    rightful = player_rebound_over_ticks(conn, game_id, rightful_last, lo, hi) if rightful_last else []
    return signed_paired_score(credited, rightful, t, p)


def evaluate(
    conn: sqlite3.Connection,
    incidents: list[dict],
    params: AttributionParams | None = None,
) -> dict:
    """Score a list of incident candidates and aggregate support/score.

    Each incident dict: {id, game_id, credited_last, rightful_last, event_iso}.
    Returns per-incident rows + aggregate counts (the abstention rate is the headline).
    """
    rows: list[dict] = []
    support_counts: dict[str, int] = {}
    for inc in incidents:
        ps = score_incident(
            conn,
            game_id=inc["game_id"],
            credited_last=inc.get("credited_last", ""),
            rightful_last=inc.get("rightful_last", ""),
            event_iso=inc["event_iso"],
            params=params,
        )
        support = "no_event_time" if ps is None else ps.support
        support_counts[support] = support_counts.get(support, 0) + 1
        rows.append(
            {
                "id": inc.get("id"),
                "support": support,
                "score": None if ps is None else ps.score,
                "credited_drift": None if ps is None else ps.credited.drift,
                "rightful_drift": None if ps is None else ps.rightful.drift,
            }
        )
    n = len(rows)
    scored = [r for r in rows if r["score"] is not None]
    abstained = [r for r in rows if r["support"] in ("insufficient_support", "no_event_time")]
    return {
        "n": n,
        "support_counts": support_counts,
        "abstention_rate": (len(abstained) / n) if n else None,
        "n_scored": len(scored),
        "rows": rows,
    }


__all__ = ["player_rebound_over_ticks", "score_incident", "evaluate"]
