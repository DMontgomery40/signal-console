"""Tests for experiments/composite_attribution.py — the external Phase 4 producer.

Hermetic: synthetic board-prediction frames + event/candidate/tick fixtures
(no snapshot). Coverage intent from docs/moniac-pipeline-plan-and-code-draft.md
Phase 4 Step 5: bounded/monotonic composition strategies, honest abstention
support classes, hysteresis enter/sustain/exit, one row per board bucket,
multi-event buckets, and per-game state isolation.

Run with:
    cd apps/nba-sidecar
    uv run --extra research --extra dev python -m pytest tests/test_composite_attribution.py -v
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pandas as pd
import pytest

from nba_sidecar.research.experiments.composite_attribution import (
    CompositeAttributionProducer,
    _compose_gate,
    _compose_max,
    _compose_product,
    _compose_weighted_sum,
    _normalize_paired_score,
    load_attribution_inputs,
    write_composite_predictions,
)

# Event anchor used by the tick fixtures (epoch seconds).
_EVENT_EPOCH = 10_000.0

# AttributionParams windows: pre [-120, -30], post [+180, +300].
_CREDITED_DOWN_TICKS = [(_EVENT_EPOCH - 60, 0.5), (_EVENT_EPOCH + 200, 0.3)]  # drift -0.2
_RIGHTFUL_UP_TICKS = [(_EVENT_EPOCH - 60, 0.4), (_EVENT_EPOCH + 200, 0.7)]  # drift +0.3


def _candidate(credited: int = 1, rightful: int = 2) -> SimpleNamespace:
    # The producer reads only these two attributes of a ReboundCandidate.
    return SimpleNamespace(credited_person_id=credited, candidate_person_id=rightful)


def _event(candidates: list[SimpleNamespace] | None = None) -> dict:
    return {
        "event_epoch": _EVENT_EPOCH,
        "candidates": candidates if candidates is not None else [_candidate()],
    }


def _board_frame(
    game_id: str = "nba-test-001",
    regimes: list[float] | None = None,
    warmed: bool = True,
) -> pd.DataFrame:
    values = regimes if regimes is not None else [0.1] * 5
    return pd.DataFrame(
        {
            "game_id": [game_id] * len(values),
            "bucket_start": [f"2026-01-01T00:{i:02d}:00+00:00" for i in range(len(values))],
            "score": [v * 6.0 for v in values],  # unbounded z stand-in
            "regimeScore": values,
            "zCombined": [v * 6.0 for v in values],
            "warmed": [1.0 if warmed else 0.0] * len(values),
            "intensity": [1.0] * len(values),
        }
    )


# ---------------------------------------------------------------------------
# Pure composition functions
# ---------------------------------------------------------------------------


class TestNormalizePairedScore:
    def test_none_returns_zero(self):
        assert _normalize_paired_score(None) == 0.0

    def test_below_noise_floor_returns_zero(self):
        assert _normalize_paired_score(0.01) == 0.0
        assert _normalize_paired_score(-0.01) == 0.0

    def test_negative_signal_suppressed(self):
        assert _normalize_paired_score(-3.0) == 0.0

    def test_positive_signal_bounded_and_monotonic(self):
        small = _normalize_paired_score(0.1)
        large = _normalize_paired_score(2.0)
        assert 0.0 < small < large <= 1.0


class TestComposeStrategies:
    def test_product_requires_both(self):
        assert _compose_product(0.9, 0.0) == 0.0
        assert _compose_product(0.0, 0.9) == 0.0
        assert _compose_product(0.8, 0.5) == pytest.approx(0.4)

    def test_product_bounded(self):
        assert 0.0 <= _compose_product(1.0, 1.0) <= 1.0

    def test_weighted_sum_clipped_to_unit_interval(self):
        assert _compose_weighted_sum(1.0, 1.0, alpha=0.8, beta=0.8) == 1.0
        assert _compose_weighted_sum(0.0, 0.0) == 0.0

    def test_weighted_sum_monotonic_in_each_arg(self):
        lo = _compose_weighted_sum(0.2, 0.2)
        hi_regime = _compose_weighted_sum(0.6, 0.2)
        hi_paired = _compose_weighted_sum(0.2, 0.6)
        assert lo < hi_regime
        assert lo < hi_paired

    def test_gate_closed_below_threshold(self):
        assert _compose_gate(0.39, 0.9, gate_threshold=0.40) == 0.0

    def test_gate_open_passes_paired_through(self):
        assert _compose_gate(0.41, 0.9, gate_threshold=0.40) == pytest.approx(0.9)

    def test_max_takes_stronger_signal(self):
        assert _compose_max(0.2, 0.7) == pytest.approx(0.7)
        assert _compose_max(0.7, 0.2) == pytest.approx(0.7)


# ---------------------------------------------------------------------------
# Producer construction
# ---------------------------------------------------------------------------


class TestProducerConstruction:
    def test_invalid_strategy_rejected(self):
        with pytest.raises(ValueError, match="strategy must be one of"):
            CompositeAttributionProducer(strategy="psychic")

    @pytest.mark.parametrize("strategy", ["product", "weighted_sum", "gate", "max"])
    def test_valid_strategies_accepted(self, strategy):
        assert CompositeAttributionProducer(strategy=strategy).strategy == strategy


# ---------------------------------------------------------------------------
# build_predictions — external contract
# ---------------------------------------------------------------------------


class TestBuildPredictions:
    def test_one_row_per_board_bucket_with_required_columns(self):
        board = _board_frame(regimes=[0.1, 0.2, 0.3])
        producer = CompositeAttributionProducer(attribution_warmup_buckets=1)
        preds = producer.build_predictions(board, {}, {})
        assert len(preds) == len(board)
        assert {"game_id", "bucket_start", "score", "fired"} <= set(preds.columns)

    def test_empty_event_context_degrades_to_board_only(self):
        board = _board_frame(regimes=[0.9, 0.9])
        producer = CompositeAttributionProducer(attribution_warmup_buckets=1)
        preds = producer.build_predictions(board, {}, {})
        assert (preds["pairedScore"] == 0.0).all()
        assert (preds["pairedSupport"] == "insufficient_support").all()
        # product strategy: no paired signal → composite 0, never fires.
        assert (preds["score"] == 0.0).all()
        assert not preds["fired"].any()

    def test_strong_event_fires_product_strategy(self):
        board = _board_frame(regimes=[0.95, 0.95])
        ticks = {
            ("nba-test-001", "1"): _CREDITED_DOWN_TICKS,
            ("nba-test-001", "2"): _RIGHTFUL_UP_TICKS,
        }
        events = {("nba-test-001", str(board["bucket_start"][1])): [_event()]}
        producer = CompositeAttributionProducer(
            attribution_warmup_buckets=1, fire_threshold=0.4
        )
        preds = producer.build_predictions(board, events, ticks)
        event_row = preds.iloc[1]
        assert event_row["pairedSupport"] == "ok"
        assert event_row["pairedScore"] > 0.0
        assert event_row["fired"]

    def test_support_classes_preserved(self):
        board = _board_frame(regimes=[0.9] * 4)
        bucket_keys = [str(b) for b in board["bucket_start"]]
        # rightful_only: credited leg has no ticks.
        # credited_only: rightful leg has no ticks.
        # insufficient_support: neither leg has ticks.
        ticks = {
            ("nba-test-001", "2"): _RIGHTFUL_UP_TICKS,  # rightful for candidate(1,2)
            ("nba-test-001", "3"): _CREDITED_DOWN_TICKS,  # credited for candidate(3,4)
        }
        events = {
            ("nba-test-001", bucket_keys[1]): [_event([_candidate(1, 2)])],
            ("nba-test-001", bucket_keys[2]): [_event([_candidate(3, 4)])],
            ("nba-test-001", bucket_keys[3]): [_event([_candidate(7, 8)])],
        }
        producer = CompositeAttributionProducer(attribution_warmup_buckets=1)
        preds = producer.build_predictions(board, events, ticks)
        assert preds.iloc[1]["pairedSupport"] == "rightful_only"
        assert preds.iloc[2]["pairedSupport"] == "credited_only"
        assert preds.iloc[3]["pairedSupport"] == "insufficient_support"
        # credited_only here has positive directed score (credited fell): +0.2.
        assert preds.iloc[2]["pairedScore"] > 0.0

    def test_multi_event_bucket_takes_strongest_and_emits_one_row(self):
        board = _board_frame(regimes=[0.9, 0.9])
        bucket_key = ("nba-test-001", str(board["bucket_start"][1]))
        ticks = {
            ("nba-test-001", "1"): _CREDITED_DOWN_TICKS,
            ("nba-test-001", "2"): _RIGHTFUL_UP_TICKS,
            ("nba-test-001", "4"): _RIGHTFUL_UP_TICKS,
        }
        weak_event = _event([_candidate(3, 4)])  # rightful_only (+0.3)
        strong_event = _event([_candidate(1, 2)])  # ok (+0.5)
        producer = CompositeAttributionProducer(attribution_warmup_buckets=1)
        preds = producer.build_predictions(board, {bucket_key: [weak_event, strong_event]}, ticks)
        assert len(preds) == 2  # still one row per board bucket
        row = preds.iloc[1]
        assert row["pairedSupport"] == "ok"
        assert row["pairedScore"] == pytest.approx(_normalize_paired_score(0.5))

    def test_attribution_warmup_gates_layer_two(self):
        board = _board_frame(regimes=[0.9] * 4)
        bucket_keys = [str(b) for b in board["bucket_start"]]
        ticks = {
            ("nba-test-001", "1"): _CREDITED_DOWN_TICKS,
            ("nba-test-001", "2"): _RIGHTFUL_UP_TICKS,
        }
        events = {
            ("nba-test-001", bucket_keys[0]): [_event()],
            ("nba-test-001", bucket_keys[3]): [_event()],
        }
        producer = CompositeAttributionProducer(attribution_warmup_buckets=3)
        preds = producer.build_predictions(board, events, ticks)
        assert preds.iloc[0]["pairedScore"] == 0.0  # before attribution warmup
        assert preds.iloc[3]["pairedScore"] > 0.0  # after

    def test_board_unwarmed_rows_never_fire(self):
        board = _board_frame(regimes=[0.99] * 3, warmed=False)
        ticks = {
            ("nba-test-001", "1"): _CREDITED_DOWN_TICKS,
            ("nba-test-001", "2"): _RIGHTFUL_UP_TICKS,
        }
        events = {("nba-test-001", str(b)): [_event()] for b in board["bucket_start"]}
        producer = CompositeAttributionProducer(
            attribution_warmup_buckets=1, fire_threshold=0.1
        )
        preds = producer.build_predictions(board, events, ticks)
        assert not preds["fired"].any()

    def test_hysteresis_fires_once_then_holds(self):
        board = _board_frame(regimes=[0.95] * 5)
        ticks = {
            ("nba-test-001", "1"): _CREDITED_DOWN_TICKS,
            ("nba-test-001", "2"): _RIGHTFUL_UP_TICKS,
        }
        events = {("nba-test-001", str(b)): [_event()] for b in board["bucket_start"]}
        producer = CompositeAttributionProducer(
            attribution_warmup_buckets=1, fire_threshold=0.3
        )
        preds = producer.build_predictions(board, events, ticks)
        assert int(preds["fired"].sum()) == 1
        assert preds.iloc[0]["fired"]  # the enter bucket
        assert (preds["compositeInAlert"] == 1.0).all()  # sustained alert

    def test_two_game_state_is_isolated(self):
        board_a = _board_frame(game_id="nba-game-A", regimes=[0.95] * 3)
        board_b = _board_frame(game_id="nba-game-B", regimes=[0.95] * 3)
        board = pd.concat([board_a, board_b], ignore_index=True)
        ticks = {
            (gid, pid): t
            for gid in ("nba-game-A", "nba-game-B")
            for pid, t in (("1", _CREDITED_DOWN_TICKS), ("2", _RIGHTFUL_UP_TICKS))
        }
        events = {
            (gid, str(b)): [_event()]
            for gid, frame in (("nba-game-A", board_a), ("nba-game-B", board_b))
            for b in frame["bucket_start"]
        }
        producer = CompositeAttributionProducer(
            attribution_warmup_buckets=1, fire_threshold=0.3
        )
        preds = producer.build_predictions(board, events, ticks)
        # Each game enters its own alert exactly once — hysteresis is per game.
        for gid in ("nba-game-A", "nba-game-B"):
            game_preds = preds[preds["game_id"] == gid]
            assert int(game_preds["fired"].sum()) == 1


# ---------------------------------------------------------------------------
# load_attribution_inputs / write_composite_predictions — REAL snapshot tables
# (fixture snapshot in tmp_path exercising the new exporter tables end-to-end)
# ---------------------------------------------------------------------------

_S0 = 1_700_000_000  # fixture game epoch
_N_BUCKETS = 30  # past both the board-model (20) and attribution (20) warmups
_EVENT_BUCKET = 22
_EVENT_SEC = _S0 + _EVENT_BUCKET * 60 + 30
# Causality: the paired contribution lands in the bucket CONTAINING the
# decision instant event + post_hi (default +300 s), NOT the event bucket —
# the event bucket must never fire on ticks minutes in its own future.
_DECISION_BUCKET = (_EVENT_BUCKET * 60 + 30 + 300) // 60  # = 27


def _snap_iso(sec: float) -> str:
    return datetime.fromtimestamp(sec, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _pbp_rows(game_id: str = "G1") -> list[dict]:
    # Two AAA players act before any substitution -> both inferred on court, so
    # the rebound credited to 101 (Embiid) yields the candidate pair (101 -> 102).
    def act(num: int, atype: str, pid, name, sec: float, sub_type=None) -> dict:
        return {
            "game_id": game_id,
            "action_number": num,
            "action_type": atype,
            "sub_type": sub_type,
            "person_id": pid,
            "team_tricode": "AAA",
            "player_name": name,
            "period": 1,
            "clock": "PT10M00S",
            "time_actual": _snap_iso(sec),
        }

    return [
        act(1, "2pt", 101, "Joel Embiid", _S0 + 60),
        act(2, "2pt", 102, "Kelly Oubre", _S0 + 120),
        act(3, "rebound", 101, "Joel Embiid", _EVENT_SEC, sub_type="defensive"),
    ]


def _tick_rows(game_id: str = "G1") -> list[dict]:
    # Credited (embiid) drifts DOWN -0.2; rightful candidate (oubre) UP +0.3
    # around the event -> raw paired score +0.5 ("ok" support).
    def tick(player_key: str, sec: float, prob: float) -> dict:
        return {
            "game_id": game_id,
            "player_key": player_key,
            "source": "kalshi",
            "line": 7.5,
            "stat": "rebounds",
            "captured_at": _snap_iso(sec),
            "implied_probability": prob,
            "volume": 10.0,
        }

    return [
        tick("joel-embiid", _EVENT_SEC - 60, 0.5),
        tick("joel-embiid", _EVENT_SEC + 200, 0.3),
        tick("kelly-oubre", _EVENT_SEC - 60, 0.4),
        tick("kelly-oubre", _EVENT_SEC + 200, 0.7),
    ]


def _board_pred_frame(game_id: str = "G1", base: int = _S0, n: int = _N_BUCKETS) -> pd.DataFrame:
    rows = []
    for i in range(n):
        s = base + i * 60
        rows.append(
            {
                "game_id": game_id,
                "bucket_start": _snap_iso(s),
                "bucket_end": _snap_iso(s + 60),
                "score": 0.1,
                "fired": False,
                "regimeScore": 0.1,
                "zCombined": 0.6,
                "warmed": 1.0,
                "intensity": 1.0,
            }
        )
    return pd.DataFrame(rows)


def _write_attribution_tables(snap, pbp_rows: list[dict], tick_rows: list[dict]) -> None:
    pd.DataFrame(pbp_rows).to_parquet(snap / "pbp_actions.parquet", index=False)
    pd.DataFrame(tick_rows).to_parquet(snap / "player_prop_ticks.parquet", index=False)


@pytest.fixture()
def attribution_snapshot(tmp_path):
    snap = tmp_path / "snap"
    snap.mkdir()
    _write_attribution_tables(snap, _pbp_rows(), _tick_rows())
    return snap


class TestLoadAttributionInputs:
    def test_builds_bucketed_events_and_person_keyed_ticks(self, attribution_snapshot):
        board = _board_pred_frame()
        events, ticks, status = load_attribution_inputs(attribution_snapshot, board)

        assert status["mode"] == "composite"
        assert status["events_bucketed"] == 1
        assert status["events_outside_buckets"] == 0
        bucket_key = ("G1", str(board["bucket_start"][_DECISION_BUCKET]))
        assert list(events.keys()) == [bucket_key]
        (event,) = events[bucket_key]
        assert event["event_epoch"] == pytest.approx(float(_EVENT_SEC))
        (cand,) = event["candidates"]
        assert (cand.credited_person_id, cand.candidate_person_id) == (101, 102)
        # Ticks keyed by str(person_id) — the join key the producer looks up.
        assert set(ticks.keys()) == {("G1", "101"), ("G1", "102")}
        assert status["players_with_series"] == 2

    def test_missing_tables_degrade_to_board_only(self, tmp_path):
        snap = tmp_path / "empty-snap"
        snap.mkdir()
        events, ticks, status = load_attribution_inputs(snap, _board_pred_frame())
        assert status["mode"] == "board-only"
        assert "reason" in status
        assert events == {} and ticks == {}

    def test_event_outside_board_buckets_is_dropped_and_counted(self, tmp_path):
        snap = tmp_path / "snap"
        snap.mkdir()
        pbp = _pbp_rows()
        pbp[2]["time_actual"] = _snap_iso(_S0 + 99_999)  # far past the last bucket
        _write_attribution_tables(snap, pbp, _tick_rows())
        events, _, status = load_attribution_inputs(snap, _board_pred_frame())
        assert events == {}
        assert status["events_outside_buckets"] == 1
        assert status["events_bucketed"] == 0

    def test_pbp_game_without_board_buckets_is_skipped(self, tmp_path):
        snap = tmp_path / "snap"
        snap.mkdir()
        _write_attribution_tables(snap, _pbp_rows(game_id="G9"), _tick_rows(game_id="G9"))
        events, ticks, status = load_attribution_inputs(snap, _board_pred_frame(game_id="G1"))
        assert events == {} and ticks == {}
        assert status["events_bucketed"] == 0

    def test_suffix_name_binds_own_series_not_other_jr_player(self, tmp_path):
        # PBP names with generational suffixes must join to THEIR OWN slug:
        # pre-fix, last_name('Gary Trent Jr') == 'jr' bound whichever -jr slug
        # matched first (here a decoy teammate), contaminating pairedScore.
        snap = tmp_path / "snap"
        snap.mkdir()
        pbp = _pbp_rows()
        pbp[1]["person_id"] = 103
        pbp[1]["player_name"] = "Gary Trent Jr"
        ticks = [t for t in _tick_rows() if t["player_key"] != "kelly-oubre"]
        for t in _tick_rows():
            if t["player_key"] == "kelly-oubre":
                ticks.append({**t, "player_key": "gary-trent-jr"})
                # decoy -jr teammate with a DIFFERENT probability path
                ticks.append({**t, "player_key": "tim-hardaway-jr", "implied_probability": 0.99})
        _write_attribution_tables(snap, pbp, ticks)
        _, ticks_map, _ = load_attribution_inputs(snap, _board_pred_frame())
        assert ("G1", "103") in ticks_map
        assert [p for _, p in ticks_map[("G1", "103")]] == [0.4, 0.7]  # trent's, not the decoy's

    def test_illiquid_player_yields_no_series_key(self, tmp_path):
        # Drop the credited player's ticks: candidate pair survives, but only the
        # rightful leg has a series -> downstream support is "rightful_only",
        # never a fabricated credited series.
        snap = tmp_path / "snap"
        snap.mkdir()
        ticks = [t for t in _tick_rows() if t["player_key"] != "joel-embiid"]
        _write_attribution_tables(snap, _pbp_rows(), ticks)
        _, ticks_map, _ = load_attribution_inputs(snap, _board_pred_frame())
        assert set(ticks_map.keys()) == {("G1", "102")}

    def test_real_inputs_through_producer_score_the_decision_bucket(self, attribution_snapshot):
        board = _board_pred_frame()
        events, ticks, _ = load_attribution_inputs(attribution_snapshot, board)
        producer = CompositeAttributionProducer()  # default warmups (20 buckets)
        preds = producer.build_predictions(board, events, ticks)
        assert len(preds) == len(board)
        row = preds.iloc[_DECISION_BUCKET]
        assert row["pairedSupport"] == "ok"
        assert row["pairedScore"] == pytest.approx(_normalize_paired_score(0.5))
        # Causality: the EVENT bucket itself must stay 0 — its row may not use
        # quote ticks from minutes in its own future. Same for every other
        # bucket: no decision -> zero contribution.
        others = preds.drop(index=_DECISION_BUCKET)
        assert (others["pairedScore"] == 0.0).all()
        assert preds.iloc[_EVENT_BUCKET]["pairedScore"] == 0.0


class TestWriteCompositePredictionsEndToEnd:
    @pytest.fixture()
    def full_snapshot(self, tmp_path):
        """Fixture snapshot with board observations + truth tables + the two
        attribution tables, mirroring what the current exporter writes."""
        snap = tmp_path / "full-snap"
        snap.mkdir()

        board_rows = []
        for gid, base in (("G1", _S0), ("G2", _S0 + 100_000)):
            for i in range(_N_BUCKETS):
                s = base + i * 60
                board_rows.append(
                    {
                        "game_id": gid,
                        "bucket_start": _snap_iso(s),
                        "bucket_end": _snap_iso(s + 60),
                        "game_elapsed_seconds": float(i * 60),
                        "intensity": 1.0,
                        "active_market_count": 2,
                        "source_count": 2,
                        "source_dominance": 0.5,
                        "source_disagreement": 0.1,
                    }
                )
        pd.DataFrame(board_rows).to_parquet(snap / "board_observations.parquet", index=False)

        pd.DataFrame(
            [
                {
                    "incident_id": "inc1",
                    "canonical_game_id": "G1",
                    "has_local_window": True,
                    "scoreable": True,
                    "confidence": "high",
                    "anchor_type": "second",
                    "utc_time": _snap_iso(_EVENT_SEC),
                    "event_sec": _EVENT_SEC,
                    "stat": "rebound",
                    "credited_player": "Joel Embiid",
                    "rightful_player": "Kelly Oubre",
                    "official_correction": False,
                }
            ]
        ).to_parquet(snap / "incidents.parquet", index=False)
        pd.DataFrame(
            [
                {
                    "incident_id": "inc1",
                    "game_id": "G1",
                    "window_start": _snap_iso(_EVENT_SEC - 60),
                    "window_end": _snap_iso(_EVENT_SEC + 300),
                    "window_start_sec": _EVENT_SEC - 60,
                    "window_end_sec": _EVENT_SEC + 300,
                }
            ]
        ).to_parquet(snap / "score_windows.parquet", index=False)
        pd.DataFrame(
            [
                {
                    "episode_id": "G1:moe:0",
                    "game_id": "G1",
                    "start_sec": _S0 + 300,
                    "end_sec": _S0 + 360,
                    "bucket_seconds": 60,
                    "bucket_count": 1,
                    "peak_severity": 5.0,
                    "peak_price_move_z": 4.0,
                    "diagnosis": "price move outlier",
                }
            ]
        ).to_parquet(snap / "market_outlier_episodes.parquet", index=False)
        pd.DataFrame(
            [
                {
                    "game_id": "G1",
                    "source": "kalshi",
                    "market_family": "player_rebounds",
                    "window": "full-game",
                    "class": "canonical",
                    "market_count": 2,
                    "tick_count": 4,
                    "eligible": True,
                }
            ]
        ).to_parquet(snap / "source_coverage.parquet", index=False)

        # G2 deliberately has NO pbp/tick rows: its composite rows must degrade
        # honestly (pairedScore 0.0) while G1 carries the real signal.
        _write_attribution_tables(snap, _pbp_rows(), _tick_rows())
        return snap

    def test_writes_one_row_per_board_bucket_with_real_attribution(self, full_snapshot, tmp_path, capsys):
        out = tmp_path / "out" / "predictions.parquet"
        written = write_composite_predictions(full_snapshot, out)
        assert written == out
        preds = pd.read_parquet(out)
        assert len(preds) == 2 * _N_BUCKETS  # one row per board bucket, both games

        printed = capsys.readouterr().out
        assert "BOARD-ONLY" not in printed
        assert "1 rebound events bucketed" in printed

        g1 = preds[preds["game_id"] == "G1"].reset_index(drop=True)
        decision_row = g1.iloc[_DECISION_BUCKET]
        assert decision_row["pairedSupport"] == "ok"
        assert decision_row["pairedScore"] == pytest.approx(_normalize_paired_score(0.5))
        # causality: the event's own bucket never uses its future post-window
        assert g1.iloc[_EVENT_BUCKET]["pairedScore"] == 0.0
        # The no-data game stays board-only: absence contributes 0.0, never 0.5.
        g2 = preds[preds["game_id"] == "G2"]
        assert (g2["pairedScore"] == 0.0).all()
        assert (g2["pairedSupport"] == "insufficient_support").all()

    def test_old_snapshot_without_attribution_tables_warns_board_only(self, full_snapshot, tmp_path, capsys):
        (full_snapshot / "pbp_actions.parquet").unlink()
        out = tmp_path / "out" / "predictions.parquet"
        write_composite_predictions(full_snapshot, out)
        printed = capsys.readouterr().out
        assert "BOARD-ONLY" in printed
        preds = pd.read_parquet(out)
        assert (preds["pairedScore"] == 0.0).all()

    def test_scores_through_score_predictions_into_leaderboard(self, full_snapshot, tmp_path):
        from nba_sidecar.research.cli.main import main as cli_main

        out = tmp_path / "out" / "predictions.parquet"
        write_composite_predictions(full_snapshot, out)
        runs_root = tmp_path / "runs"
        rc = cli_main(
            [
                "score-predictions",
                str(out),
                str(full_snapshot),
                "--model-id",
                "composite_attribution",
                "--run-id",
                "t-composite",
                "--runs-root",
                str(runs_root),
            ]
        )
        assert rc == 0
        leaderboard = json.loads((runs_root / "t-composite" / "leaderboard.json").read_text())
        assert [r["model"] for r in leaderboard] == ["composite_attribution"]
