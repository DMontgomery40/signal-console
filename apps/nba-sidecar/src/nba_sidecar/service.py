from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from nba_api.live.nba.endpoints import boxscore, playbyplay, scoreboard
from nba_api.stats.endpoints import scoreboardv3

from .models import BoxScoreResponse, PlayByPlayResponse, ScoreboardResponse
from .normalizers import (
    is_today,
    normalize_live_boxscore_payload,
    normalize_live_playbyplay_payload,
    normalize_live_scoreboard_payload,
    normalize_schedule_league_payload,
    normalize_stats_scoreboard_payload,
)

NBA_SCHEDULE_CDN_URL = "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json"
NBA_LIVE_SCOREBOARD_CDN_URL = (
    "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json"
)
NBA_LIVE_PLAY_BY_PLAY_CDN_URL_TEMPLATE = (
    "https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_{game_id}.json"
)
NBA_CDN_HEADERS = {
    "Referer": "https://www.nba.com/",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
}


class NbaSidecarUpstreamError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        cause: str,
        operator_hint: str,
        status_code: int = 502,
    ) -> None:
        super().__init__(message)
        self.cause = cause
        self.operator_hint = operator_hint
        self.status_code = status_code


def _is_past_date(requested_date: str) -> bool:
    try:
        return date.fromisoformat(requested_date) < date.today()
    except ValueError:
        return False


def _looks_like_stale_historical_preview(
    payload: ScoreboardResponse, requested_date: str
) -> bool:
    if not _is_past_date(requested_date):
        return False
    if not payload.games:
        return False
    return all(
        game.gameState.status == "scheduled"
        and not game.gameState.isFinal
        and (game.gameState.homeScore in (None, 0))
        and (game.gameState.awayScore in (None, 0))
        for game in payload.games
    )


@dataclass(slots=True)
class NbaSidecarService:
    def get_scoreboard(self, requested_date: str | None = None) -> ScoreboardResponse:
        if requested_date and not is_today(requested_date):
            try:
                payload = scoreboardv3.ScoreboardV3(
                    game_date=requested_date,
                    league_id="00",
                ).get_dict()
                normalized = normalize_live_scoreboard_payload(
                    payload, requested_date=requested_date
                )
                if _looks_like_stale_historical_preview(normalized, requested_date):
                    return ScoreboardResponse(
                        games=[],
                        generatedAt=normalized.generatedAt,
                        requestedDate=requested_date,
                    )
                if normalized.games or _is_past_date(requested_date):
                    return normalized
            except Exception:
                if _is_past_date(requested_date):
                    return ScoreboardResponse(
                        games=[],
                        generatedAt="",
                        requestedDate=requested_date,
                    )

            return self.get_schedule_scoreboard(requested_date)

        try:
            payload = scoreboard.ScoreBoard().get_dict()
        except Exception:
            payload = self.get_live_scoreboard_payload()
        return normalize_live_scoreboard_payload(payload, requested_date=requested_date)

    def get_live_scoreboard_payload(self) -> dict:
        request = Request(NBA_LIVE_SCOREBOARD_CDN_URL, headers=NBA_CDN_HEADERS)
        with urlopen(request, timeout=30) as response:
            payload = response.read()

        return json.loads(payload)

    def get_schedule_scoreboard(self, requested_date: str) -> ScoreboardResponse:
        request = Request(NBA_SCHEDULE_CDN_URL, headers=NBA_CDN_HEADERS)
        with urlopen(request, timeout=30) as response:
            payload = response.read()

        return normalize_schedule_league_payload(
            json.loads(payload), requested_date=requested_date
        )

    def get_game(self, game_id: str) -> BoxScoreResponse:
        payload = boxscore.BoxScore(game_id=game_id).get_dict()
        return normalize_live_boxscore_payload(game_id=game_id, payload=payload)

    def get_live_play_by_play_payload(self, game_id: str) -> dict:
        request = Request(
            NBA_LIVE_PLAY_BY_PLAY_CDN_URL_TEMPLATE.format(game_id=game_id),
            headers=NBA_CDN_HEADERS,
        )
        try:
            with urlopen(request, timeout=30) as response:
                payload = response.read()
        except HTTPError as exc:
            raise NbaSidecarUpstreamError(
                "NBA CDN play-by-play request was rejected.",
                cause=f"HTTPError:{exc.code}",
                operator_hint=(
                    "NBA PBP unavailable; market tripwire only until NBA CDN or "
                    "nba_api play-by-play access recovers."
                ),
                status_code=502 if exc.code >= 500 else 424,
            ) from exc
        except URLError as exc:
            raise NbaSidecarUpstreamError(
                "NBA CDN play-by-play request failed.",
                cause=type(exc).__name__,
                operator_hint=(
                    "NBA PBP unavailable; market tripwire only until NBA CDN or "
                    "nba_api play-by-play access recovers."
                ),
            ) from exc

        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            raise NbaSidecarUpstreamError(
                "NBA CDN play-by-play returned invalid JSON.",
                cause="JSONDecodeError",
                operator_hint=(
                    "NBA PBP unavailable; market tripwire only until NBA CDN "
                    "returns parseable play-by-play JSON."
                ),
            ) from exc

    def get_play_by_play(self, game_id: str) -> PlayByPlayResponse:
        try:
            payload = playbyplay.PlayByPlay(game_id=game_id).get_dict()
        except NbaSidecarUpstreamError:
            raise
        except Exception:
            payload = self.get_live_play_by_play_payload(game_id)
        return normalize_live_playbyplay_payload(game_id=game_id, payload=payload)
