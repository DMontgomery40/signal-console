from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query

from .service import NbaSidecarService, NbaSidecarUpstreamError

app = FastAPI(title="Signal Console NBA Sidecar", version="0.1.0")
service = NbaSidecarService()


@app.get("/health/live")
def health_live() -> dict:
    return {"status": "ok"}


@app.get("/health/ready")
def health_ready() -> dict:
    try:
        payload = service.get_scoreboard()
    except Exception as exc:  # pragma: no cover - runtime health edge
        raise HTTPException(
            status_code=503,
            detail={
                "message": "NBA sidecar could not fetch scoreboard data.",
                "operatorHint": "Check outbound access to NBA endpoints and the nba_api runtime.",
                "cause": type(exc).__name__,
            },
        ) from exc

    return {
        "status": "ok",
        "summary": {
            "gameCount": len(payload.games),
            "generatedAt": payload.generatedAt,
        },
    }


@app.get("/api/v1/scoreboard")
def get_scoreboard(date: str | None = Query(default=None)) -> dict:
    return {
        "data": service.get_scoreboard(requested_date=date).model_dump(mode="json"),
        "meta": {"source": "nba_api"},
    }


@app.get("/api/v1/games/{game_id}")
def get_game(game_id: str) -> dict:
    return {
        "data": service.get_game(game_id).model_dump(mode="json"),
        "meta": {"source": "nba_api"},
    }


@app.get("/api/v1/games/{game_id}/play-by-play")
def get_play_by_play(game_id: str) -> dict:
    try:
        payload = service.get_play_by_play(game_id)
    except NbaSidecarUpstreamError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={
                "message": str(exc),
                "operatorHint": exc.operator_hint,
                "cause": exc.cause,
            },
        ) from exc
    return {
        "data": payload.model_dump(mode="json"),
        "meta": {"source": "nba_api"},
    }
