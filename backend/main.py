from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from starlette.websockets import WebSocketState

from .auth import AuthTokenValidator, OriginMatcher
from .config import Settings, get_settings
from .pipeline import TranslationPipeline
from .providers import build_translation_provider, build_tts_provider
from .schemas import HealthResponse, StreamChunk, StreamRequest

logger = logging.getLogger("live_video_translation")


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def _is_secure_websocket(websocket: WebSocket) -> bool:
    if websocket.url.scheme == "wss":
        return True
    forwarded_proto = websocket.headers.get("x-forwarded-proto", "").lower()
    if forwarded_proto in {"https", "wss"}:
        return True
    return websocket.headers.get("x-forwarded-ssl", "").lower() == "on"


def _validate_request_limits(request: StreamRequest, settings: Settings) -> None:
    if len(request.transcript) > settings.max_transcript_items:
        raise ValueError(
            f"transcript contains {len(request.transcript)} items; "
            f"maximum is {settings.max_transcript_items}"
        )
    oversized = [
        index
        for index, item in enumerate(request.transcript)
        if len(item.text) > settings.max_text_chars_per_chunk
    ]
    if oversized:
        raise ValueError(
            f"transcript item {oversized[0]} exceeds "
            f"{settings.max_text_chars_per_chunk} characters"
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    _configure_logging()
    settings = get_settings()
    auth_validator = AuthTokenValidator(settings.auth_token_values)
    origin_matcher = OriginMatcher(settings.allowed_origin_patterns)
    http_client = httpx.AsyncClient(
        headers={"User-Agent": "live-video-translation/1.0"},
        limits=httpx.Limits(max_connections=64, max_keepalive_connections=16),
    )
    translator = build_translation_provider(settings, http_client)
    tts = build_tts_provider(settings, http_client)

    app.state.settings = settings
    app.state.auth_validator = auth_validator
    app.state.origin_matcher = origin_matcher
    app.state.http_client = http_client
    app.state.pipeline = TranslationPipeline(
        translator=translator,
        tts=tts,
        settings=settings,
    )
    logger.info(
        "backend started with translation_provider=%s tts_provider=%s",
        settings.translation_provider,
        settings.tts_provider,
    )
    try:
        yield
    finally:
        await http_client.aclose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Live Video Translation API",
        version="1.0.0",
        lifespan=lifespan,
    )

    @app.get("/healthz", response_model=HealthResponse)
    async def healthz() -> HealthResponse:
        settings: Settings = app.state.settings
        return HealthResponse(
            status="ok",
            translation_provider=settings.translation_provider,
            tts_provider=settings.tts_provider,
        )

    @app.websocket("/stream")
    async def stream(websocket: WebSocket) -> None:
        settings: Settings = app.state.settings
        origin_matcher: OriginMatcher = app.state.origin_matcher
        auth_validator: AuthTokenValidator = app.state.auth_validator
        pipeline: TranslationPipeline = app.state.pipeline

        if settings.require_wss and not _is_secure_websocket(websocket):
            await websocket.close(code=1008, reason="WSS is required")
            return

        origin = websocket.headers.get("origin")
        if not origin_matcher.is_allowed(origin):
            await websocket.close(code=1008, reason="Origin is not allowed")
            return

        await websocket.accept()
        try:
            payload: Any = await websocket.receive_json()
            request = StreamRequest.model_validate(payload)
            _validate_request_limits(request, settings)
            if not auth_validator.is_valid(request.token):
                await websocket.close(code=1008, reason="Invalid auth token")
                return

            async def send_chunk(chunk: StreamChunk) -> None:
                await websocket.send_json(chunk.model_dump(by_alias=True))

            await pipeline.stream(request, send_chunk)
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close(code=1000, reason="Transcript complete")
        except WebSocketDisconnect:
            logger.info("websocket disconnected")
        except (ValidationError, ValueError) as exc:
            logger.warning("invalid stream request: %s", exc)
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close(code=1003, reason="Invalid stream payload")
        except Exception:
            logger.exception("stream processing failed")
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close(code=1011, reason="Stream processing failed")

    return app


app = create_app()
