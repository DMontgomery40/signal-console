from __future__ import annotations

from copy import deepcopy

from nba_sidecar.main import post_board_volatility_state_space
from nba_sidecar.models import (
    VolatilityHistoricalPrior,
    VolatilityStateSpaceObservation,
    VolatilityStateSpaceParams,
    VolatilityStateSpaceRequest,
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
        "varianceAdaptationBase": 0.06,
        "varianceAdaptationScale": 0.9,
        "varianceAdaptationOffset": 10,
        "initialLevelVariance": 1,
        "initialTrendVariance": 1,
        "initialVarianceFloor": 0.04,
    },
    "observationNoise": {
        "floor": 0.05,
        "minimum": 1e-4,
        "singleSourceDominance": 1,
        "multiSourceDominanceFallback": 0.5,
        "sourceDominancePenalty": 1.2,
        "sourceAgreementBonus": 0.45,
        "sourceCountBonus": 0.15,
        "sourceCountExponent": 0.5,
    },
    "variance": {
        "madScale": 1.4826,
        "floor": 1e-4,
        "ceiling": 4,
        "decay": 0.98,
        "bumpCap": 9,
        "bumpCenter": 1,
        "innovationPower": 2,
        "agreementBase": 0.8,
        "agreementScale": 0.4,
        "baselineMadFloor": 1e-9,
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
    observations = [
        *[observation(8 + (i % 3), i) for i in range(10)],
        *[observation(90 + (i % 5) * 8, i + 10) for i in range(20)],
    ]
    default_request = VolatilityStateSpaceRequest(
        gameId="nba-synth-trigger-default",
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
    strict_state_space = default_state_space()
    strict_state_space["trigger"]["enterOffset"] = 5.0
    strict_state_space["trigger"]["enterKScale"] = 0.8
    strict_request = VolatilityStateSpaceRequest(
        gameId="nba-synth-trigger-strict",
        params=VolatilityStateSpaceParams(
            baselineMode="trailing",
            bucketSeconds=60,
            kMad=3,
            stateSpace=strict_state_space,
            trailingBuckets=20,
            warmupBuckets=8,
        ),
        observations=observations,
    )

    default_result = score_volatility_state_space(default_request)
    strict_result = score_volatility_state_space(strict_request)

    assert sum(1 for row in default_result.observations if row.fired) == 1
    assert sum(1 for row in strict_result.observations if row.fired) == 0


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
    flatter_state_space["observationNoise"]["sourceCountExponent"] = 0.0
    steeper_state_space = default_state_space()
    steeper_state_space["observationNoise"]["sourceCountExponent"] = 1.0

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


def test_state_space_innovation_power_is_operator_tunable() -> None:
    observations = [
        *[observation(8 + (i % 2), i) for i in range(10)],
        observation(80, 10),
        observation(42, 11),
    ]
    softer_state_space = default_state_space()
    softer_state_space["variance"]["innovationPower"] = 1.0
    sharper_state_space = default_state_space()
    sharper_state_space["variance"]["innovationPower"] = 3.0

    softer_result = score_volatility_state_space(
        VolatilityStateSpaceRequest(
            gameId="nba-synth-innovation-soft",
            params=VolatilityStateSpaceParams(
                baselineMode="trailing",
                bucketSeconds=60,
                kMad=3,
                stateSpace=softer_state_space,
                trailingBuckets=20,
                warmupBuckets=8,
            ),
            observations=observations,
        )
    )
    sharper_result = score_volatility_state_space(
        VolatilityStateSpaceRequest(
            gameId="nba-synth-innovation-sharp",
            params=VolatilityStateSpaceParams(
                baselineMode="trailing",
                bucketSeconds=60,
                kMad=3,
                stateSpace=sharper_state_space,
                trailingBuckets=20,
                warmupBuckets=8,
            ),
            observations=observations,
        )
    )

    assert sharper_result.observations[-1].standardizedInnovation < softer_result.observations[-1].standardizedInnovation


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
