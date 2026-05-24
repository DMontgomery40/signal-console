from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


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

