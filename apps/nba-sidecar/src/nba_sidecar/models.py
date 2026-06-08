from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class Participant(BaseModel):
    key: str
    name: str
    shortName: str
    abbreviation: str | None = None
    side: Literal["home", "away"] | None = None


class CanonicalGame(BaseModel):
    id: str
    sport: str = "basketball"
    league: str = "NBA"
    sourceGameKeyNba: str | None = None
    homeParticipant: Participant
    awayParticipant: Participant
    scheduledStart: str


class CanonicalGameState(BaseModel):
    capturedAt: str
    status: Literal["scheduled", "in-play", "final", "postponed", "cancelled"]
    period: int | None = None
    clock: str | None = None
    homeScore: int | None = None
    awayScore: int | None = None
    startedAt: str | None = None
    finalAt: str | None = None
    isFinal: bool = False


class GameOutcome(BaseModel):
    capturedAt: str
    finalHomeScore: int
    finalAwayScore: int
    winnerKey: str | None = None


class SidecarGame(BaseModel):
    game: CanonicalGame
    gameState: CanonicalGameState
    outcome: GameOutcome | None = None
    sourcePayloadMeta: dict[str, str | int | None] = Field(default_factory=dict)


class ScoreboardResponse(BaseModel):
    generatedAt: str
    requestedDate: str | None = None
    games: list[SidecarGame]


class BoxScoreResponse(BaseModel):
    generatedAt: str
    game: SidecarGame
    payload: dict


class PlayByPlayAction(BaseModel):
    actionNumber: int | None = None
    actionType: str | None = None
    subType: str | None = None
    personId: int | None = None
    playerName: str | None = None
    clock: str | None = None
    description: str | None = None
    period: int | None = None
    scoreAway: str | None = None
    scoreHome: str | None = None
    teamTricode: str | None = None
    timeActual: str | None = None


class PlayByPlayResponse(BaseModel):
    generatedAt: str
    gameId: str
    actions: list[PlayByPlayAction]


class VolatilityHistoricalPrior(BaseModel):
    mad: float
    median: float
    sampleSize: int


class VolatilityStateSpaceObservation(BaseModel):
    bucketStart: datetime
    bucketEnd: datetime
    intensity: float = Field(ge=0)
    gameElapsedSeconds: float | None = Field(default=None, ge=0)
    activeMarketCount: int | None = Field(default=None, ge=1)
    sourceCount: int | None = Field(default=None, ge=1)
    sourceDominance: float | None = Field(default=None, ge=0, le=1)
    sourceDisagreement: float | None = Field(default=None, ge=0, le=1)

    @field_validator("bucketStart", "bucketEnd")
    @classmethod
    def _bucket_times_must_be_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("bucket timestamps must include timezone information")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def _bucket_end_must_follow_bucket_start(self) -> VolatilityStateSpaceObservation:
        if self.bucketEnd <= self.bucketStart:
            raise ValueError("bucketEnd must be later than bucketStart")
        return self


# Each config field mirrors the inclusive [min, max] bounds enforced by the TS
# BoardStateSpaceConfigSchema (packages/detectors/src/board-mad/state-space-config.ts).
# TypeScript owns the tuning contract, but this sidecar is the runtime that does
# the math and accepts direct POSTs (UI, backtest, bakeoff, and any quant hitting
# the tunable API), so it must reject the same out-of-range values rather than
# silently producing garbage. Keep these bounds in lockstep with the Zod schema.
class VolatilityStateSpaceTriggerConfig(BaseModel):
    enterOffset: float = Field(ge=0, le=5)
    enterKScale: float = Field(ge=0, le=2)
    exitFloor: float = Field(ge=0, le=5)
    exitRatio: float = Field(ge=0, le=1)


class VolatilityStateSpaceBreadthConfig(BaseModel):
    marketCountFloor: int = Field(ge=1, le=100)
    marketCountExponent: float = Field(ge=0, le=1)


class VolatilityStateSpaceObservationModelConfig(BaseModel):
    disagreementWeight: float = Field(ge=0, le=2)


class VolatilityStateSpaceAnchorConfig(BaseModel):
    priorScaleFallback: float = Field(ge=0.001, le=5)
    priorScaleFloor: float = Field(ge=1e-9, le=5)
    anchorScaleFloor: float = Field(ge=1e-9, le=5)
    precisionVarianceFloor: float = Field(ge=1e-12, le=1)


class VolatilityStateSpaceDynamicsConfig(BaseModel):
    minMemoryBuckets: int = Field(ge=1, le=20)
    trendDecayNumerator: float = Field(ge=0.01, le=10)
    levelProcessNoiseBase: float = Field(ge=0, le=1)
    levelProcessNoiseScale: float = Field(ge=0, le=10)
    trendProcessNoiseRatio: float = Field(ge=0, le=5)
    initialLevelVariance: float = Field(ge=1e-9, le=100)
    initialTrendVariance: float = Field(ge=1e-9, le=100)


class VolatilityStateSpaceSourceTrustConfig(BaseModel):
    # Source trust modulates the surprise scale: a bucket dominated by one book
    # is trusted less (scale inflated -> harder to fire), buckets where many
    # independent sources move together are trusted more (scale deflated ->
    # easier to fire). minMultiplier/maxMultiplier clamp the trust factor.
    minMultiplier: float = Field(ge=0.05, le=1)
    maxMultiplier: float = Field(ge=1, le=10)
    singleSourceDominance: float = Field(ge=0, le=1)
    multiSourceDominanceFallback: float = Field(ge=0, le=1)
    sourceDominancePenalty: float = Field(ge=0, le=10)
    sourceAgreementBonus: float = Field(ge=0, le=10)
    sourceCountBonus: float = Field(ge=0, le=5)
    sourceCountExponent: float = Field(ge=0, le=2)


class VolatilityStateSpaceScaleConfig(BaseModel):
    # The surprise scale is a robust trailing dispersion of the innovations:
    # scale = madScale * MAD(recent innovations), clamped to [scaleFloor,
    # scaleCeiling]. It is the denominator of the standardized innovation, so a
    # fire means "this bucket is enter_z robust-SDs above the game's own
    # recent baseline volatility". baselineSpreadFloor floors the displayed
    # intensity-space spread.
    madScale: float = Field(ge=0.001, le=10)
    scaleFloor: float = Field(ge=1e-6, le=5)
    scaleCeiling: float = Field(ge=1e-3, le=100)
    baselineSpreadFloor: float = Field(ge=1e-12, le=1)

    @model_validator(mode="after")
    def _floor_not_above_ceiling(self) -> "VolatilityStateSpaceScaleConfig":
        # _clamp(base_scale, scaleFloor, scaleCeiling) in volatility.py returns
        # the ceiling when floor > ceiling, silently violating the requested
        # floor and making surprises easier to fire than asked. Reject the
        # inverted ordering here so the runtime never sees it (mirrors the TS
        # Zod refine on BoardStateSpaceConfigSchema).
        if self.scaleFloor > self.scaleCeiling:
            raise ValueError("scaleFloor must be less than or equal to scaleCeiling")
        return self


class VolatilityStateSpaceConfig(BaseModel):
    trigger: VolatilityStateSpaceTriggerConfig
    breadth: VolatilityStateSpaceBreadthConfig
    observationModel: VolatilityStateSpaceObservationModelConfig
    anchors: VolatilityStateSpaceAnchorConfig
    dynamics: VolatilityStateSpaceDynamicsConfig
    sourceTrust: VolatilityStateSpaceSourceTrustConfig
    scale: VolatilityStateSpaceScaleConfig


class VolatilityStateSpaceParams(BaseModel):
    baselineMode: Literal["trailing", "opening-ramp", "historical-blend"]
    bucketSeconds: int
    kMad: float
    trailingBuckets: int
    trailingGameMinutes: float | None = None
    warmupBuckets: int
    openingBaselineBuckets: int | None = None
    openingRampCompleteBuckets: int | None = None
    historicalPrior: VolatilityHistoricalPrior | None = None
    historicalPriorWeight: float | None = None
    historicalRampCompleteGameMinutes: float | None = None
    recentWallMinutes: float | None = None
    recentWallWeight: float | None = None
    stateSpace: VolatilityStateSpaceConfig


class VolatilityStateSpaceRequest(BaseModel):
    gameId: str | None = None
    params: VolatilityStateSpaceParams
    observations: list[VolatilityStateSpaceObservation]


class VolatilityStateSpaceResultObservation(BaseModel):
    bucketStart: datetime
    bucketEnd: datetime
    baselineMedian: float
    baselineMad: float
    threshold: float
    standardizedInnovation: float
    regimeScore: float
    warmedUp: bool
    fired: bool

    @field_validator("bucketStart", "bucketEnd")
    @classmethod
    def _result_bucket_times_must_be_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("bucket timestamps must include timezone information")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def _result_bucket_end_must_follow_bucket_start(
        self,
    ) -> VolatilityStateSpaceResultObservation:
        if self.bucketEnd <= self.bucketStart:
            raise ValueError("bucketEnd must be later than bucketStart")
        return self


class VolatilityStateSpaceResponse(BaseModel):
    generatedAt: str
    gameId: str | None = None
    observations: list[VolatilityStateSpaceResultObservation]
