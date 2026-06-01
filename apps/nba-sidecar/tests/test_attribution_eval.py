"""Hermetic tests for the gold-backed re-ranker eval (synthetic in-memory sqlite).

Builds the minimal source_markets x market_instruments x quote_ticks join the eval
queries, seeds a miscredit-shaped tick pattern, and asserts the directed score +
the fail-closed abstention path — no real gold DB needed.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

from nba_sidecar.research.attribution_eval import evaluate, score_incident

EVENT = "2026-05-21T02:00:43.6Z"


def _iso(offset_s: float) -> str:
    base = datetime.fromisoformat(EVENT.replace("Z", "+00:00")).timestamp()
    return datetime.fromtimestamp(base + offset_s, tz=timezone.utc).isoformat()


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.executescript(
        """
        CREATE TABLE source_markets (id INTEGER PRIMARY KEY, game_id TEXT, instrument_id INTEGER);
        CREATE TABLE market_instruments (id INTEGER PRIMARY KEY, participant_key TEXT, display_label TEXT, selection TEXT);
        CREATE TABLE quote_ticks (id INTEGER PRIMARY KEY, source_market_id INTEGER, captured_at TEXT, implied_probability REAL);
        """
    )
    return c


def _add_market(c: sqlite3.Connection, *, sm_id: int, mi_id: int, game: str, participant: str) -> None:
    c.execute("INSERT INTO market_instruments VALUES (?,?,?,?)", (mi_id, participant, f"{participant} rebounds over 5.5", "over"))
    c.execute("INSERT INTO source_markets VALUES (?,?,?)", (sm_id, game, mi_id))


def _add_ticks(c: sqlite3.Connection, sm_id: int, pts: list[tuple[float, float]]) -> None:
    for off, p in pts:
        c.execute("INSERT INTO quote_ticks (source_market_id, captured_at, implied_probability) VALUES (?,?,?)", (sm_id, _iso(off), p))


def test_miscredit_shape_scores_positive_from_gold_like_join():
    c = _conn()
    _add_market(c, sm_id=1, mi_id=1, game="nba-0042500312", participant="victor-wembanyama")
    _add_market(c, sm_id=2, mi_id=2, game="nba-0042500312", participant="julian-champagnie")
    # rightful (wembanyama) rises; credited (champagnie) falls
    _add_ticks(c, 1, [(-100, 0.30), (-40, 0.30), (200, 0.55), (280, 0.55)])
    _add_ticks(c, 2, [(-100, 0.60), (-40, 0.60), (200, 0.45), (280, 0.45)])
    ps = score_incident(c, game_id="nba-0042500312", credited_last="champagnie", rightful_last="wembanyama", event_iso=EVENT)
    assert ps is not None and ps.support == "ok"
    assert ps.score == pytest.approx(0.40)


def test_credited_illiquid_abstains_to_rightful_only():
    c = _conn()
    _add_market(c, sm_id=1, mi_id=1, game="g", participant="victor-wembanyama")
    _add_ticks(c, 1, [(-100, 0.30), (-40, 0.30), (200, 0.50), (280, 0.50)])
    # credited player has NO market/ticks -> credited leg abstains
    ps = score_incident(c, game_id="g", credited_last="champagnie", rightful_last="wembanyama", event_iso=EVENT)
    assert ps is not None and ps.support == "rightful_only"
    assert ps.score == pytest.approx(0.20)


def test_suffix_match_does_not_confuse_hart_with_hartenstein():
    c = _conn()
    _add_market(c, sm_id=1, mi_id=1, game="g", participant="isaiah-hartenstein")
    _add_ticks(c, 1, [(-100, 0.5), (-40, 0.5), (200, 0.6), (280, 0.6)])
    # asking for 'hart' must NOT pick up 'hartenstein' -> no ticks -> abstain
    ps = score_incident(c, game_id="g", credited_last="", rightful_last="hart", event_iso=EVENT)
    assert ps is not None and ps.support == "insufficient_support"


def test_evaluate_aggregates_support_and_abstention():
    c = _conn()
    _add_market(c, sm_id=1, mi_id=1, game="g", participant="victor-wembanyama")
    _add_ticks(c, 1, [(-100, 0.30), (-40, 0.30), (200, 0.50), (280, 0.50)])
    incidents = [
        {"id": "a", "game_id": "g", "credited_last": "", "rightful_last": "wembanyama", "event_iso": EVENT},
        {"id": "b", "game_id": "g", "credited_last": "champagnie", "rightful_last": "merrill", "event_iso": EVENT},  # both illiquid
    ]
    rep = evaluate(c, incidents)
    assert rep["n"] == 2
    assert rep["support_counts"].get("rightful_only") == 1
    assert rep["support_counts"].get("insufficient_support") == 1
    assert rep["abstention_rate"] == pytest.approx(0.5)
