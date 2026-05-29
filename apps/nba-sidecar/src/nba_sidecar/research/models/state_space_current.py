"""state_space_current: the CURRENT PRODUCTION baseline, run on the snapshot.

This model wraps the live :func:`nba_sidecar.volatility.score_volatility_state_space`
exactly as the service runs it, but feeds it the *snapshot* board observations
instead of the live board lane. The point is a faithful apples-to-apples peer:
when we compare a new candidate against "what production does today", this is
that line on the chart — not an approximation of it.

It is a peer, not the answer. The state-space filter is more sophisticated than
``robust_mad`` (breadth normalization, source-trust measurement noise, regime
variance adaptation, opening-ramp anchoring), but it is still a baseline with its
own failure modes and tuning assumptions. A candidate that beats it has to do so
on the evaluation phase's recall/burden tradeoff, not on vibes.

The default params mirror the clean detector defaults checked into
``packages/detectors/src/board-mad`` (state-space config + the opening-ramp live
profile), so this is the production *default* configuration unless overridden.
"""

from __future__ import annotations

from typing import Any

from ...models import (
    VolatilityStateSpaceObservation,
    VolatilityStateSpaceParams,
    VolatilityStateSpaceRequest,
)
from ...volatility import score_volatility_state_space
from ..contracts import PredictionRow
from .base import BoardModel, ScoreRequest, ScoreResult, register

# Mirrors packages/detectors/src/board-mad/state-space-config.ts
# BOARD_STATE_SPACE_CONFIG_DEFAULTS. Kept as a literal here (not imported from
# TS) and asserted against the live pydantic config shape at score time.
_STATE_SPACE_CONFIG_DEFAULTS: dict[str, Any] = {
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


@register
class StateSpaceCurrentModel(BoardModel):
    id = "state_space_current"
    name = "State-space (current production)"
    summary = (
        "Current production baseline: the live nba_sidecar state-space volatility "
        "filter (Kalman-style level/trend with breadth normalization, source-trust "
        "measurement noise, regime variance adaptation, and opening-ramp anchoring) "
        "run over the snapshot board observations with the clean detector defaults. "
        "A faithful peer to compare candidates against, not the answer."
    )
    family = "state-space"
    references = (
        "apps/nba-sidecar/src/nba_sidecar/volatility.py::score_volatility_state_space",
        "packages/detectors/src/board-mad/state-space-config.ts (config defaults)",
        "packages/detectors/src/board-mad/config.ts (timing/profile defaults)",
    )

    def default_params(self) -> dict[str, Any]:
        # Top-level params mirror the opening-ramp live profile defaults.
        return {
            "baselineMode": "opening-ramp",
            "bucketSeconds": 60,  # BOARD_MAD_BUCKET_SECONDS_DEFAULT
            "kMad": 3.0,  # K_MAD_LIVE
            "trailingBuckets": 20,  # BOARD_MAD_TRAILING_BUCKETS_DEFAULT
            "warmupBuckets": 8,  # BOARD_MAD_WARMUP_BUCKETS_DEFAULT
            "openingBaselineBuckets": 4,  # BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT
            "openingRampCompleteBuckets": 20,  # == trailing default
            "stateSpace": _STATE_SPACE_CONFIG_DEFAULTS,
        }

    def score(self, request: ScoreRequest) -> ScoreResult:
        params = self.resolve_params(request.params)
        series = request.series

        observations = [
            VolatilityStateSpaceObservation(
                bucketStart=b.bucket_start,
                bucketEnd=b.bucket_end,
                intensity=b.intensity,
                gameElapsedSeconds=b.game_elapsed_seconds,
                activeMarketCount=b.active_market_count
                if (b.active_market_count or 0) >= 1
                else None,
                sourceCount=b.source_count if (b.source_count or 0) >= 1 else None,
                sourceDominance=b.source_dominance,
                sourceDisagreement=b.source_disagreement,
            )
            for b in series.buckets
        ]

        ss_params = VolatilityStateSpaceParams.model_validate(params)
        ss_request = VolatilityStateSpaceRequest(
            gameId=series.game_id,
            params=ss_params,
            observations=observations,
        )
        response = score_volatility_state_space(ss_request)

        predictions: list[PredictionRow] = []
        for bucket, row in zip(series.buckets, response.observations, strict=True):
            predictions.append(
                PredictionRow(
                    game_id=series.game_id,
                    bucket_start=bucket.bucket_start,
                    # Standardized innovation is the model's continuous surprise.
                    score=row.standardizedInnovation,
                    fired=bool(row.fired),
                    diagnostics={
                        "baselineMedian": row.baselineMedian,
                        "baselineMad": row.baselineMad,
                        "threshold": row.threshold,
                        "regimeScore": row.regimeScore,
                        "warmed": float(row.warmedUp),
                    },
                )
            )

        return self._validate_result(
            request,
            ScoreResult(
                model_id=self.id,
                game_id=series.game_id,
                predictions=predictions,
            ),
        )


__all__ = ["StateSpaceCurrentModel"]
