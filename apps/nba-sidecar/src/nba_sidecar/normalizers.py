from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo

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
    return datetime.now(timezone.utc).isoformat()


def _coerce_optional_str(value: Any) -> str | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text or None


def _parse_utc_iso(value: Any, *, field_name: str) -> str:
    text = _coerce_optional_str(value)
    if text is None:
        raise ValueError(f"{field_name} is required.")

    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an ISO-8601 timestamp.") from exc

    if parsed.tzinfo is None:
        # NBA payloads sometimes drop timezone information while still giving a
        # parseable ISO-like timestamp. Treat those as UTC explicitly rather
        # than fabricating "now", which is much more damaging for downstream
        # timing math.
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc).isoformat()


def _captured_at_from_meta(value: Any) -> str:
    return _parse_utc_iso(value, field_name="meta.time")


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


def _participant_from_live(team: dict[str, Any], side: Literal["home", "away"]) -> Participant:
    tricode = _pick(team, "teamTricode", "teamCode", "tricode")
    team_city = _pick(team, "teamCity", "city")
    team_name = _pick(team, "teamName", "nickname", "name")
    return Participant(
        abbreviation=tricode,
        key=(tricode or str(_pick(team, "teamId", default=side))).lower(),
        name=" ".join(part for part in [team_city, team_name] if part).strip()
        or str(_pick(team, "teamName", "nickname", default=side.title())),
        shortName=str(team_name or team_city or side.title()),
        side=side,
    )


def _status_code_from_text(value: Any) -> int | None:
    text = _coerce_optional_str(value)
    if text is None:
        return None
    lowered = text.lower()
    if "final" in lowered:
        return 3
    if lowered.startswith("q") or "halftime" in lowered or lowered.startswith("ot"):
        return 2
    return None


def _resolve_game_status_code(game: dict[str, Any]) -> int | None:
    status_code = _coerce_int(_pick(game, "gameStatus", "gameStatusId"))
    if status_code is not None:
        return status_code
    return _status_code_from_text(_pick(game, "gameStatusText"))


def _normalize_status(
    status_code: int | None,
) -> Literal["scheduled", "in-play", "final", "postponed", "cancelled"]:
    if status_code == 1:
        return "scheduled"
    if status_code == 2:
        return "in-play"
    if status_code == 3:
        return "final"
    return "scheduled"


def _scheduled_start_from_live(game: dict[str, Any]) -> str:
    scheduled = _pick(game, "gameDateTimeUTC", "gameTimeUTC", "gameEt")
    return _parse_utc_iso(scheduled, field_name="scheduled start")


def normalize_live_scoreboard_payload(
    payload: dict[str, Any], requested_date: str | None = None
) -> ScoreboardResponse:
    scoreboard_payload = payload.get("scoreboard", payload)
    games = scoreboard_payload.get("games", [])
    generated_at = _captured_at_from_meta(_pick(payload.get("meta", {}), "time"))
    normalized_games: list[SidecarGame] = []

    for game in games:
        game_status = _resolve_game_status_code(game)
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
            clock=_coerce_optional_str(_pick(game, "gameClock", "clock")),
            finalAt=generated_at if game_status == 3 else None,
            homeScore=home_score,
            isFinal=game_status == 3,
            period=_coerce_int(_pick(game, "period")),
            # Live scoreboard payloads do not expose a trustworthy actual tipoff
            # timestamp here. Keep the scheduled-start anchor until upstream
            # ships a real startedAt field rather than inventing one locally.
            startedAt=canonical_game.scheduledStart if game_status in (2, 3) else None,
            status=_normalize_status(game_status),
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
                    "gameCode": _coerce_optional_str(_pick(game, "gameCode")),
                    "gameStatusText": _coerce_optional_str(_pick(game, "gameStatusText")),
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
        try:
            normalized = normalize_live_scoreboard_payload(
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
            )
        except ValueError:
            continue
        if normalized.games:
            normalized_games.append(normalized.games[0])

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
    game_status = _resolve_game_status_code(game_payload)
    captured_at = _captured_at_from_meta(_pick(payload.get("meta", {}), "time"))
    canonical_game = CanonicalGame(
        id=f"nba-{game_id}",
        awayParticipant=_participant_from_live(away_team, "away"),
        homeParticipant=_participant_from_live(home_team, "home"),
        scheduledStart=_scheduled_start_from_live(game_payload),
        sourceGameKeyNba=game_id,
    )
    game_state = CanonicalGameState(
        awayScore=_coerce_int(_pick(away_team, "score")),
        capturedAt=captured_at,
        clock=_coerce_optional_str(_pick(game_payload, "gameClock", "clock")),
        finalAt=captured_at if game_status == 3 else None,
        homeScore=_coerce_int(_pick(home_team, "score")),
        isFinal=game_status == 3,
        period=_coerce_int(_pick(game_payload, "period")),
        # Boxscore payloads have the same limitation as live scoreboard: we know
        # the scheduled tip, not the true jump-ball timestamp.
        startedAt=canonical_game.scheduledStart if game_status in (2, 3) else None,
        status=_normalize_status(game_status),
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


def is_today(requested_date: str, *, now: datetime | None = None) -> bool:
    return (
        requested_date
        == (now or datetime.now(timezone.utc))
        .astimezone(ZoneInfo("America/New_York"))
        .date()
        .isoformat()
    )
