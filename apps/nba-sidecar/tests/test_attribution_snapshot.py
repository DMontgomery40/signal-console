"""Hermetic tests for the snapshot-backed re-ranker (line-selection + stratification).

Writes a tiny player_prop_ticks parquet and drives the scorer through the loader —
no gold DB, no real snapshot.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from nba_sidecar.research.attribution_snapshot import (
    aggregate_leg_drift,
    evaluate_snapshot,
    last_name,
    normalize_player_key,
    resolve_player_key,
    score_incident_snapshot,
    select_player_series,
    series_for_player_key,
)
from nba_sidecar.research.attribution import AttributionParams
from nba_sidecar.research.loader import read_player_prop_ticks

EVENT = "2026-05-21T02:00:43.6Z"
_COLS = ["game_id", "player_key", "source", "line", "stat", "captured_at", "implied_probability", "volume"]


def _iso(off: float) -> str:
    base = datetime.fromisoformat(EVENT.replace("Z", "+00:00")).timestamp()
    return datetime.fromtimestamp(base + off, tz=timezone.utc).isoformat()


def _ticks(game, player, source, line, series):
    return [
        {"game_id": game, "player_key": player, "source": source, "line": line, "stat": "rebounds",
         "captured_at": _iso(o), "implied_probability": p, "volume": 1.0}
        for o, p in series
    ]


def _snap(tmp_path, rows):
    d = tmp_path / "snap"
    d.mkdir()
    pd.DataFrame(rows, columns=_COLS).to_parquet(d / "player_prop_ticks.parquet")
    return str(d)


def test_last_name_handles_initials_full_and_team():
    assert last_name("V. Wembanyama") == "wembanyama"
    assert last_name("Victor Wembanyama") == "wembanyama"
    assert last_name("TEAM offensive rebound") == ""
    assert last_name("") == ""


def test_last_name_prefers_leading_token_over_trailing_prose():
    # Registry credited/rightful are sometimes descriptive phrases — the player
    # name LEADS and prose trails. The leading 'I. Lastname' must win so these
    # incidents are not silently dropped from the eval denominator.
    assert last_name("J. Champagnie live rebound display") == "champagnie"
    assert last_name("K. Towns (suspected; foul/rebound dispute)") == "towns"
    assert last_name("J. Hart rebound/RA leg (suspected)") == "hart"
    # plain names with no leading initial still resolve via the trailing word
    assert last_name("Sam Hauser") == "hauser"
    assert last_name("Stephon Castle") == "castle"


def test_last_name_strips_generational_suffixes():
    # Suffix tokens are NOT last names: pre-fix, 'Gary Trent Jr' -> 'jr'
    # (endswith-matches EVERY -jr slug in the game) and 'Gary Trent Jr.' -> ''
    # (drops out of the denominator entirely).
    assert last_name("Gary Trent Jr") == "trent"
    assert last_name("Gary Trent Jr.") == "trent"
    assert last_name("Jaren Jackson Jr.") == "jackson"
    assert last_name("Wendell Carter III") == "carter"
    assert last_name("G. Trent Jr.") == "trent"
    assert last_name("Tim Hardaway, Jr.") == "hardaway"


def test_normalize_player_key_strips_suffix_segments():
    assert normalize_player_key("gary-trent-jr") == "gary-trent"
    assert normalize_player_key("Jaren-Jackson-Jr") == "jaren-jackson"
    assert normalize_player_key("wendell-carter-iii") == "wendell-carter"
    assert normalize_player_key("victor-wembanyama") == "victor-wembanyama"


def test_suffix_player_matches_own_series_not_other_jr_player(tmp_path):
    # Two -jr slugs in one game: the suffix-name join must bind each player to
    # HIS OWN series, never the other -jr player's (the pre-fix collision).
    rows = _ticks("g", "gary-trent-jr", "kalshi", 4.5, [(-60, 0.40), (200, 0.45)]) + _ticks(
        "g", "tim-hardaway-jr", "kalshi", 5.5, [(-60, 0.70), (200, 0.75), (210, 0.76)]
    )
    snap = _snap(tmp_path, rows)
    df = read_player_prop_ticks(snap)
    trent = select_player_series(df, "g", last_name("Gary Trent Jr."))
    hardaway = select_player_series(df, "g", last_name("Tim Hardaway Jr."))
    assert [p for _, p in trent] == [0.40, 0.45]
    assert [p for _, p in hardaway] == [0.70, 0.75, 0.76]
    # aggregate_drift leg path uses the same normalized-key match
    leg = aggregate_leg_drift(df, "g", last_name("Gary Trent Jr."), _epoch_of(EVENT), AttributionParams())
    assert not leg.abstain and leg.n_ticks == 2


def _epoch_of(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def _two_williams_df(tmp_path):
    # Two same-surname players in ONE game, both with a (kalshi, 5.5) series —
    # the worst case for a last-name suffix join.
    rows = _ticks("g", "jalen-williams", "kalshi", 5.5, [(-60, 0.40), (200, 0.45)]) + _ticks(
        "g", "jaylin-williams", "kalshi", 5.5, [(-60, 0.70), (200, 0.75), (210, 0.76)]
    )
    return read_player_prop_ticks(_snap(tmp_path, rows))


def test_resolve_player_key_unique_surname(tmp_path):
    rows = _ticks("g", "victor-wembanyama", "kalshi", 9.5, [(-60, 0.5)])
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    assert resolve_player_key(df, "Victor Wembanyama") == "victor-wembanyama"
    assert resolve_player_key(df, "V. Wembanyama") == "victor-wembanyama"
    assert resolve_player_key(df, "Nonexistent Player") is None
    assert resolve_player_key(df, "") is None


def test_resolve_player_key_same_surname_disambiguates_by_first_name(tmp_path):
    df = _two_williams_df(tmp_path)
    assert resolve_player_key(df, "Jalen Williams") == "jalen-williams"
    assert resolve_player_key(df, "Jaylin Williams") == "jaylin-williams"
    # A bare surname (or a shared initial) cannot separate them: abstain, never
    # blend or guess.
    assert resolve_player_key(df, "Williams") is None
    assert resolve_player_key(df, "J. Williams") is None


def test_resolve_player_key_surname_is_segment_bounded(tmp_path):
    rows = _ticks("g", "josh-hart", "kalshi", 5.5, [(-60, 0.5)]) + _ticks(
        "g", "delon-lockhart", "kalshi", 4.5, [(-60, 0.6)]
    )
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    # 'lockhart' must not suffix-match 'hart'.
    assert resolve_player_key(df, "Josh Hart") == "josh-hart"


def test_series_for_player_key_is_key_exact(tmp_path):
    df = _two_williams_df(tmp_path)
    series = series_for_player_key(df, "jalen-williams")
    assert [p for _, p in series] == [0.40, 0.45]


def test_select_player_series_never_blends_same_surname_players(tmp_path):
    # Without a full name the suffix path keeps working, but the (player_key,
    # source, line) grouping guarantees the returned series belongs to ONE
    # player (most active), never a blend of both.
    df = _two_williams_df(tmp_path)
    series = select_player_series(df, "g", "williams")
    assert [p for _, p in series] == [0.70, 0.75, 0.76]  # one player's ticks only


def test_select_picks_most_active_line(tmp_path):
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.55), (280, 0.55)])
    rows += _ticks("g", "victor-wembanyama", "bet365", 5.5, [(-100, 0.90), (280, 0.90)])  # fewer ticks
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    ser = select_player_series(df, "g", "wembanyama")
    # the 9.5 series (4 ticks) wins over 5.5 (2 ticks); levels 0.30/0.55, not 0.90
    assert len(ser) == 4
    assert max(p for _, p in ser) == pytest.approx(0.55)


def test_player_swap_scores_positive(tmp_path):
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.55), (280, 0.55)])
    rows += _ticks("g", "julian-champagnie", "bet365", 7.5, [(-100, 0.60), (-40, 0.60), (200, 0.45), (280, 0.45)])
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    ps, stratum = score_incident_snapshot(
        df, game_id="g", credited_player="J. Champagnie", rightful_player="V. Wembanyama", event_iso=EVENT
    )
    assert stratum == "player_swap"
    assert ps is not None and ps.support == "ok"
    assert ps.score == pytest.approx(0.40)  # rightful +0.25 - credited (-0.15)


def test_hart_suffix_does_not_match_hartenstein(tmp_path):
    rows = _ticks("g", "isaiah-hartenstein", "bet365", 9.5, [(-100, 0.5), (-40, 0.5), (200, 0.6), (280, 0.6)])
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    assert select_player_series(df, "g", "hart") == []  # no josh-hart present


def test_evaluate_stratifies_player_swap_vs_team_dispute(tmp_path):
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.50), (280, 0.50)])
    incs = [
        {"id": "a", "game_id": "g", "credited_player": "J. Champagnie", "rightful_player": "V. Wembanyama", "event_iso": EVENT},
        {"id": "b", "game_id": "g", "credited_player": "TEAM offensive rebound", "rightful_player": "V. Wembanyama", "event_iso": EVENT},
    ]
    rep = evaluate_snapshot(_snap(tmp_path, rows), incs)
    assert rep["overall"]["n"] == 2
    assert rep["player_swap"]["n"] == 1
    assert rep["team_dispute"]["n"] == 1
    # 'a': champagnie illiquid -> rightful_only (scored); 'b': team_dispute, rightful only too
    assert rep["player_swap"]["n_scored"] == 1


def test_aggregate_drift_is_level_invariant_across_lines(tmp_path):
    # two lines, DIFFERENT levels, SAME +0.20 drift -> aggregate is +0.20 (the mean of
    # per-line drifts), not a blended-level artifact.
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.50), (280, 0.50)])
    rows += _ticks("g", "victor-wembanyama", "kalshi", 9.5, [(-100, 0.70), (-40, 0.70), (200, 0.90), (280, 0.90)])
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    event = datetime.fromisoformat(EVENT.replace("Z", "+00:00")).timestamp()
    lr = aggregate_leg_drift(df, "g", "wembanyama", event, AttributionParams())
    assert not lr.abstain
    assert lr.drift == pytest.approx(0.20)


def test_aggregate_drift_path_scores_player_swap(tmp_path):
    rows = _ticks("g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.55), (280, 0.55)])
    rows += _ticks("g", "julian-champagnie", "bet365", 7.5, [(-100, 0.60), (-40, 0.60), (200, 0.45), (280, 0.45)])
    df = read_player_prop_ticks(_snap(tmp_path, rows))
    ps, stratum = score_incident_snapshot(
        df, game_id="g", credited_player="J. Champagnie", rightful_player="V. Wembanyama",
        event_iso=EVENT, line_select="aggregate_drift",
    )
    assert stratum == "player_swap"
    assert ps is not None and ps.support == "ok"
    assert ps.score == pytest.approx(0.40)


def test_cli_attribution_eval_emits_portal_artifact(tmp_path):
    import json

    from nba_sidecar.research.cli.main import build_parser

    rows = _ticks("nba-g", "victor-wembanyama", "bet365", 9.5, [(-100, 0.30), (-40, 0.30), (200, 0.55), (280, 0.55)])
    rows += _ticks("nba-g", "julian-champagnie", "bet365", 7.5, [(-100, 0.60), (-40, 0.60), (200, 0.45), (280, 0.45)])
    snap = _snap(tmp_path, rows)
    reg = tmp_path / "registry.json"
    reg.write_text(json.dumps({"incidents": [
        {"id": "x", "gameId": "nba-g", "utcTime": EVENT,
         "creditedPlayer": "J. Champagnie", "rightfulPlayer": "V. Wembanyama"},
    ]}))
    out = tmp_path / "attribution_reranker.json"
    args = build_parser().parse_args(
        ["attribution-eval", snap, "--registry", str(reg), "--out", str(out), "--line-select", "aggregate_drift"]
    )
    assert args.func(args) == 0
    rep = json.loads(out.read_text())
    assert rep["n_incidents"] == 1
    assert rep["overall"]["n"] == 1 and rep["player_swap"]["n"] == 1
    assert rep["line_select"] == "aggregate_drift"
