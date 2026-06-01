from datetime import datetime, timezone
from io import BytesIO
from urllib.error import HTTPError

import pytest
from fastapi import HTTPException

from nba_sidecar.main import get_play_by_play
from nba_sidecar.normalizers import (
    normalize_live_boxscore_payload,
    is_today,
    normalize_live_playbyplay_payload,
    normalize_live_scoreboard_payload,
    normalize_schedule_league_payload,
    normalize_stats_scoreboard_payload,
)
from nba_sidecar.service import NbaSidecarService, NbaSidecarUpstreamError


def test_normalize_live_scoreboard_payload_maps_game_and_state() -> None:
    payload = {
        "meta": {"time": "2026-04-22T05:55:00.000Z"},
        "scoreboard": {
            "gameDate": "2026-04-22",
            "games": [
                {
                    "awayTeam": {
                        "score": 108,
                        "teamCity": "New York",
                        "teamName": "Knicks",
                        "teamTricode": "NYK",
                    },
                    "gameClock": "00:42",
                    "gameId": "0022600001",
                    "gameStatus": 2,
                    "gameTimeUTC": "2026-04-22T02:00:00Z",
                    "homeTeam": {
                        "score": 112,
                        "teamCity": "Boston",
                        "teamName": "Celtics",
                        "teamTricode": "BOS",
                    },
                    "period": 4,
                }
            ],
        },
    }

    normalized = normalize_live_scoreboard_payload(payload)

    assert normalized.requestedDate == "2026-04-22"
    assert normalized.games[0].game.id == "nba-0022600001"
    assert normalized.games[0].game.homeParticipant.abbreviation == "BOS"
    assert normalized.games[0].gameState.status == "in-play"
    assert normalized.games[0].gameState.homeScore == 112


def test_normalize_live_scoreboard_payload_replaces_naive_meta_timestamp(
) -> None:
    payload = {
        "meta": {"time": "2026-05-17 08:55:00.5555", "code": 200},
        "scoreboard": {
            "gameDate": "2026-05-17",
            "games": [
                {
                    "awayTeam": {
                        "score": 36,
                        "teamCity": "Cleveland",
                        "teamName": "Cavaliers",
                        "teamTricode": "CLE",
                    },
                    "gameClock": "PT09M11.00S",
                    "gameId": "0042500207",
                    "gameStatus": 2,
                    "gameTimeUTC": "2026-05-18T00:00:00Z",
                    "homeTeam": {
                        "score": 26,
                        "teamCity": "Detroit",
                        "teamName": "Pistons",
                        "teamTricode": "DET",
                    },
                    "period": 2,
                }
            ],
        },
    }

    normalized = normalize_live_scoreboard_payload(payload)

    assert normalized.generatedAt == "2026-05-17T08:55:00.555500+00:00"
    assert normalized.games[0].gameState.capturedAt == "2026-05-17T08:55:00.555500+00:00"
    assert normalized.games[0].gameState.status == "in-play"


def test_normalize_live_scoreboard_payload_fails_loud_on_invalid_meta_timestamp() -> None:
    payload = {
        "meta": {"time": "not-a-real-time"},
        "scoreboard": {"gameDate": "2026-05-17", "games": []},
    }

    with pytest.raises(ValueError, match="meta.time"):
        normalize_live_scoreboard_payload(payload)


def test_normalize_live_scoreboard_payload_does_not_emit_literal_none_strings() -> None:
    payload = {
        "meta": {"time": "2026-04-22T05:55:00.000Z"},
        "scoreboard": {
            "gameDate": "2026-04-22",
            "games": [
                {
                    "awayTeam": {
                        "score": 108,
                        "teamCity": "New York",
                        "teamName": "Knicks",
                        "teamTricode": "NYK",
                    },
                    "gameClock": None,
                    "gameId": "0022600001",
                    "gameStatus": 2,
                    "gameTimeUTC": "2026-04-22T02:00:00Z",
                    "homeTeam": {
                        "score": 112,
                        "teamCity": "Boston",
                        "teamName": "Celtics",
                        "teamTricode": "BOS",
                    },
                    "period": 4,
                }
            ],
        },
    }

    normalized = normalize_live_scoreboard_payload(payload)

    assert normalized.games[0].gameState.clock is None
    assert normalized.games[0].sourcePayloadMeta["gameCode"] is None
    assert normalized.games[0].sourcePayloadMeta["gameStatusText"] is None


def test_normalize_live_boxscore_payload_derives_final_outcome() -> None:
    payload = {
        "meta": {"time": "2026-04-22T06:12:00.000Z"},
        "game": {
            "awayTeam": {
                "score": 110,
                "teamCity": "New York",
                "teamName": "Knicks",
                "teamTricode": "NYK",
            },
            "gameEt": "2026-04-22T02:00:00Z",
            "gameStatus": 3,
            "homeTeam": {
                "score": 118,
                "teamCity": "Boston",
                "teamName": "Celtics",
                "teamTricode": "BOS",
            },
            "period": 4,
        },
    }

    normalized = normalize_live_boxscore_payload("0022600001", payload)

    assert normalized.game.gameState.isFinal is True
    assert normalized.game.outcome is not None
    assert normalized.game.outcome.winnerKey == "bos"


def test_normalize_live_boxscore_payload_uses_status_text_when_numeric_code_is_missing() -> None:
    payload = {
        "meta": {"time": "2026-04-22T06:12:00.000Z"},
        "game": {
            "awayTeam": {
                "score": 110,
                "teamCity": "New York",
                "teamName": "Knicks",
                "teamTricode": "NYK",
            },
            "gameEt": "2026-04-22T02:00:00Z",
            "gameStatusText": "Final",
            "homeTeam": {
                "score": 118,
                "teamCity": "Boston",
                "teamName": "Celtics",
                "teamTricode": "BOS",
            },
            "period": 4,
        },
    }

    normalized = normalize_live_boxscore_payload("0022600001", payload)

    assert normalized.game.gameState.status == "final"
    assert normalized.game.gameState.isFinal is True


def test_normalize_live_playbyplay_payload_keeps_core_action_fields() -> None:
    payload = {
        "meta": {"time": "2026-04-22T05:55:15.000Z"},
        "game": {
            "actions": [
                {
                    "actionNumber": 1,
                    "actionType": "jumpball",
                    "clock": "PT12M00.00S",
                    "description": "Opening tip",
                    "period": 1,
                    "scoreAway": "0",
                    "scoreHome": "0",
                    "teamTricode": "BOS",
                    "timeActual": "2026-04-22T02:01:00Z",
                }
            ]
        },
    }

    normalized = normalize_live_playbyplay_payload("0022600001", payload)

    assert normalized.gameId == "0022600001"
    assert normalized.actions[0].actionType == "jumpball"
    assert normalized.actions[0].teamTricode == "BOS"


def test_normalize_live_playbyplay_payload_carries_structured_attribution() -> None:
    # personId / playerName (playerNameI) / subType are the live credit a
    # misattribution moves between players; they must survive normalization so
    # the credited<->rightful pairing is exact, not regex-parsed from description.
    payload = {
        "meta": {"time": "2026-05-21T02:00:44.000Z"},
        "game": {
            "actions": [
                {
                    "actionNumber": 416,
                    "actionType": "rebound",
                    "subType": "offensive",
                    "personId": 1641705,
                    "playerNameI": "V. Wembanyama",
                    "clock": "PT10M01.00S",
                    "description": "V. Wembanyama REBOUND (Off:3 Def:3)",
                    "period": 3,
                    "teamTricode": "SAS",
                    "timeActual": "2026-05-21T02:00:43.6Z",
                }
            ]
        },
    }

    action = normalize_live_playbyplay_payload("0042500312", payload).actions[0]
    assert action.personId == 1641705
    assert action.playerName == "V. Wembanyama"
    assert action.subType == "offensive"
    assert action.actionType == "rebound"


def test_normalize_live_playbyplay_payload_attribution_falls_back_and_nulls() -> None:
    payload = {
        "meta": {"time": "2026-05-21T02:00:44.000Z"},
        "game": {
            "actions": [
                # no playerNameI -> fall back to playerName; no personId -> None
                {"actionNumber": 1, "actionType": "rebound", "playerName": "TEAM", "teamTricode": "SAS"},
                {"actionNumber": 2, "actionType": "timeout"},
            ]
        },
    }
    actions = normalize_live_playbyplay_payload("0042500312", payload).actions
    assert actions[0].playerName == "TEAM"
    assert actions[0].personId is None
    assert actions[1].personId is None and actions[1].playerName is None and actions[1].subType is None


def test_play_by_play_cdn_403_returns_structured_upstream_error(
    monkeypatch,
) -> None:
    def reject_request(*_args, **_kwargs):
        raise HTTPError(
            url="https://cdn.nba.com/playbyplay_0042500313.json",
            code=403,
            msg="Forbidden",
            hdrs={},
            fp=BytesIO(b"forbidden"),
        )

    monkeypatch.setattr("nba_sidecar.service.urlopen", reject_request)

    with pytest.raises(NbaSidecarUpstreamError) as exc_info:
        NbaSidecarService().get_live_play_by_play_payload("0042500313")

    assert exc_info.value.status_code == 424
    assert exc_info.value.cause == "HTTPError:403"
    assert "NBA PBP unavailable" in exc_info.value.operator_hint


def test_play_by_play_cdn_invalid_json_returns_structured_upstream_error(
    monkeypatch,
) -> None:
    class InvalidJsonResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b"{not-json"

    monkeypatch.setattr(
        "nba_sidecar.service.urlopen", lambda *_args, **_kwargs: InvalidJsonResponse()
    )

    with pytest.raises(NbaSidecarUpstreamError) as exc_info:
        NbaSidecarService().get_live_play_by_play_payload("0042500313")

    assert exc_info.value.status_code == 502
    assert exc_info.value.cause == "JSONDecodeError"
    assert "parseable play-by-play JSON" in exc_info.value.operator_hint


def test_play_by_play_endpoint_returns_operator_hint_for_upstream_failure(
    monkeypatch,
) -> None:
    def fail_play_by_play(_service: NbaSidecarService, _game_id: str):
        raise NbaSidecarUpstreamError(
            "NBA CDN play-by-play request was rejected.",
            cause="HTTPError:403",
            operator_hint="NBA PBP unavailable; market tripwire only.",
            status_code=424,
        )

    monkeypatch.setattr(NbaSidecarService, "get_play_by_play", fail_play_by_play)

    with pytest.raises(HTTPException) as exc_info:
        get_play_by_play("0042500313")

    assert exc_info.value.status_code == 424
    assert exc_info.value.detail == {
        "message": "NBA CDN play-by-play request was rejected.",
        "operatorHint": "NBA PBP unavailable; market tripwire only.",
        "cause": "HTTPError:403",
    }


def test_normalize_stats_scoreboard_payload_dedupes_repeated_game_headers() -> None:
    payload = {
        "resultSets": [
            {
                "headers": [
                    "GAME_ID",
                    "GAME_STATUS_ID",
                    "GAME_STATUS_TEXT",
                    "GAME_DATE_EST",
                    "HOME_TEAM_ID",
                    "VISITOR_TEAM_ID",
                    "LIVE_PERIOD",
                    "LIVE_PC_TIME",
                ],
                "name": "GameHeader",
                "rowSet": [
                    [
                        "0042500112",
                        1,
                        "7:00 pm ET",
                        "2026-04-24T00:00:00",
                        "1610612755",
                        "1610612738",
                        0,
                        "",
                    ],
                    [
                        "0042500112",
                        1,
                        "7:00 pm ET",
                        "2026-04-24T00:00:00",
                        "1610612755",
                        "1610612738",
                        0,
                        "",
                    ],
                ],
            },
            {
                "headers": [
                    "GAME_ID",
                    "TEAM_ID",
                    "TEAM_CITY_NAME",
                    "TEAM_NAME",
                    "TEAM_ABBREVIATION",
                    "PTS",
                ],
                "name": "LineScore",
                "rowSet": [
                    ["0042500112", "1610612755", "Philadelphia", "76ers", "PHI", ""],
                    ["0042500112", "1610612738", "Boston", "Celtics", "BOS", ""],
                ],
            },
        ]
    }

    normalized = normalize_stats_scoreboard_payload(payload, requested_date="2026-04-24")

    assert len(normalized.games) == 1
    assert normalized.games[0].game.id == "nba-0042500112"


def test_normalize_stats_scoreboard_payload_skips_bad_games_instead_of_crashing() -> None:
    payload = {
        "resultSets": [
            {
                "headers": [
                    "GAME_ID",
                    "GAME_STATUS_ID",
                    "GAME_STATUS_TEXT",
                    "GAME_DATE_EST",
                    "HOME_TEAM_ID",
                    "VISITOR_TEAM_ID",
                    "LIVE_PERIOD",
                    "LIVE_PC_TIME",
                ],
                "name": "GameHeader",
                "rowSet": [
                    [
                        "0042500112",
                        1,
                        "7:00 pm ET",
                        "",
                        "1610612755",
                        "1610612738",
                        0,
                        "",
                    ]
                ],
            },
            {
                "headers": [
                    "GAME_ID",
                    "TEAM_ID",
                    "TEAM_CITY_NAME",
                    "TEAM_NAME",
                    "TEAM_ABBREVIATION",
                    "PTS",
                ],
                "name": "LineScore",
                "rowSet": [
                    ["0042500112", "1610612755", "Philadelphia", "76ers", "PHI", ""],
                    ["0042500112", "1610612738", "Boston", "Celtics", "BOS", ""],
                ],
            },
        ]
    }

    normalized = normalize_stats_scoreboard_payload(payload, requested_date="2026-04-24")

    assert normalized.games == []


def test_normalize_schedule_league_payload_maps_future_playoff_games() -> None:
    payload = {
        "meta": {"time": "2026-05-10T14:19:57.1957Z"},
        "leagueSchedule": {
            "gameDates": [
                {
                    "gameDate": "05/11/2026 00:00:00",
                    "games": [
                        {
                            "awayTeam": {
                                "score": 0,
                                "teamCity": "Detroit",
                                "teamName": "Pistons",
                                "teamTricode": "DET",
                            },
                            "gameDateTimeUTC": "2026-05-12T00:00:00Z",
                            "gameId": "0042500204",
                            "gameStatus": 1,
                            "gameStatusText": "8:00 pm ET",
                            "gameTimeUTC": "1900-01-01T00:00:00Z",
                            "homeTeam": {
                                "score": 0,
                                "teamCity": "Cleveland",
                                "teamName": "Cavaliers",
                                "teamTricode": "CLE",
                            },
                            "period": 0,
                        }
                    ],
                }
            ]
        },
    }

    normalized = normalize_schedule_league_payload(
        payload, requested_date="2026-05-11"
    )

    assert len(normalized.games) == 1
    assert normalized.games[0].game.id == "nba-0042500204"
    assert normalized.games[0].game.scheduledStart == "2026-05-12T00:00:00+00:00"
    assert normalized.games[0].game.awayParticipant.abbreviation == "DET"
    assert normalized.games[0].game.homeParticipant.abbreviation == "CLE"


def test_service_falls_back_to_schedule_when_stats_scoreboard_is_empty(monkeypatch) -> None:
    class EmptyScoreboardV3:
        def __init__(self, **_kwargs) -> None:
            pass

        def get_dict(self) -> dict:
            return {"scoreboard": {"games": []}}

    class FakeResponse:
        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *_args) -> None:
            return None

        def read(self) -> bytes:
            return b"""
            {
              "meta": {"time": "2026-05-10T14:19:57.1957Z"},
              "leagueSchedule": {
                "gameDates": [
                  {
                    "gameDate": "05/11/2026 00:00:00",
                    "games": [
                      {
                        "awayTeam": {
                          "score": 0,
                          "teamCity": "Oklahoma City",
                          "teamName": "Thunder",
                          "teamTricode": "OKC"
                        },
                        "gameDateTimeUTC": "2026-05-12T02:30:00Z",
                        "gameId": "0042500224",
                        "gameStatus": 1,
                        "gameStatusText": "10:30 pm ET",
                        "homeTeam": {
                          "score": 0,
                          "teamCity": "Los Angeles",
                          "teamName": "Lakers",
                          "teamTricode": "LAL"
                        },
                        "period": 0
                      }
                    ]
                  }
                ]
              }
            }
            """

    monkeypatch.setattr("nba_sidecar.service.scoreboardv3.ScoreboardV3", EmptyScoreboardV3)
    monkeypatch.setattr("nba_sidecar.service.is_today", lambda _requested_date: False)
    monkeypatch.setattr("nba_sidecar.service._is_past_date", lambda _requested_date: False)
    monkeypatch.setattr(
        "nba_sidecar.service.urlopen", lambda *_args, **_kwargs: FakeResponse()
    )

    normalized = NbaSidecarService().get_scoreboard("2026-05-11")

    assert len(normalized.games) == 1
    assert normalized.games[0].game.id == "nba-0042500224"


def test_service_prefers_scoreboard_v3_for_historical_dates(monkeypatch) -> None:
    class FakeScoreboardV3:
        def __init__(self, **_kwargs) -> None:
            pass

        def get_dict(self) -> dict:
            return {
                "meta": {"time": "2026-05-20T06:00:00.000Z"},
                "scoreboard": {
                    "gameDate": "2026-05-17",
                    "games": [
                        {
                            "awayTeam": {
                                "score": 125,
                                "teamCity": "Cleveland",
                                "teamName": "Cavaliers",
                                "teamTricode": "CLE",
                            },
                            "gameClock": "",
                            "gameId": "0042500207",
                            "gameStatus": 3,
                            "gameStatusText": "Final",
                            "gameTimeUTC": "2026-05-17T00:00:00Z",
                            "homeTeam": {
                                "score": 94,
                                "teamCity": "Detroit",
                                "teamName": "Pistons",
                                "teamTricode": "DET",
                            },
                            "period": 4,
                        }
                    ],
                },
            }

    monkeypatch.setattr("nba_sidecar.service.scoreboardv3.ScoreboardV3", FakeScoreboardV3)
    monkeypatch.setattr("nba_sidecar.service.is_today", lambda _requested_date: False)

    normalized = NbaSidecarService().get_scoreboard("2026-05-17")

    assert len(normalized.games) == 1
    assert normalized.games[0].game.id == "nba-0042500207"
    assert normalized.games[0].gameState.status == "final"
    assert normalized.games[0].gameState.homeScore == 94
    assert normalized.games[0].outcome is not None


def test_service_does_not_fall_back_to_schedule_for_past_dates_when_v3_is_empty(
    monkeypatch,
) -> None:
    class StaleScheduledScoreboardV3:
        def __init__(self, **_kwargs) -> None:
            pass

        def get_dict(self) -> dict:
            return {
                "meta": {"time": "2026-05-11T05:00:11.011Z"},
                "scoreboard": {
                    "gameDate": "2026-05-16",
                    "games": [
                        {
                            "awayTeam": {
                                "score": 0,
                                "teamCity": "Oklahoma City",
                                "teamName": "Thunder",
                                "teamTricode": "OKC",
                            },
                            "gameClock": "",
                            "gameId": "0042500226",
                            "gameStatus": 1,
                            "gameStatusText": "TBD",
                            "gameTimeUTC": "2026-05-16T04:00:00Z",
                            "homeTeam": {
                                "score": 0,
                                "teamCity": "Los Angeles",
                                "teamName": "Lakers",
                                "teamTricode": "LAL",
                            },
                            "period": 0,
                        }
                    ],
                },
            }

    monkeypatch.setattr(
        "nba_sidecar.service.scoreboardv3.ScoreboardV3", StaleScheduledScoreboardV3
    )
    monkeypatch.setattr("nba_sidecar.service.is_today", lambda _requested_date: False)
    monkeypatch.setattr("nba_sidecar.service._is_past_date", lambda _requested_date: True)
    monkeypatch.setattr(
        "nba_sidecar.service.NbaSidecarService.get_schedule_scoreboard",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Past dates should not fall back to schedule payloads.")
        ),
    )

    normalized = NbaSidecarService().get_scoreboard("2026-05-16")

    assert normalized.requestedDate == "2026-05-16"
    assert normalized.games == []


def test_service_falls_back_to_cdn_when_live_scoreboard_rejects_default_request(
    monkeypatch,
) -> None:
    class BrokenLiveScoreboard:
        def __init__(self, **_kwargs) -> None:
            pass

        def get_dict(self) -> dict:
            raise ValueError("NBA live request rejected")

    class FakeResponse:
        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *_args) -> None:
            return None

        def read(self) -> bytes:
            return b"""
            {
              "meta": {"time": "2026-05-12 04:53:32.5332", "code": 200},
              "scoreboard": {
                "gameDate": "2026-05-11",
                "games": [
                  {
                    "awayTeam": {
                      "score": 92,
                      "teamCity": "Oklahoma City",
                      "teamName": "Thunder",
                      "teamTricode": "OKC"
                    },
                    "gameClock": "PT08M37.00S",
                    "gameId": "0042500224",
                    "gameStatus": 2,
                    "gameStatusText": "Q4 8:37",
                    "gameTimeUTC": "2026-05-12T02:30:00Z",
                    "homeTeam": {
                      "score": 96,
                      "teamCity": "Los Angeles",
                      "teamName": "Lakers",
                      "teamTricode": "LAL"
                    },
                    "period": 4
                  }
                ]
              }
            }
            """

    monkeypatch.setattr("nba_sidecar.service.scoreboard.ScoreBoard", BrokenLiveScoreboard)
    monkeypatch.setattr("nba_sidecar.service.is_today", lambda _requested_date: True)
    monkeypatch.setattr(
        "nba_sidecar.service.urlopen", lambda *_args, **_kwargs: FakeResponse()
    )

    normalized = NbaSidecarService().get_scoreboard("2026-05-11")

    assert len(normalized.games) == 1
    assert normalized.games[0].game.id == "nba-0042500224"
    assert normalized.games[0].gameState.status == "in-play"
    assert normalized.games[0].gameState.homeScore == 96


def test_is_today_uses_eastern_calendar_day() -> None:
    assert is_today(
        "2026-05-27",
        now=datetime(2026, 5, 28, 1, 30, tzinfo=timezone.utc),
    )
    assert not is_today(
        "2026-05-28",
        now=datetime(2026, 5, 28, 1, 30, tzinfo=timezone.utc),
    )
