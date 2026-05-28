from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from math import exp, expm1, log, log1p, sqrt

from .models import (
    VolatilityStateSpaceConfig,
    VolatilityHistoricalPrior,
    VolatilityStateSpaceObservation,
    VolatilityStateSpaceRequest,
    VolatilityStateSpaceResponse,
    VolatilityStateSpaceResultObservation,
)


def _clamp(value: float, lower: float, upper: float) -> float:
    return min(upper, max(lower, value))


def _clamp01(value: float) -> float:
    return _clamp(value, 0.0, 1.0)


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _mad(values: list[float], config: VolatilityStateSpaceConfig) -> float:
    if not values:
        return 0.0
    center = _median(values)
    return _median([abs(value - center) for value in values]) * config.variance.madScale


def enter_z_threshold_from_k(k_mad: float, config: VolatilityStateSpaceConfig) -> float:
    return config.trigger.enterOffset + k_mad * config.trigger.enterKScale


def _exit_z_threshold(enter_z: float, config: VolatilityStateSpaceConfig) -> float:
    return max(config.trigger.exitFloor, enter_z * config.trigger.exitRatio)


def _breadth_normalizer(
    observation: VolatilityStateSpaceObservation, config: VolatilityStateSpaceConfig
) -> float:
    return max(
        config.breadth.marketCountFloor,
        observation.activeMarketCount or config.breadth.marketCountFloor,
    ) ** config.breadth.marketCountExponent


def _transformed_score(
    observation: VolatilityStateSpaceObservation, config: VolatilityStateSpaceConfig
) -> float:
    return log1p(observation.intensity / _breadth_normalizer(observation, config))


def _prior_level(prior: VolatilityHistoricalPrior | None) -> float:
    return 0.0 if prior is None else log1p(max(0.0, prior.median))


def _prior_scale_score(
    prior: VolatilityHistoricalPrior | None, config: VolatilityStateSpaceConfig
) -> float:
    if prior is None:
        return config.anchors.priorScaleFallback
    threshold = max(0.0, prior.median) + max(
        config.variance.baselineMadFloor, prior.mad * config.variance.madScale
    )
    return max(
        config.anchors.priorScaleFloor,
        log1p(threshold) - log1p(max(0.0, prior.median)),
    )


@dataclass(slots=True)
class _RobustAnchor:
    level: float
    scale_score: float


def _robust_anchor_from_scores(
    scores: list[float], config: VolatilityStateSpaceConfig
) -> _RobustAnchor | None:
    if not scores:
        return None
    center = _median(scores)
    scale = max(config.anchors.anchorScaleFloor, _mad(scores, config))
    return _RobustAnchor(level=center, scale_score=scale)


def _precision_combine(
    left_level: float,
    left_variance: float,
    right_level: float,
    right_variance: float,
    config: VolatilityStateSpaceConfig,
) -> tuple[float, float]:
    safe_left = max(config.anchors.precisionVarianceFloor, left_variance)
    safe_right = max(config.anchors.precisionVarianceFloor, right_variance)
    left_precision = 1.0 / safe_left
    right_precision = 1.0 / safe_right
    total_precision = left_precision + right_precision
    return (
        (left_level * left_precision + right_level * right_precision) / total_precision,
        1.0 / total_precision,
    )


def _recent_wall_anchor(
    observations: list[VolatilityStateSpaceObservation],
    index: int,
    request: VolatilityStateSpaceRequest,
) -> _RobustAnchor | None:
    recent_minutes = request.params.recentWallMinutes
    if recent_minutes is None or recent_minutes <= 0:
        return None
    recent_bucket_count = max(
        1, round((recent_minutes * 60.0) / max(1, request.params.bucketSeconds))
    )
    start = max(0, index - recent_bucket_count)
    scores = [
        _transformed_score(observation, request.params.stateSpace)
        for observation in observations[start:index]
    ]
    return _robust_anchor_from_scores(scores, request.params.stateSpace)


def _game_clock_anchor(
    observations: list[VolatilityStateSpaceObservation],
    index: int,
    request: VolatilityStateSpaceRequest,
) -> _RobustAnchor | None:
    current = observations[index]
    if current.gameElapsedSeconds is None:
        return None
    horizon_minutes = request.params.trailingGameMinutes
    if horizon_minutes is None or horizon_minutes <= 0:
        return None
    horizon_seconds = horizon_minutes * 60.0
    scores = [
        _transformed_score(observation, request.params.stateSpace)
        for observation in observations[:index]
        if observation.gameElapsedSeconds is not None
        and 0.0 < current.gameElapsedSeconds - observation.gameElapsedSeconds <= horizon_seconds
    ]
    return _robust_anchor_from_scores(scores, request.params.stateSpace)


def _historical_live_anchor(
    observations: list[VolatilityStateSpaceObservation],
    index: int,
    request: VolatilityStateSpaceRequest,
) -> _RobustAnchor | None:
    game_anchor = _game_clock_anchor(observations, index, request)
    wall_anchor = _recent_wall_anchor(observations, index, request)
    if game_anchor is None:
        return wall_anchor
    if wall_anchor is None:
        return game_anchor
    wall_variance = (wall_anchor.scale_score**2) / max(
        request.params.stateSpace.anchors.precisionVarianceFloor,
        request.params.recentWallWeight or 1.0,
    )
    combined_level, combined_variance = _precision_combine(
        game_anchor.level,
        game_anchor.scale_score**2,
        wall_anchor.level,
        wall_variance,
        request.params.stateSpace,
    )
    return _RobustAnchor(
        level=combined_level,
        scale_score=sqrt(
            max(request.params.stateSpace.anchors.precisionVarianceFloor, combined_variance)
        ),
    )


def _opening_anchor(
    observations: list[VolatilityStateSpaceObservation],
    index: int,
    request: VolatilityStateSpaceRequest,
) -> _RobustAnchor | None:
    opening_buckets = max(1, request.params.openingBaselineBuckets or 1)
    limit = min(index, opening_buckets)
    scores = [
        _transformed_score(observation, request.params.stateSpace)
        for observation in observations[:limit]
    ]
    return _robust_anchor_from_scores(scores, request.params.stateSpace)


def _historical_share(
    observation: VolatilityStateSpaceObservation, request: VolatilityStateSpaceRequest
) -> float:
    params = request.params
    if params.baselineMode != "historical-blend" or params.historicalPrior is None:
        return 0.0
    if observation.gameElapsedSeconds is None:
        return _clamp01(params.historicalPriorWeight or 1.0)
    ramp_seconds = max(1.0, (params.historicalRampCompleteGameMinutes or 0.0) * 60.0)
    return _clamp01(
        (params.historicalPriorWeight or 1.0)
        * (1.0 - observation.gameElapsedSeconds / ramp_seconds)
    )


def _opening_share(
    observation: VolatilityStateSpaceObservation, index: int, request: VolatilityStateSpaceRequest
) -> float:
    if request.params.baselineMode != "opening-ramp":
        return 0.0
    opening_seconds = max(1.0, float((request.params.openingBaselineBuckets or 1) * request.params.bucketSeconds))
    ramp_complete_seconds = max(
        opening_seconds,
        float((request.params.openingRampCompleteBuckets or request.params.trailingBuckets) * request.params.bucketSeconds),
    )
    elapsed_seconds = (
        observation.gameElapsedSeconds
        if observation.gameElapsedSeconds is not None
        else float(index * request.params.bucketSeconds)
    )
    if elapsed_seconds <= opening_seconds:
        return 1.0
    if elapsed_seconds >= ramp_complete_seconds:
        return 0.0
    return _clamp01(
        1.0 - (elapsed_seconds - opening_seconds) / max(1.0, ramp_complete_seconds - opening_seconds)
    )


def _warmed_up(
    observation: VolatilityStateSpaceObservation, index: int, request: VolatilityStateSpaceRequest
) -> bool:
    required_seconds = request.params.warmupBuckets * request.params.bucketSeconds
    if observation.gameElapsedSeconds is not None:
        return observation.gameElapsedSeconds >= required_seconds
    return index >= request.params.warmupBuckets


def _measurement_noise(
    observation: VolatilityStateSpaceObservation, config: VolatilityStateSpaceConfig
) -> float:
    source_count = max(1, observation.sourceCount or 1)
    source_dominance = _clamp01(
        observation.sourceDominance
        if observation.sourceDominance is not None
        else (
            config.observationNoise.singleSourceDominance
            if source_count <= 1
            else config.observationNoise.multiSourceDominanceFallback
        )
    )
    source_agreement = 0.0 if source_count <= 1 else 1.0 - source_dominance
    noise = (
        config.observationNoise.floor
        * (1.0 + source_dominance * config.observationNoise.sourceDominancePenalty)
    ) / (
        1.0
        + source_agreement * config.observationNoise.sourceAgreementBonus
        + (source_count**config.observationNoise.sourceCountExponent)
        * config.observationNoise.sourceCountBonus
    )
    return max(config.observationNoise.minimum, noise)


def _apply_anchor_to_state(
    level: float,
    p00: float,
    p01: float,
    p10: float,
    anchor: _RobustAnchor | None,
    config: VolatilityStateSpaceConfig,
    share: float = 1.0,
) -> tuple[float, float, float, float]:
    if anchor is None or share <= 0:
        return level, p00, p01, p10
    state_variance = max(config.anchors.precisionVarianceFloor, p00)
    anchor_variance = max(
        config.anchors.precisionVarianceFloor,
        (anchor.scale_score**2) / max(config.anchors.precisionVarianceFloor, share),
    )
    combined_level, combined_variance = _precision_combine(
        level, state_variance, anchor.level, anchor_variance, config
    )
    shrink = combined_variance / state_variance
    return combined_level, combined_variance, p01 * shrink, p10 * shrink


@dataclass(slots=True)
class _FilterStep:
    baseline_intensity: float
    baseline_score: float
    breadth_normalizer: float
    scale_score: float
    standardized_innovation: float
    warmed_up: bool


def _run_state_filter(request: VolatilityStateSpaceRequest) -> list[_FilterStep]:
    observations = request.observations
    if not observations:
        return []
    config = request.params.stateSpace

    first_score = _transformed_score(observations[0], config)
    prior = request.params.historicalPrior
    level = (
        _prior_level(prior)
        if request.params.baselineMode == "historical-blend" and prior
        else first_score
    )
    trend = 0.0
    p00 = config.dynamics.initialLevelVariance
    p01 = 0.0
    p10 = 0.0
    p11 = config.dynamics.initialTrendVariance
    log_variance = log(
        max(_prior_scale_score(prior, config) ** 2, config.dynamics.initialVarianceFloor)
    )

    memory = max(
        config.dynamics.minMemoryBuckets,
        round(
            (
                request.params.trailingGameMinutes * 60.0 / max(1, request.params.bucketSeconds)
                if request.params.baselineMode == "historical-blend"
                and request.params.trailingGameMinutes is not None
                else request.params.trailingBuckets
            )
        ),
    )
    trend_decay = exp(-config.dynamics.trendDecayNumerator / memory)
    level_process_noise = (
        config.dynamics.levelProcessNoiseBase
        + config.dynamics.levelProcessNoiseScale / memory
    )
    trend_process_noise = level_process_noise * config.dynamics.trendProcessNoiseRatio
    variance_adaptation = (
        config.dynamics.varianceAdaptationBase
        + config.dynamics.varianceAdaptationScale
        / (memory + config.dynamics.varianceAdaptationOffset)
    )

    steps: list[_FilterStep] = []
    for index, observation in enumerate(observations):
        score = _transformed_score(observation, config)
        historical_blend = _historical_share(observation, request)
        prior_score = _prior_level(prior)
        predicted_level = level + trend
        predicted_trend = trend * trend_decay
        predicted_p00 = p00 + p10 + p01 + p11 + level_process_noise
        predicted_p01 = trend_decay * (p01 + p11)
        predicted_p10 = trend_decay * (p10 + p11)
        predicted_p11 = trend_decay * trend_decay * p11 + trend_process_noise

        if request.params.baselineMode == "historical-blend":
            predicted_level, predicted_p00, predicted_p01, predicted_p10 = _apply_anchor_to_state(
                predicted_level,
                predicted_p00,
                predicted_p01,
                predicted_p10,
                _historical_live_anchor(observations, index, request),
                config,
            )

        if historical_blend > 0.0:
            predicted_level, predicted_p00, predicted_p01, predicted_p10 = _apply_anchor_to_state(
                predicted_level,
                predicted_p00,
                predicted_p01,
                predicted_p10,
                _RobustAnchor(level=prior_score, scale_score=_prior_scale_score(prior, config)),
                config,
                historical_blend,
            )

        opening_share = _opening_share(observation, index, request)
        if opening_share > 0.0:
            predicted_level, predicted_p00, predicted_p01, predicted_p10 = _apply_anchor_to_state(
                predicted_level,
                predicted_p00,
                predicted_p01,
                predicted_p10,
                _opening_anchor(observations, index, request),
                config,
                opening_share,
            )

        blended_level = predicted_level
        latent_variance = exp(log_variance)
        observation_noise = _measurement_noise(observation, config)
        innovation_variance = max(
            config.anchors.precisionVarianceFloor,
            predicted_p00 + latent_variance + observation_noise,
        )
        innovation = score - blended_level
        standardized_innovation = innovation / sqrt(innovation_variance)

        gain_level = predicted_p00 / innovation_variance
        gain_trend = predicted_p10 / innovation_variance
        level = blended_level + gain_level * innovation
        trend = predicted_trend + gain_trend * innovation
        p00 = (1.0 - gain_level) * predicted_p00
        p01 = (1.0 - gain_level) * predicted_p01
        p10 = predicted_p10 - gain_trend * predicted_p00
        p11 = predicted_p11 - gain_trend * predicted_p01

        source_count = max(1, observation.sourceCount or 1)
        source_dominance = _clamp01(
            observation.sourceDominance
            if observation.sourceDominance is not None
            else (
                config.observationNoise.singleSourceDominance
                if source_count <= 1
                else config.observationNoise.multiSourceDominanceFallback
            )
        )
        source_agreement = 0.0 if source_count <= 1 else 1.0 - source_dominance
        positive_innovation = max(0.0, standardized_innovation)
        variance_bump = (
            variance_adaptation
            * (
                _clamp(
                    positive_innovation**config.variance.innovationPower,
                    0.0,
                    config.variance.bumpCap,
                )
                - config.variance.bumpCenter
            )
            * (
                config.variance.agreementBase
                + source_agreement * config.variance.agreementScale
            )
        )
        log_variance = _clamp(
            log_variance * config.variance.decay + variance_bump,
            log(config.variance.floor),
            log(config.variance.ceiling),
        )

        current_breadth = _breadth_normalizer(observation, config)
        steps.append(
            _FilterStep(
                baseline_intensity=expm1(blended_level) * current_breadth,
                baseline_score=blended_level,
                breadth_normalizer=current_breadth,
                scale_score=sqrt(innovation_variance),
                standardized_innovation=standardized_innovation,
                warmed_up=_warmed_up(observation, index, request),
            )
        )

    return steps


def score_volatility_state_space(
    request: VolatilityStateSpaceRequest,
) -> VolatilityStateSpaceResponse:
    steps = _run_state_filter(request)
    enter_z = enter_z_threshold_from_k(request.params.kMad, request.params.stateSpace)
    exit_z = _exit_z_threshold(enter_z, request.params.stateSpace)
    in_alert = False
    scored_rows: list[VolatilityStateSpaceResultObservation] = []

    for observation, step in zip(request.observations, steps, strict=True):
        positive_innovation = max(0.0, step.standardized_innovation)
        fired = bool(step.warmed_up and not in_alert and positive_innovation >= enter_z)
        if fired:
            in_alert = True
        if in_alert and positive_innovation <= exit_z:
            in_alert = False
        threshold = (
            expm1(step.baseline_score + enter_z * step.scale_score)
            * step.breadth_normalizer
        )
        baseline_mad = max(
            request.params.stateSpace.variance.baselineMadFloor,
            (threshold - step.baseline_intensity)
            / max(request.params.kMad, request.params.stateSpace.variance.baselineMadFloor),
        )
        scored_rows.append(
            VolatilityStateSpaceResultObservation(
                bucketStart=observation.bucketStart,
                bucketEnd=observation.bucketEnd,
                baselineMedian=step.baseline_intensity,
                baselineMad=baseline_mad,
                threshold=threshold,
                standardizedInnovation=step.standardized_innovation,
                regimeScore=_clamp01(positive_innovation / enter_z),
                warmedUp=step.warmed_up,
                fired=fired,
            )
        )

    return VolatilityStateSpaceResponse(
        generatedAt=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        gameId=request.gameId,
        observations=scored_rows,
    )
