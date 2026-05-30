from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from statistics import pstdev

import pytest
from pydantic import ValidationError

from nba_sidecar.main import post_board_volatility_state_space
from nba_sidecar.models import (
    VolatilityHistoricalPrior,
    VolatilityStateSpaceObservation,
    VolatilityStateSpaceConfig,
    VolatilityStateSpaceParams,
    VolatilityStateSpaceRequest,
    VolatilityStateSpaceScaleConfig,
)
from nba_sidecar.volatility import score_volatility_state_space


DEFAULT_STATE_SPACE = {
    "trigger": {
        "enterOffset": 0.9,
        "enterKScale": 0.45,
        "exitFloor": 0.75,
        "exitRatio": 0.7,
    },
    "breadth": {"marketCountFloor": 1, "marketCountExponent": 0.5},
    "observationModel": {"disagreementWeight": 0.35},
    "anchors": {
        "priorScaleFallback": 0.2,
        "priorScaleFloor": 0.05,
        "anchorScaleFloor": 0.05,
        "precisionVarianceFloor": 1e-6,
    },
    "dynamics": {
        "minMemoryBuckets": 2,
        "trendDecayNumerator": 1,
        "levelProcessNoiseBase": 0.015,
        "levelProcessNoiseScale": 0.18,
        "trendProcessNoiseRatio": 0.2,
        "initialLevelVariance": 1,
        "initialTrendVariance": 1,
    },
    "sourceTrust": {
        "minMultiplier": 0.5,
        "maxMultiplier": 2,
        "singleSourceDominance": 1,
        "multiSourceDominanceFallback": 0.5,
        "sourceDominancePenalty": 1.2,
        "sourceAgreementBonus": 0.45,
        "sourceCountBonus": 0.15,
        "sourceCountExponent": 0.5,
    },
    "scale": {
        "madScale": 1.4826,
        "scaleFloor": 0.05,
        "scaleCeiling": 4,
        "baselineSpreadFloor": 1e-9,
    },
}


def default_state_space() -> dict:
    return deepcopy(DEFAULT_STATE_SPACE)


def observation(intensity: float, minute: int) -> VolatilityStateSpaceObservation:
    return VolatilityStateSpaceObservation(
        bucketStart=f"2026-05-25T00:{minute:02d}:00.000Z",
        bucketEnd=f"2026-05-25T00:{minute + 1:02d}:00.000Z",
        intensity=intensity,
        gameElapsedSeconds=minute * 60,
        activeMarketCount=25,
        sourceCount=3,
        sourceDisagreement=0.0,
        sourceDominance=0.2,
    )


def test_state_space_scores_regime_entry_without_paging_every_bucket() -> None:
    request = VolatilityStateSpaceRequest(
        gameId="nba-synth-1",
        params=VolatilityStateSpaceParams(
            baselineMode="trailing",
            bucketSeconds=60,
            kMad=3,
            stateSpace=default_state_space(),
            trailingBuckets=20,
            warmupBuckets=8,
        ),
        observations=[
            *[observation(8 + (i % 3), i) for i in range(10)],
            *[observation(90 + (i % 5) * 8, i + 10) for i in range(20)],
        ],
    )

    result = score_volatility_state_space(request)

    assert sum(1 for row in result.observations if row.fired) == 1


def test_state_space_trigger_config_is_operator_tunable() -> None:
    # Calm baseline, then several separated spikes of increasing magnitude with
    # quiet buckets between them so hysteresis resets and each spike can fire on
    # its own. Raising the entry gate must fire strictly fewer of them — the
    # honest, scale-aware definition of "trigger is operator-tunable".
    observations = [observation(8 + (i % 3), i) for i in range(10)]
    minute = 10
    for spike in (16, 22, 30, 45):
        observations.append(observation(spike, minute))
        observations.append(observation(9, minute + 1))
        observations.append(observation(8, minute + 2))
        minute += 3

    def fire_count(enter_offset: float, enter_kscale: float) -> int:
        ss = default_state_space()
        ss["trigger"]["enterOffset"] = enter_offset
        ss["trigger"]["enterKScale"] = enter_kscale
        result = score_volatility_state_space(
            VolatilityStateSpaceRequest(
                gameId="nba-synth-trigger",
                params=VolatilityStateSpaceParams(
                    baselineMode="trailing",
                    bucketSeconds=60,
                    kMad=3,
                    stateSpace=ss,
                    trailingBuckets=20,
                    warmupBuckets=8,
                ),
                observations=observations,
            )
        )
        return sum(1 for row in result.observations if row.fired)

    loose = fire_count(0.3, 0.2)
    default = fire_count(0.9, 0.45)
    strict = fire_count(3.0, 0.8)

    # Tunability: a looser gate fires at least as often as default, a stricter
    # gate fires strictly fewer than loose, and the gate genuinely bites.
    assert loose >= default >= strict
    assert strict < loose
    assert default >= 1


def test_state_space_keeps_historical_prior_early_then_fades() -> None:
    request = VolatilityStateSpaceRequest(
        gameId="nba-synth-2",
        params=VolatilityStateSpaceParams(
            baselineMode="historical-blend",
            bucketSeconds=60,
            kMad=3,
            trailingBuckets=20,
            warmupBuckets=2,
            historicalPrior=VolatilityHistoricalPrior(mad=4, median=40, sampleSize=25),
            historicalPriorWeight=1,
            historicalRampCompleteGameMinutes=12,
            stateSpace=default_state_space(),
        ),
        observations=[observation(12 + i, i) for i in range(12)],
    )

    result = score_volatility_state_space(request)

    assert result.observations[1].baselineMedian > 20
    assert result.observations[-1].baselineMedian < result.observations[1].baselineMedian


def test_state_space_uses_opening_anchor_controls_in_opening_ramp_mode() -> None:
    request = VolatilityStateSpaceRequest(
        gameId="nba-synth-opening",
        params=VolatilityStateSpaceParams(
            baselineMode="opening-ramp",
            bucketSeconds=60,
            kMad=3,
            trailingBuckets=20,
            warmupBuckets=2,
            openingBaselineBuckets=4,
            openingRampCompleteBuckets=10,
            stateSpace=default_state_space(),
        ),
        observations=[
            observation(6, 0),
            observation(7, 1),
            observation(8, 2),
            observation(9, 3),
            observation(24, 4),
            observation(26, 5),
            observation(28, 6),
            observation(30, 7),
            observation(32, 8),
            observation(34, 9),
            observation(36, 10),
        ],
    )

    result = score_volatility_state_space(request)

    assert result.observations[4].baselineMedian < result.observations[-1].baselineMedian


def test_state_space_uses_game_and_wall_memory_in_historical_blend_mode() -> None:
    request = VolatilityStateSpaceRequest(
        gameId="nba-synth-hist-live",
        params=VolatilityStateSpaceParams(
            baselineMode="historical-blend",
            bucketSeconds=60,
            kMad=3,
            trailingBuckets=20,
            trailingGameMinutes=6,
            recentWallMinutes=2,
            recentWallWeight=2,
            warmupBuckets=2,
            stateSpace=default_state_space(),
        ),
        observations=[
            observation(8, 0),
            observation(9, 1),
            observation(10, 2),
            observation(11, 3),
            observation(12, 4),
            observation(30, 5),
            observation(32, 6),
            observation(34, 7),
        ],
    )

    result = score_volatility_state_space(request)

    assert result.observations[5].baselineMedian > result.observations[2].baselineMedian


def test_state_space_source_count_exponent_is_operator_tunable() -> None:
    observations = [
        *[observation(8 + (i % 2), i) for i in range(10)],
        VolatilityStateSpaceObservation(
            bucketStart="2026-05-25T00:10:00.000Z",
            bucketEnd="2026-05-25T00:11:00.000Z",
            intensity=50,
            gameElapsedSeconds=10 * 60,
            activeMarketCount=25,
            sourceCount=9,
            sourceDominance=0.2,
        ),
    ]
    flatter_state_space = default_state_space()
    flatter_state_space["sourceTrust"]["sourceCountExponent"] = 0.0
    steeper_state_space = default_state_space()
    steeper_state_space["sourceTrust"]["sourceCountExponent"] = 1.0

    flatter_result = score_volatility_state_space(
        VolatilityStateSpaceRequest(
            gameId="nba-synth-source-count-flat",
            params=VolatilityStateSpaceParams(
                baselineMode="trailing",
                bucketSeconds=60,
                kMad=3,
                stateSpace=flatter_state_space,
                trailingBuckets=20,
                warmupBuckets=8,
            ),
            observations=observations,
        )
    )
    steeper_result = score_volatility_state_space(
        VolatilityStateSpaceRequest(
            gameId="nba-synth-source-count-steep",
            params=VolatilityStateSpaceParams(
                baselineMode="trailing",
                bucketSeconds=60,
                kMad=3,
                stateSpace=steeper_state_space,
                trailingBuckets=20,
                warmupBuckets=8,
            ),
            observations=observations,
        )
    )

    assert (
        steeper_result.observations[-1].standardizedInnovation
        > flatter_result.observations[-1].standardizedInnovation
    )


def test_state_space_source_trust_makes_single_book_moves_harder_to_fire() -> None:
    # Identical board move, but one book dominating vs several independent
    # sources moving together. Source trust must make the single-book move LESS
    # surprising (harder to fire) than the multi-source-confirmed move, so a
    # single glitchy book cannot trigger a suspension call on its own.
    base = [observation(8 + (i % 2), i) for i in range(10)]
    single_book = VolatilityStateSpaceObservation(
        bucketStart="2026-05-25T00:10:00.000Z",
        bucketEnd="2026-05-25T00:11:00.000Z",
        intensity=40,
        gameElapsedSeconds=10 * 60,
        activeMarketCount=25,
        sourceCount=1,
        sourceDominance=0.98,
        sourceDisagreement=0.0,
    )
    multi_source = VolatilityStateSpaceObservation(
        bucketStart="2026-05-25T00:10:00.000Z",
        bucketEnd="2026-05-25T00:11:00.000Z",
        intensity=40,
        gameElapsedSeconds=10 * 60,
        activeMarketCount=25,
        sourceCount=5,
        sourceDominance=0.25,
        sourceDisagreement=0.0,
    )

    def last_z(final: VolatilityStateSpaceObservation) -> float:
        result = score_volatility_state_space(
            VolatilityStateSpaceRequest(
                gameId="nba-synth-source-trust",
                params=VolatilityStateSpaceParams(
                    baselineMode="trailing",
                    bucketSeconds=60,
                    kMad=3,
                    stateSpace=default_state_space(),
                    trailingBuckets=20,
                    warmupBuckets=8,
                ),
                observations=[*base, final],
            )
        )
        return result.observations[-1].standardizedInnovation

    single_z = last_z(single_book)
    multi_z = last_z(multi_source)

    # Same raw move, but the multi-source-confirmed bucket is more surprising
    # (trusted) than the single-book bucket (distrusted).
    assert multi_z > single_z


def test_state_space_disagreement_weight_is_operator_tunable() -> None:
    observations = [
        *[observation(8 + (i % 2), i) for i in range(10)],
        VolatilityStateSpaceObservation(
            bucketStart="2026-05-25T00:10:00.000Z",
            bucketEnd="2026-05-25T00:11:00.000Z",
            intensity=12,
            gameElapsedSeconds=10 * 60,
            activeMarketCount=25,
            sourceCount=2,
            sourceDominance=0.5,
            sourceDisagreement=1.0,
        ),
    ]
    quiet_state_space = default_state_space()
    quiet_state_space["observationModel"]["disagreementWeight"] = 0.0
    loud_state_space = default_state_space()
    loud_state_space["observationModel"]["disagreementWeight"] = 0.8

    quiet_result = score_volatility_state_space(
        VolatilityStateSpaceRequest(
            gameId="nba-synth-disagreement-quiet",
            params=VolatilityStateSpaceParams(
                baselineMode="trailing",
                bucketSeconds=60,
                kMad=3,
                stateSpace=quiet_state_space,
                trailingBuckets=20,
                warmupBuckets=8,
            ),
            observations=observations,
        )
    )
    loud_result = score_volatility_state_space(
        VolatilityStateSpaceRequest(
            gameId="nba-synth-disagreement-loud",
            params=VolatilityStateSpaceParams(
                baselineMode="trailing",
                bucketSeconds=60,
                kMad=3,
                stateSpace=loud_state_space,
                trailingBuckets=20,
                warmupBuckets=8,
            ),
            observations=observations,
        )
    )

    assert (
        loud_result.observations[-1].standardizedInnovation
        > quiet_result.observations[-1].standardizedInnovation
    )
    assert loud_result.observations[-1].threshold < quiet_result.observations[-1].threshold


def test_state_space_threshold_stays_on_the_same_raw_intensity_axis_as_fires() -> None:
    state_space = default_state_space()
    state_space["observationModel"]["disagreementWeight"] = 0.8
    observations = [
        *[observation(8 + (i % 2), i) for i in range(10)],
        VolatilityStateSpaceObservation(
            bucketStart="2026-05-25T00:10:00.000Z",
            bucketEnd="2026-05-25T00:11:00.000Z",
            intensity=12,
            gameElapsedSeconds=10 * 60,
            activeMarketCount=25,
            sourceCount=2,
            sourceDominance=0.5,
            sourceDisagreement=1.0,
        ),
    ]
    result = score_volatility_state_space(
        VolatilityStateSpaceRequest(
            gameId="nba-synth-chart-threshold",
            params=VolatilityStateSpaceParams(
                baselineMode="trailing",
                bucketSeconds=60,
                kMad=3,
                stateSpace=state_space,
                trailingBuckets=20,
                warmupBuckets=8,
            ),
            observations=observations,
        )
    )

    fired_rows = [
        (input_observation, scored_observation)
        for input_observation, scored_observation in zip(
            observations, result.observations, strict=True
        )
        if scored_observation.fired
    ]
    assert fired_rows, "expected at least one fired bucket in the synthetic scenario"
    for input_observation, scored_observation in fired_rows:
        assert scored_observation.threshold <= input_observation.intensity + 1e-9


def test_state_space_endpoint_keeps_visible_thresholds_below_fired_intensity() -> None:
    state_space = default_state_space()
    state_space["observationModel"]["disagreementWeight"] = 0.8
    observations = [
        *[observation(8 + (i % 2), i) for i in range(10)],
        VolatilityStateSpaceObservation(
            bucketStart="2026-05-25T00:10:00.000Z",
            bucketEnd="2026-05-25T00:11:00.000Z",
            intensity=12,
            gameElapsedSeconds=10 * 60,
            activeMarketCount=25,
            sourceCount=2,
            sourceDominance=0.5,
            sourceDisagreement=1.0,
        ),
    ]
    payload = post_board_volatility_state_space(
        VolatilityStateSpaceRequest(
            gameId="nba-synth-endpoint-threshold",
            params=VolatilityStateSpaceParams(
                baselineMode="trailing",
                bucketSeconds=60,
                kMad=3,
                stateSpace=state_space,
                trailingBuckets=20,
                warmupBuckets=8,
            ),
            observations=observations,
        )
    )["data"]

    fired_rows = [
        (input_observation, scored_observation)
        for input_observation, scored_observation in zip(
            observations, payload["observations"], strict=True
        )
        if scored_observation["fired"]
    ]
    assert fired_rows, "expected at least one fired bucket in the endpoint payload"
    for input_observation, scored_observation in fired_rows:
        assert scored_observation["threshold"] <= input_observation.intensity + 1e-9


def test_state_space_endpoint_returns_observable_contract() -> None:
    payload = post_board_volatility_state_space(
        VolatilityStateSpaceRequest(
            gameId="nba-synth-3",
            params=VolatilityStateSpaceParams(
                baselineMode="trailing",
                bucketSeconds=60,
                kMad=3,
                stateSpace=default_state_space(),
                trailingBuckets=20,
                warmupBuckets=8,
            ),
            observations=[
                VolatilityStateSpaceObservation(
                    bucketStart="2026-05-25T00:00:00.000Z",
                    bucketEnd="2026-05-25T00:01:00.000Z",
                    intensity=10,
                    gameElapsedSeconds=0,
                ),
                VolatilityStateSpaceObservation(
                    bucketStart="2026-05-25T00:01:00.000Z",
                    bucketEnd="2026-05-25T00:02:00.000Z",
                    intensity=15,
                    gameElapsedSeconds=60,
                ),
            ],
        )
    )["data"]
    assert payload["gameId"] == "nba-synth-3"
    assert len(payload["observations"]) == 2
    assert set(payload["observations"][0].keys()) == {
        "baselineMad",
        "baselineMedian",
        "bucketEnd",
        "bucketStart",
        "fired",
        "regimeScore",
        "standardizedInnovation",
        "threshold",
        "warmedUp",
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("intensity", -1),
        ("sourceDominance", 1.5),
        ("sourceDisagreement", -0.1),
    ],
)
def test_state_space_observation_validation_fails_loud(field: str, value: float) -> None:
    kwargs = {
        "bucketStart": "2026-05-25T00:00:00.000Z",
        "bucketEnd": "2026-05-25T00:01:00.000Z",
        "intensity": 10,
        "gameElapsedSeconds": 0,
        "sourceDominance": 0.5,
        "sourceDisagreement": 0.5,
    }
    kwargs[field] = value

    with pytest.raises(ValidationError):
        VolatilityStateSpaceObservation(**kwargs)


def test_state_space_observation_requires_ordered_timezone_aware_buckets() -> None:
    with pytest.raises(ValidationError):
        VolatilityStateSpaceObservation(
            bucketStart="2026-05-25T00:01:00",
            bucketEnd="2026-05-25T00:00:00Z",
            intensity=10,
        )


def _scale_kwargs(**overrides: float) -> dict[str, float]:
    base = {"madScale": 1.4826, "scaleFloor": 0.05, "scaleCeiling": 4.0, "baselineSpreadFloor": 1e-9}
    base.update(overrides)
    return base


def test_scale_config_accepts_floor_below_or_equal_ceiling() -> None:
    assert VolatilityStateSpaceScaleConfig(**_scale_kwargs()).scaleFloor <= 4.0
    equal = VolatilityStateSpaceScaleConfig(**_scale_kwargs(scaleFloor=1.0, scaleCeiling=1.0))
    assert equal.scaleFloor == equal.scaleCeiling


def test_scale_config_rejects_floor_above_ceiling() -> None:
    # _clamp(base_scale, floor, ceiling) returns the ceiling when floor > ceiling,
    # silently violating the requested floor; the config must reject it up front.
    with pytest.raises(ValidationError):
        VolatilityStateSpaceScaleConfig(**_scale_kwargs(scaleFloor=4.0, scaleCeiling=1.0))


def test_state_space_config_accepts_the_packaged_defaults() -> None:
    # The defaults the UI/backtest/bakeoff send must always satisfy the runtime
    # bounds; if this ever fails, defaults and bounds have drifted apart.
    VolatilityStateSpaceConfig(**default_state_space())


@pytest.mark.parametrize(
    "group,field,value",
    [
        ("trigger", "enterOffset", 6.0),  # max 5
        ("trigger", "enterKScale", 3.0),  # max 2
        ("trigger", "exitRatio", 1.5),  # max 1
        ("breadth", "marketCountFloor", 0),  # min 1
        ("breadth", "marketCountExponent", 2.0),  # max 1
        ("observationModel", "disagreementWeight", 3.0),  # max 2
        ("anchors", "priorScaleFallback", 0.0),  # min 0.001
        ("anchors", "precisionVarianceFloor", 2.0),  # max 1
        ("dynamics", "minMemoryBuckets", 0),  # min 1
        ("dynamics", "levelProcessNoiseBase", -0.1),  # min 0
        ("dynamics", "trendDecayNumerator", 0.0),  # min 0.01
        ("sourceTrust", "minMultiplier", 2.0),  # max 1
        ("sourceTrust", "maxMultiplier", 0.5),  # min 1
        ("sourceTrust", "sourceDominancePenalty", -1.0),  # min 0
        ("sourceTrust", "sourceCountExponent", 5.0),  # max 2
        ("scale", "madScale", 0.0),  # min 0.001
        ("scale", "scaleFloor", -1.0),  # min 1e-6
        ("scale", "scaleCeiling", 1000.0),  # max 100
    ],
)
def test_state_space_config_rejects_out_of_range_values(
    group: str, field: str, value: float
) -> None:
    # The TS Zod schema bounds every knob; the Python runtime that actually does
    # the math is a directly-POSTable tunable API and must reject the same
    # out-of-range values rather than silently producing garbage math.
    cfg = default_state_space()
    cfg[group][field] = value
    with pytest.raises(ValidationError):
        VolatilityStateSpaceConfig(**cfg)


def _deterministic_noise(count: int, seed: int = 1_234_567) -> list[float]:
    # Deterministic LCG so the calibration test is reproducible without importing
    # randomness. Returns values in [-0.5, 0.5] that are close to i.i.d. for the
    # purpose of exercising the robust-MAD surprise scale.
    values: list[float] = []
    state = seed
    for _ in range(count):
        state = (1_103_515_245 * state + 12_345) % (2**31)
        values.append((state / (2**31)) - 0.5)
    return values


@pytest.mark.parametrize("amplitude", [2.0, 8.0])
def test_state_space_standardized_innovation_is_calibrated_to_unit_scale(amplitude: float) -> None:
    # The honesty guarantee of the robust-MAD rewrite: the surprise denominator
    # is a robust trailing dispersion of the innovations, so the standardized
    # innovation should have an order-1 spread on a stationary game REGARDLESS of
    # the raw intensity amplitude (scale invariance). This is the durable
    # replacement for the deleted diag_validate.py headline check, and it guards
    # against the old VIX-style pathology where std(standardized innovation) was
    # ~0.36 and the enter gate was unreachable.
    def calib_observation(intensity: float, index: int) -> VolatilityStateSpaceObservation:
        start = datetime(2026, 5, 25, tzinfo=timezone.utc) + timedelta(minutes=index)
        end = start + timedelta(minutes=1)
        return VolatilityStateSpaceObservation(
            bucketStart=start.isoformat().replace("+00:00", "Z"),
            bucketEnd=end.isoformat().replace("+00:00", "Z"),
            intensity=intensity,
            gameElapsedSeconds=index * 60,
            activeMarketCount=25,
            sourceCount=3,
            sourceDisagreement=0.0,
            sourceDominance=0.2,
        )

    noise = _deterministic_noise(80)
    observations = [calib_observation(10.0 + amplitude * noise[i], i) for i in range(80)]
    request = VolatilityStateSpaceRequest(
        gameId="nba-synth-calibration",
        params=VolatilityStateSpaceParams(
            baselineMode="trailing",
            bucketSeconds=60,
            kMad=3,
            stateSpace=default_state_space(),
            trailingBuckets=20,
            warmupBuckets=8,
        ),
        observations=observations,
    )

    result = score_volatility_state_space(request)
    warmed = [row.standardizedInnovation for row in result.observations if row.warmedUp]

    assert len(warmed) >= 30
    spread = pstdev(warmed)
    # Order-1 spread. The band excludes the old ~0.36 pathology (too small, gate
    # unreachable) and a runaway/over-shrunk scale, and holds across amplitudes.
    assert 0.6 <= spread <= 1.8, f"std(standardized innovation)={spread:.3f} for amplitude={amplitude}"
