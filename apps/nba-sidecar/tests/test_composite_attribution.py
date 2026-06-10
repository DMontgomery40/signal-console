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
