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


class VolatilityStateSpaceTriggerConfig(BaseModel):
    enterOffset: float
    enterKScale: float
    exitFloor: float
    exitRatio: float


class VolatilityStateSpaceBreadthConfig(BaseModel):
    marketCountFloor: int
    marketCountExponent: float


class VolatilityStateSpaceObservationModelConfig(BaseModel):
    disagreementWeight: float


class VolatilityStateSpaceAnchorConfig(BaseModel):
    priorScaleFallback: float
    priorScaleFloor: float
    anchorScaleFloor: float
    precisionVarianceFloor: float


class VolatilityStateSpaceDynamicsConfig(BaseModel):
    minMemoryBuckets: int
    trendDecayNumerator: float
    levelProcessNoiseBase: float
    levelProcessNoiseScale: float
    trendProcessNoiseRatio: float
    varianceAdaptationBase: float
    varianceAdaptationScale: float
    varianceAdaptationOffset: float
    initialLevelVariance: float
    initialTrendVariance: float
    initialVarianceFloor: float


class VolatilityStateSpaceObservationNoiseConfig(BaseModel):
    floor: float
    minimum: float
    singleSourceDominance: float
    multiSourceDominanceFallback: float
    sourceDominancePenalty: float
    sourceAgreementBonus: float
    sourceCountBonus: float
    sourceCountExponent: float


class VolatilityStateSpaceVarianceConfig(BaseModel):
    madScale: float
    floor: float
    ceiling: float
    decay: float
    bumpCap: float
    bumpCenter: float
    innovationPower: float
    agreementBase: float
    agreementScale: float
    baselineMadFloor: float


class VolatilityStateSpaceConfig(BaseModel):
    trigger: VolatilityStateSpaceTriggerConfig
    breadth: VolatilityStateSpaceBreadthConfig
    observationModel: VolatilityStateSpaceObservationModelConfig
    anchors: VolatilityStateSpaceAnchorConfig
    dynamics: VolatilityStateSpaceDynamicsConfig
    observationNoise: VolatilityStateSpaceObservationNoiseConfig
    variance: VolatilityStateSpaceVarianceConfig


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
