"""Tests for the virtual_source_state_space BoardModel.

Hermetic: builds synthetic GameBucketSeries directly (no snapshot needed), so
this suite always runs. Coverage intent comes from
docs/moniac-pipeline-plan-and-code-draft.md Phase 1 Step 3, converted to the
current BoardModel contract: build a GameBucketSeries, call
model.score(ScoreRequest(...)), assert over ScoreResult.predictions.

Run with:
    cd apps/nba-sidecar
    uv run --extra research --extra dev python -m pytest tests/test_virtual_source_state_space.py -v
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from nba_sidecar.research.contracts import GameBucketSeries, ModelInputBucket
from nba_sidecar.research.models import get_model, list_models
from nba_sidecar.research.models.base import ScoreRequest
from nba_sidecar.research.models.virtual_source_state_space import (
    _SCALE_FLOOR,
    VirtualSourceStateSpaceModel,
    _bounded_regime_score,
    _FilterState,
    _kalman_predict,
    _kalman_update,
    _precision_weighted_combine,
    _robust_mad_scale,
)

_T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)

# Default kalman args for pure-function tests (mirror default_params).
_KW = dict(
    level_process_noise=1e-4,
    trend_process_noise=1e-6,
    trend_decay=0.95,
    mad_window=40,
)


def _bucket(
    index: int,
    intensity: float = 1.0,
    active_market_count: int = 10,
    source_count: int = 2,
    source_dominance: float = 0.7,
    source_disagreement: float = 0.1,
) -> ModelInputBucket:
    start = _T0 + timedelta(minutes=index)
    return ModelInputBucket(
        index=index,
        bucket_start=start,
        bucket_end=start + timedelta(minutes=1),
        intensity=intensity,
        game_elapsed_seconds=float(index * 60),
        active_market_count=active_market_count,
        source_count=source_count,
        source_dominance=source_dominance,
        source_disagreement=source_disagreement,
    )


def _series(intensities: list[float], game_id: str = "nba-test-001", **bucket_kwargs) -> GameBucketSeries:
    return GameBucketSeries(
        game_id=game_id,
        buckets=[_bucket(i, intensity=v, **bucket_kwargs) for i, v in enumerate(intensities)],
    )


def _score(series: GameBucketSeries, params: dict | None = None):
    model = VirtualSourceStateSpaceModel()
    return model.score(ScoreRequest(series=series, params=params or {}))


# ---------------------------------------------------------------------------
# Unit tests — pure functions
# ---------------------------------------------------------------------------


class TestKalmanPredict:
    def test_level_trend_advance(self):
        state = _FilterState(level=5.0, trend=0.5)
        pred_level, _, *_ = _kalman_predict(state, 1e-4, 1e-6, 0.95)
        assert math.isclose(pred_level, 5.5, rel_tol=1e-9)

    def test_trend_decays(self):
        state = _FilterState(level=0.0, trend=1.0)
        _, pred_trend, *_ = _kalman_predict(state, 1e-4, 1e-6, 0.95)
        assert math.isclose(pred_trend, 0.95, rel_tol=1e-9)

    def test_covariance_grows_during_predict(self):
        state = _FilterState(level=0.0, trend=0.0, p00=0.01, p11=0.001)
        _, _, pred_p00, *_ = _kalman_predict(state, 1e-4, 1e-6, 0.95)
        assert pred_p00 > state.p00

    def test_initial_state_predicts_zero(self):
        state = _FilterState()
        pred_level, pred_trend, *_ = _kalman_predict(state, 1e-4, 1e-6, 0.95)
        assert math.isclose(pred_level, 0.0, abs_tol=1e-12)
        assert math.isclose(pred_trend, 0.0, abs_tol=1e-12)


class TestKalmanUpdate:
    def test_update_moves_level_toward_observation(self):
        state = _FilterState(level=0.0, trend=0.0, p00=1.0)
        _kalman_update(state, observation=5.0, obs_noise=1.0, **_KW)
        assert 0.0 < state.level < 5.0  # pulled toward obs but not all the way

    def test_innovation_appended_to_history(self):
        state = _FilterState()
        _kalman_update(state, observation=2.0, obs_noise=1.0, **_KW)
        assert len(state.recent_innovations) == 1

    def test_innovations_window_capped(self):
        state = _FilterState()
        for i in range(60):
            _kalman_update(state, observation=float(i), obs_noise=1.0, **_KW)
        assert len(state.recent_innovations) == _KW["mad_window"]

    def test_initialized_flag_set_after_first_update(self):
        state = _FilterState()
        assert not state.initialized
        _kalman_update(state, observation=1.0, obs_noise=1.0, **_KW)
        assert state.initialized

    def test_covariance_shrinks_after_update(self):
        state = _FilterState(p00=1.0)
        p00_before = state.p00
        _kalman_update(state, observation=0.0, obs_noise=1.0, **_KW)
        assert state.p00 < p00_before

    def test_returns_innovation_and_variance(self):
        state = _FilterState(level=3.0)
        innov, innov_var = _kalman_update(state, observation=5.0, obs_noise=1.0, **_KW)
        # innovation = obs - predicted_level = 5.0 - (3.0 + 0.0) = 2.0
        assert math.isclose(innov, 2.0, rel_tol=1e-6)
        assert innov_var > 0.0


class TestRobustMadScale:
    def test_neutral_when_fewer_than_4_samples(self):
        assert _robust_mad_scale([]) == 1.0
        assert _robust_mad_scale([1.0, 2.0, 3.0]) == 1.0

    def test_constant_innovations_floored(self):
        assert _robust_mad_scale([2.0] * 20) == _SCALE_FLOOR

    def test_known_distribution_in_reasonable_range(self):
        innovations = [-1.5, -1.0, -0.5, -0.2, 0.0, 0.0, 0.2, 0.5, 1.0, 1.5]
        assert 0.5 < _robust_mad_scale(innovations) < 2.0

    def test_scale_floor_enforced(self):
        assert _robust_mad_scale([0.0] * 50) >= _SCALE_FLOOR


class TestPrecisionWeightedCombine:
    def test_single_filter_returns_its_z(self):
        z = _precision_weighted_combine([2.5, 0.0], [0.5, 1.0], [1.0, 0.0])
        assert math.isclose(z, 2.5, rel_tol=1e-9)

    def test_equal_scales_gives_mean(self):
        z = _precision_weighted_combine([1.0, 3.0], [1.0, 1.0], [1.0, 1.0])
        assert math.isclose(z, 2.0, rel_tol=1e-9)

    def test_low_scale_filter_dominates(self):
        # dominant: tight history (scale 0.1), z=1.0; minority: noisy, z=5.0
        z = _precision_weighted_combine([1.0, 5.0], [0.1, 2.0], [1.0, 1.0])
        assert 1.0 < z < 2.0

    def test_zero_total_precision_returns_zero(self):
        assert _precision_weighted_combine([5.0, 5.0], [1.0, 1.0], [0.0, 0.0]) == 0.0

    def test_negative_z_scores_handled(self):
        z = _precision_weighted_combine([-2.0, -2.0], [1.0, 1.0], [1.0, 1.0])
        assert math.isclose(z, -2.0, rel_tol=1e-9)


# ---------------------------------------------------------------------------
# Integration tests — the full model through the BoardModel contract
# ---------------------------------------------------------------------------


class TestBoundedRegimeScore:
    def test_extreme_negative_z_returns_near_zero_without_overflow(self):
        # Below ~enter_z - 709/k the unclamped sigmoid raises OverflowError
        # (math.exp overflow) and aborts the whole model run.
        regime = _bounded_regime_score(-1e9, 6.0)
        assert 0.0 <= regime < 1e-20

    def test_extreme_positive_z_returns_near_one(self):
        # 1.0 - 1e-20 == 1.0 in float64, so assert exact saturation instead.
        assert _bounded_regime_score(1e9, 6.0) == pytest.approx(1.0)
        assert _bounded_regime_score(1e9, 6.0) <= 1.0

    def test_moderate_values_match_unclamped_sigmoid(self):
        for z in (-10.0, 0.0, 6.0, 12.0):
            expected = 1.0 / (1.0 + math.exp(-1.5 * (z - 6.0)))
            assert _bounded_regime_score(z, 6.0) == pytest.approx(expected)

    def test_full_model_survives_quiet_bucket_after_tiny_mad_scale(self):
        # Stable near-identical buckets shrink the MAD scale toward the 1e-6
        # floor; a fully quiet bucket then yields a huge negative z_combined.
        # The model must score it (regime ~0), not crash with OverflowError.
        # 240 constant buckets converge the filter until the MAD scale rides
        # the 1e-6 floor (empirically z_combined ≈ -5600 at the quiet bucket).
        intensities = [1.0] * 240 + [0.0]
        result = _score(_series(intensities))
        assert len(result.predictions) == len(intensities)
        last = result.predictions[-1]
        # The fixture must actually reach the unclamped-overflow regime
        # (exp argument > 709, i.e. z below enter_z - 709/k ≈ -466).
        assert last.diagnostics["zCombined"] < -500.0
        assert last.diagnostics["regimeScore"] == pytest.approx(0.0, abs=1e-12)
        assert not last.fired


class TestVirtualSourceStateSpaceModel:
    def test_registers_beside_incumbents(self):
        ids = list_models()
        assert "robust_mad" in ids
        assert "state_space_current" in ids
        assert "virtual_source_state_space" in ids

    def test_registry_instantiates_it(self):
        model = get_model("virtual_source_state_space")
        assert isinstance(model, VirtualSourceStateSpaceModel)
        assert model.family == "state-space"

    def test_default_params_json_serializable(self):
        import json

        params = VirtualSourceStateSpaceModel().default_params()
        assert json.loads(json.dumps(params)) == params

    def test_one_prediction_row_per_bucket_aligned(self):
        series = _series([1.0] * 30)
        result = _score(series)
        assert result.model_id == "virtual_source_state_space"
        assert result.game_id == series.game_id
        assert len(result.predictions) == len(series.buckets)
        for pred, bucket in zip(result.predictions, series.buckets, strict=True):
            assert pred.bucket_start == bucket.bucket_start
            assert isinstance(pred.score, float)
            assert isinstance(pred.fired, bool)

    def test_no_fire_during_warmup_even_on_spikes(self):
        series = _series([999.0] * 19)
        result = _score(series, params={"warmup_buckets": 20})
        for i, pred in enumerate(result.predictions):
            assert pred.fired is False, f"fired during warmup at bucket {i}"
            assert pred.diagnostics["warmed"] == 0.0

    def test_quiet_game_does_not_fire(self):
        series = _series([1.0] * 60)
        result = _score(series, params={"warmup_buckets": 10, "enter_z": 3.0})
        assert sum(1 for p in result.predictions if p.fired) == 0

    def test_spike_fires_after_warmup(self):
        intensities = [0.5] * 30 + [500.0]
        series = _series(intensities, source_count=3, source_dominance=0.8)
        result = _score(
            series,
            params={"warmup_buckets": 25, "enter_z": 3.0, "level_process_noise": 1e-5},
        )
        spike = result.predictions[-1]
        assert spike.fired is True, (
            f"expected spike to fire; zCombined={spike.diagnostics['zCombined']}"
        )

    def test_hysteresis_no_refire_during_sustained_alert(self):
        intensities = [0.1] * 6 + [1000.0] * 5
        series = _series(intensities)
        result = _score(
            series,
            params={
                "warmup_buckets": 5,
                "enter_z": 2.0,
                "exit_z": 1.0,
                "level_process_noise": 1e-6,
            },
        )
        fire_count = sum(1 for p in result.predictions if p.fired)
        assert fire_count <= 1, f"hysteresis broken: fired {fire_count} times"

    def test_single_source_bucket_uses_only_dominant_filter(self):
        series = _series([1.0] * 5, source_count=1, source_dominance=1.0)
        result = _score(series, params={"warmup_buckets": 1})
        for pred in result.predictions:
            assert pred.diagnostics["zMinority"] == 0.0
            assert pred.diagnostics["sourceCountUsed"] == 1.0

    def test_causal_prefix_stable(self):
        intensities = [float(i % 5) for i in range(40)]
        series = _series(intensities)
        full = _score(series)
        for cut in (10, 20, 39):
            prefix = GameBucketSeries(
                game_id=series.game_id, buckets=series.buckets[: cut + 1]
            )
            prefix_result = _score(prefix)
            assert prefix_result.predictions[cut].fired == full.predictions[cut].fired
            assert prefix_result.predictions[cut].score == pytest.approx(
                full.predictions[cut].score
            )

    def test_regime_diagnostic_bounded_zero_one(self):
        for intensity in (0.0, 0.001, 1.0, 10.0, 1000.0):
            series = _series([intensity] * 30)
            result = _score(series, params={"warmup_buckets": 5})
            for i, pred in enumerate(result.predictions):
                rs = pred.diagnostics["regimeScore"]
                assert 0.0 <= rs <= 1.0, (
                    f"regimeScore={rs} out of bounds at intensity={intensity}, bucket={i}"
                )

    def test_all_zero_intensity_no_nan(self):
        series = _series([0.0] * 30, source_count=1, source_dominance=1.0, source_disagreement=0.0)
        result = _score(series, params={"warmup_buckets": 5})
        for pred in result.predictions:
            assert not math.isnan(pred.score)
            assert not math.isnan(pred.diagnostics["zCombined"])

    def test_score_is_stateless_and_deterministic(self):
        # Pure-function contract: same (series, params) twice on one instance →
        # identical output; interleaving another game must not contaminate.
        model = VirtualSourceStateSpaceModel()
        series_a = _series([1.0] * 25, game_id="nba-game-A")
        series_b = _series([100.0] * 25, game_id="nba-game-B")
        first = model.score(ScoreRequest(series=series_a))
        model.score(ScoreRequest(series=series_b))
        second = model.score(ScoreRequest(series=series_a))
        for p1, p2 in zip(first.predictions, second.predictions, strict=True):
            assert p1.score == pytest.approx(p2.score)
            assert p1.fired == p2.fired

    def test_no_threshold_diagnostic_emitted(self):
        # The trigger lives in z units; emitting `threshold` would fabricate the
        # scorer's intensity-unit residual-coverage join. See module docstring.
        series = _series([1.0] * 10)
        result = _score(series)
        for pred in result.predictions:
            assert "threshold" not in pred.diagnostics


class TestParameterSweepGuardRails:
    """Not correctness tests — guard rails that no parameter combination
    crashes with ZeroDivisionError, NaN, or index errors. Real parameter
    selection happens in the Quant Lab against a snapshot."""

    @pytest.mark.parametrize("level_pn", [1e-6, 1e-4, 1e-2])
    @pytest.mark.parametrize("trend_pn", [1e-7, 1e-5])
    @pytest.mark.parametrize("enter_z", [2.0, 3.0, 4.0])
    def test_no_crash_across_params(self, level_pn, trend_pn, enter_z):
        series = _series([2.0] * 50)
        result = _score(
            series,
            params={
                "level_process_noise": level_pn,
                "trend_process_noise": trend_pn,
                "enter_z": enter_z,
                "warmup_buckets": 10,
            },
        )
        assert len(result.predictions) == 50
        for pred in result.predictions:
            assert not math.isnan(pred.score)
            assert not math.isnan(pred.diagnostics["zCombined"])
