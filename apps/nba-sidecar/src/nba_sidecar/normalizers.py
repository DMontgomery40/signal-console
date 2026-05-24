from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from .models import (
    BoxScoreResponse,
    CanonicalGame,
    CanonicalGameState,
    GameOutcome,
    Participant,
    PlayByPlayAction,
    PlayByPlayResponse,
    ScoreboardResponse,
    SidecarGame,
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _captured_at_from_meta(value: Any) -> str:
    if not value:
        return _now_iso()

    text = str(value)
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return _now_iso()

    if parsed.tzinfo is None:
        return _now_iso()

    return parsed.astimezone(UTC).isoformat()


def _coerce_int(value: Any) -> int | None:
    if value in (None, ""):
        return None

    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _pick(mapping: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return default


def _participant_from_live(team: dict[str, Any], side: str) -> Participant:
    tricode = _pick(team, "teamTricode", "teamCode", "tricode")
    team_city = _pick(team, "teamCity", "city")
    team_name = _pick(team, "teamName", "nickname", "name")
    return Participant(
        abbreviation=tricode,
        key=(tricode or str(_pick(team, "teamId", default=side))).lower(),
        name=" ".join(part for part in [team_city, team_name] if part).strip()
        or str(_pick(team, "teamName", "nickname", default=side.title())),
        shortName=str(team_name or team_city or side.title()),
        side=side,  # type: ignore[arg-type]
    )


def _normalize_status(status_code: int | None) -> str:
    if status_code == 1:
        return "scheduled"
    if status_code == 2:
        return "in-play"
    if status_code == 3:
        return "final"
    return "scheduled"


def _scheduled_start_from_live(game: dict[str, Any]) -> str:
    scheduled = _pick(game, "gameDateTimeUTC", "gameTimeUTC", "gameEt")
    if scheduled:
        return str(scheduled)

    return _now_iso()


def normalize_live_scoreboard_payload(
    payload: dict[str, Any], requested_date: str | None = None
) -> ScoreboardResponse:
    scoreboard_payload = payload.get("scoreboard", payload)
    games = scoreboard_payload.get("games", [])
    generated_at = _captured_at_from_meta(_pick(payload.get("meta", {}), "time"))
    normalized_games: list[SidecarGame] = []

    for game in games:
        game_status = _coerce_int(_pick(game, "gameStatus", "gameStatusId"))
        home_team = game.get("homeTeam", {})
        away_team = game.get("awayTeam", {})
        home_score = _coerce_int(_pick(home_team, "score"))
        away_score = _coerce_int(_pick(away_team, "score"))

        canonical_game = CanonicalGame(
            id=f"nba-{_pick(game, 'gameId', default='unknown')}",
            awayParticipant=_participant_from_live(away_team, "away"),
            homeParticipant=_participant_from_live(home_team, "home"),
            scheduledStart=_scheduled_start_from_live(game),
            sourceGameKeyNba=str(_pick(game, "gameId")),
        )
        game_state = CanonicalGameState(
            awayScore=away_score,
            capturedAt=generated_at,
            clock=str(_pick(game, "gameClock", "clock")) or None,
            finalAt=generated_at if game_status == 3 else None,
            homeScore=home_score,
            isFinal=game_status == 3,
            period=_coerce_int(_pick(game, "period")),
            startedAt=canonical_game.scheduledStart if game_status in (2, 3) else None,
            status=_normalize_status(game_status),  # type: ignore[arg-type]
        )

        outcome = None
        if game_state.isFinal and home_score is not None and away_score is not None:
            winner_key = (
                canonical_game.homeParticipant.key
                if home_score > away_score
                else canonical_game.awayParticipant.key
                if away_score > home_score
                else None
            )
            outcome = GameOutcome(
                capturedAt=generated_at,
                finalAwayScore=away_score,
                finalHomeScore=home_score,
                winnerKey=winner_key,
            )

        normalized_games.append(
            SidecarGame(
                game=canonical_game,
                gameState=game_state,
                outcome=outcome,
                sourcePayloadMeta={
                    "gameCode": str(_pick(game, "gameCode")),
                    "gameStatusText": str(_pick(game, "gameStatusText")),
                },
            )
        )

    return ScoreboardResponse(
        games=normalized_games,
        generatedAt=generated_at,
        requestedDate=requested_date or scoreboard_payload.get("gameDate"),
    )


def _dataset_rows(payload: dict[str, Any], dataset_name: str) -> list[dict[str, Any]]:
    result_sets = payload.get("resultSets") or payload.get("resultSet") or []
    if isinstance(result_sets, dict):
        result_sets = [result_sets]

    for dataset in result_sets:
        if dataset.get("name") != dataset_name:
            continue

        headers = dataset.get("headers", [])
        rows = dataset.get("rowSet", [])
        return [dict(zip(headers, row, strict=False)) for row in rows]

    return []


def normalize_stats_scoreboard_payload(
    payload: dict[str, Any], requested_date: str
) -> ScoreboardResponse:
    headers = _dataset_rows(payload, "GameHeader")
    line_scores = _dataset_rows(payload, "LineScore")
    generated_at = _now_iso()
    normalized_games: list[SidecarGame] = []
    seen_game_ids: set[str] = set()

    line_scores_by_game: dict[str, list[dict[str, Any]]] = {}
    for row in line_scores:
        line_scores_by_game.setdefault(str(row.get("GAME_ID")), []).append(row)

    for header in headers:
        game_id = str(header.get("GAME_ID"))
        if game_id in seen_game_ids:
            continue

        seen_game_ids.add(game_id)
        rows = line_scores_by_game.get(game_id, [])
        home_row = next(
            (row for row in rows if str(row.get("TEAM_ID")) == str(header.get("HOME_TEAM_ID"))),
            {},
        )
        away_row = next(
            (
                row
                for row in rows
                if str(row.get("TEAM_ID")) == str(header.get("VISITOR_TEAM_ID"))
            ),
            {},
        )
        home_team = {
            "teamTricode": _pick(home_row, "TEAM_ABBREVIATION"),
            "teamCity": _pick(home_row, "TEAM_CITY_NAME"),
            "teamName": _pick(home_row, "TEAM_NAME", "TEAM_NICKNAME"),
            "teamId": _pick(home_row, "TEAM_ID", default=header.get("HOME_TEAM_ID")),
            "score": _pick(home_row, "PTS"),
        }
        away_team = {
            "teamTricode": _pick(away_row, "TEAM_ABBREVIATION"),
            "teamCity": _pick(away_row, "TEAM_CITY_NAME"),
            "teamName": _pick(away_row, "TEAM_NAME", "TEAM_NICKNAME"),
            "teamId": _pick(away_row, "TEAM_ID", default=header.get("VISITOR_TEAM_ID")),
            "score": _pick(away_row, "PTS"),
        }
        normalized_games.append(
            normalize_live_scoreboard_payload(
                {
                    "meta": {"time": generated_at},
                    "scoreboard": {
                        "gameDate": requested_date,
                        "games": [
                            {
                                "awayTeam": away_team,
                                "gameClock": _pick(header, "LIVE_PC_TIME"),
                                "gameId": game_id,
                                "gameStatus": _pick(header, "GAME_STATUS_ID"),
                                "gameStatusText": _pick(header, "GAME_STATUS_TEXT"),
                                "gameTimeUTC": _pick(header, "GAME_DATE_EST"),
                                "homeTeam": home_team,
                                "period": _pick(header, "LIVE_PERIOD"),
                            }
                        ],
                    },
                },
                requested_date=requested_date,
            ).games[0]
        )

    return ScoreboardResponse(
        games=normalized_games,
        generatedAt=generated_at,
        requestedDate=requested_date,
    )


def _schedule_date_matches(game_date: str | None, requested_date: str) -> bool:
    if not game_date:
        return False

    try:
        normalized = datetime.strptime(game_date[:10], "%m/%d/%Y").date().isoformat()
    except ValueError:
        return game_date.startswith(requested_date)

    return normalized == requested_date


def normalize_schedule_league_payload(
    payload: dict[str, Any], requested_date: str
) -> ScoreboardResponse:
    league_schedule = payload.get("leagueSchedule", {})
    game_dates = league_schedule.get("gameDates", [])
    generated_at = _captured_at_from_meta(_pick(payload.get("meta", {}), "time"))
    games: list[dict[str, Any]] = []

    for schedule_date in game_dates:
        if not _schedule_date_matches(schedule_date.get("gameDate"), requested_date):
            continue
        games.extend(schedule_date.get("games", []))

    return normalize_live_scoreboard_payload(
        {
            "meta": {"time": generated_at},
            "scoreboard": {
                "gameDate": requested_date,
                "games": games,
            },
        },
        requested_date=requested_date,
    )


def normalize_live_boxscore_payload(
    game_id: str, payload: dict[str, Any]
) -> BoxScoreResponse:
    game_payload = payload.get("game", payload)
    home_team = game_payload.get("homeTeam", {})
    away_team = game_payload.get("awayTeam", {})
    game_status = _coerce_int(_pick(game_payload, "gameStatus", "gameStatusText"))
    captured_at = _captured_at_from_meta(_pick(payload.get("meta", {}), "time"))
    canonical_game = CanonicalGame(
        id=f"nba-{game_id}",
        awayParticipant=_participant_from_live(away_team, "away"),
        homeParticipant=_participant_from_live(home_team, "home"),
        scheduledStart=_pick(game_payload, "gameEt", "gameTimeUTC", default=_now_iso()),
        sourceGameKeyNba=game_id,
    )
    game_state = CanonicalGameState(
        awayScore=_coerce_int(_pick(away_team, "score")),
        capturedAt=captured_at,
        clock=str(_pick(game_payload, "gameClock", "clock")) or None,
        finalAt=captured_at if game_status == 3 else None,
        homeScore=_coerce_int(_pick(home_team, "score")),
        isFinal=game_status == 3,
        period=_coerce_int(_pick(game_payload, "period")),
        startedAt=canonical_game.scheduledStart if game_status in (2, 3) else None,
        status=_normalize_status(game_status),  # type: ignore[arg-type]
    )
    outcome = None
    if game_state.isFinal and game_state.homeScore is not None and game_state.awayScore is not None:
        winner_key = (
            canonical_game.homeParticipant.key
            if game_state.homeScore > game_state.awayScore
            else canonical_game.awayParticipant.key
            if game_state.awayScore > game_state.homeScore
            else None
        )
        outcome = GameOutcome(
            capturedAt=captured_at,
            finalAwayScore=game_state.awayScore,
            finalHomeScore=game_state.homeScore,
            winnerKey=winner_key,
        )

    return BoxScoreResponse(
        game=SidecarGame(game=canonical_game, gameState=game_state, outcome=outcome),
        generatedAt=captured_at,
        payload=payload,
    )


def normalize_live_playbyplay_payload(
    game_id: str, payload: dict[str, Any]
) -> PlayByPlayResponse:
    game_payload = payload.get("game", payload)
    actions = game_payload.get("actions", [])
    generated_at = _captured_at_from_meta(_pick(payload.get("meta", {}), "time"))
    normalized_actions = [
        PlayByPlayAction(
            actionNumber=_coerce_int(action.get("actionNumber")),
            actionType=action.get("actionType"),
            clock=action.get("clock"),
            description=action.get("description"),
            period=_coerce_int(action.get("period")),
            scoreAway=str(action.get("scoreAway")) if action.get("scoreAway") else None,
            scoreHome=str(action.get("scoreHome")) if action.get("scoreHome") else None,
            teamTricode=action.get("teamTricode"),
            timeActual=action.get("timeActual"),
        )
        for action in actions
    ]

    return PlayByPlayResponse(
        actions=normalized_actions,
        gameId=game_id,
        generatedAt=generated_at,
    )


def is_today(requested_date: str) -> bool:
    return requested_date == date.today().isoformat()
