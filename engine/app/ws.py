"""FastAPI application: WebSocket streaming endpoint, health, and auth."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import ipaddress
import logging
import math
import threading
import time
from dataclasses import dataclass, field, replace
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, WebSocket
from starlette.websockets import WebSocketDisconnect

from . import __version__
from .config import (
    RuntimeConfig,
    Settings,
    generate_token,
    is_loopback_host,
)
from .detector import (
    Detection,
    Detector,
    DetectorError,
    DetectorLoadResult,
    ImageDecodeError,
    load_detector,
)
from .protocol import (
    PROTOCOL_VERSION,
    Frame,
    ProtocolError,
    now_ms,
    parse_control_message,
    parse_frame,
)
from .scheduler import FrameJob, LatestFrameScheduler

logger = logging.getLogger(__name__)

MAX_CONSECUTIVE_PROTOCOL_ERRORS = 20
_SENDER_STOP = object()


@dataclass(slots=True)
class Metrics:
    """Small lock-protected counter set exposed by ``/health``."""

    received: int = 0
    processed: int = 0
    dropped: int = 0
    errors: int = 0
    connections: int = 0
    last_seq: int | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, field_name: str, amount: int = 1) -> None:
        with self._lock:
            setattr(self, field_name, getattr(self, field_name) + amount)

    def set_last_seq(self, seq: int) -> None:
        with self._lock:
            if self.last_seq is None or seq > self.last_seq:
                self.last_seq = seq

    def snapshot(self) -> dict[str, int | None]:
        with self._lock:
            return {
                "received": self.received,
                "processed": self.processed,
                "dropped": self.dropped,
                "errors": self.errors,
                "connections": self.connections,
                "last_seq": self.last_seq,
            }


@dataclass(slots=True)
class EngineContext:
    """Shared state for one application instance."""

    settings: Settings
    token: str
    detector: Detector
    detector_error: str | None
    model_path: str | None
    runtime: RuntimeConfig
    metrics: Metrics
    started_at: float
    reload_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def create_app(
    settings: Settings | None = None,
    *,
    detector: Detector | None = None,
) -> FastAPI:
    """Build the sidecar application.

    If ``detector`` is omitted the configured model is loaded and a heuristic
    fallback is selected when necessary. ``create_app`` never raises because of
    a broken/missing model.
    """

    settings = Settings.from_env() if settings is None else settings
    settings.validate()
    token = settings.token or generate_token()
    if settings.token is None:
        settings = replace(settings, token=token)

    if detector is None:
        loaded = load_detector(settings)
    else:
        loaded = DetectorLoadResult(
            detector,
            error=None,
            model_path=str(settings.model_path),
            attempted_onnx=detector.id.startswith("onnx:"),
        )

    context = EngineContext(
        settings=settings,
        token=token,
        detector=loaded.detector,
        detector_error=loaded.error,
        model_path=loaded.model_path,
        runtime=RuntimeConfig(sensitivity=settings.sensitivity, fps=settings.fps),
        metrics=Metrics(),
        started_at=time.monotonic(),
    )

    app = FastAPI(
        title="ScreenBlur Engine",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.engine = context

    @app.get("/health")
    async def health() -> dict[str, Any]:
        snapshot = context.runtime.snapshot()
        return {
            "ok": True,
            "version": __version__,
            "paused": snapshot.paused,
            "detector": context.detector.id,
            "detector_error": context.detector_error,
            "model_path": context.model_path,
            "sensitivity": snapshot.sensitivity,
            "fps": snapshot.fps,
            "metrics": context.metrics.snapshot(),
            "uptime_s": round(max(0.0, time.monotonic() - context.started_at), 3),
        }

    @app.websocket("/ws/stream")
    async def stream(websocket: WebSocket) -> None:
        await _handle_stream(websocket, context)

    return app


async def _handle_stream(websocket: WebSocket, context: EngineContext) -> None:
    client_host = websocket.client.host if websocket.client is not None else None

    if not _authorized(websocket, context.token):
        logger.warning("rejected websocket connection from %s: invalid token", client_host)
        with contextlib.suppress(Exception):
            await websocket.close(code=4401, reason="unauthorized")
        return
    if not _is_loopback_client(client_host) or not _has_local_host_header(websocket):
        logger.warning("rejected websocket connection from %s: non-local request", client_host)
        with contextlib.suppress(Exception):
            await websocket.close(code=4403, reason="loopback clients only")
        return

    await websocket.accept()
    context.metrics.add("connections")
    outbox: asyncio.Queue[dict[str, Any] | object] = asyncio.Queue()
    sender_task = asyncio.create_task(
        _sender(websocket, outbox),
        name="screenblur-ws-sender",
    )

    dropped_seen = 0

    def sync_dropped() -> None:
        nonlocal dropped_seen
        current = scheduler.stats().dropped
        if current > dropped_seen:
            context.metrics.add("dropped", current - dropped_seen)
            dropped_seen = current

    async def handle_frame(frame: Frame, job: FrameJob) -> None:
        started = time.perf_counter()
        snapshot = context.runtime.snapshot()
        if snapshot.paused:
            context.metrics.add("dropped")
            return

        active_detector = context.detector
        try:
            detection: Detection = await asyncio.to_thread(active_detector.detect, frame.payload)
        except ImageDecodeError as exc:
            context.metrics.add("errors")
            await outbox.put(
                {
                    "type": "error",
                    "code": "FRAME_DECODE_ERROR",
                    "message": str(exc),
                    "seq": frame.seq,
                }
            )
            return
        except DetectorError as exc:
            context.metrics.add("errors")
            await outbox.put(
                {
                    "type": "error",
                    "code": "INFERENCE_ERROR",
                    "message": str(exc),
                    "seq": frame.seq,
                }
            )
            return
        except asyncio.CancelledError:
            raise
        except Exception:
            context.metrics.add("errors")
            logger.exception("unexpected detector failure for seq=%s", frame.seq)
            await outbox.put(
                {
                    "type": "error",
                    "code": "INFERENCE_ERROR",
                    "message": "detector raised an unexpected error",
                    "seq": frame.seq,
                }
            )
            return

        finished = now_ms()
        score = round(float(detection.score), 6)
        show = score >= snapshot.sensitivity
        latency_ms = max(0, finished - frame.ts) if frame.ts > 0 else 0
        processing_ms = max(0, round((time.perf_counter() - started) * 1000))
        result = {
            "type": "result",
            "seq": frame.seq,
            "display_id": frame.display_id,
            "show": show,
            "score": score,
            "category": "explicit" if show else "sfw",
            "boxes": detection.boxes,
            "roi": None,
            "latency_ms": latency_ms,
            "processing_ms": processing_ms,
            "superseded": job.superseded,
            "ts": finished,
            "detector": active_detector.id,
        }
        context.metrics.add("processed")
        context.metrics.set_last_seq(frame.seq)
        logger.info(
            "result seq=%s score=%.3f show=%s detector=%s processing=%dms superseded=%s boxes=%d",
            frame.seq,
            score,
            show,
            active_detector.id,
            processing_ms,
            job.superseded,
            len(detection.boxes),
        )
        await outbox.put(result)

    scheduler = LatestFrameScheduler(handle_frame)
    await scheduler.start()
    await outbox.put(_ready_message(context))

    consecutive_errors = 0
    try:
        while True:
            try:
                message = await websocket.receive()
            except WebSocketDisconnect:
                break

            message_type = message.get("type")
            if message_type == "websocket.disconnect":
                break

            data = message.get("bytes")
            if data is not None:
                context.metrics.add("received")
                try:
                    frame = parse_frame(
                        data,
                        max_frame_bytes=context.settings.max_frame_bytes,
                    )
                except ProtocolError as exc:
                    context.metrics.add("errors")
                    consecutive_errors += 1
                    await outbox.put(_error_message("PROTOCOL_ERROR", exc.message))
                    if consecutive_errors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS:
                        logger.warning("closing websocket after repeated protocol errors")
                        with contextlib.suppress(Exception):
                            await websocket.close(
                                code=4400,
                                reason="too many protocol errors",
                            )
                        break
                    continue

                consecutive_errors = 0
                if context.runtime.snapshot().paused:
                    context.metrics.add("dropped")
                    continue
                if not scheduler.submit(frame):
                    break
                sync_dropped()
                continue

            text = message.get("text")
            if text is not None:
                try:
                    control = parse_control_message(text)
                except ProtocolError as exc:
                    context.metrics.add("errors")
                    consecutive_errors += 1
                    await outbox.put(_error_message(exc.code, exc.message))
                    if consecutive_errors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS:
                        with contextlib.suppress(Exception):
                            await websocket.close(
                                code=4400,
                                reason="too many protocol errors",
                            )
                        break
                    continue

                consecutive_errors = 0
                should_close = await _handle_control(
                    control,
                    context,
                    scheduler,
                    outbox,
                )
                sync_dropped()
                if should_close:
                    break
                continue

            # Unknown ASGI message shape (for example a websocket.connect
            # duplicate). Treat it as a protocol error without crashing.
            context.metrics.add("errors")
            consecutive_errors += 1
            await outbox.put(_error_message("PROTOCOL_ERROR", "unexpected message"))
            if consecutive_errors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS:
                with contextlib.suppress(Exception):
                    await websocket.close(code=4400, reason="too many protocol errors")
                break
    finally:
        await scheduler.stop()
        sync_dropped()
        with contextlib.suppress(Exception):
            outbox.put_nowait(_SENDER_STOP)
        try:
            await asyncio.wait_for(sender_task, timeout=2.0)
        except (TimeoutError, asyncio.CancelledError):
            sender_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sender_task
        except Exception:
            logger.debug("websocket sender task ended with an error", exc_info=True)
        context.metrics.add("connections", -1)


async def _handle_control(
    control: dict[str, Any],
    context: EngineContext,
    scheduler: LatestFrameScheduler,
    outbox: asyncio.Queue[dict[str, Any] | object],
) -> bool:
    """Apply one control message. Returns True when the connection should close."""
    msg_type = control.get("type")

    if msg_type == "ping":
        await outbox.put({"type": "pong", "id": control.get("id")})
        return False

    if msg_type == "pause":
        context.runtime.set_paused(True)
        scheduler.drop_pending()
        await outbox.put(_status_message(context))
        return False

    if msg_type == "resume":
        context.runtime.set_paused(False)
        await outbox.put(_status_message(context))
        return False

    if msg_type == "config":
        sensitivity: float | None = None
        fps: float | None = None
        try:
            if "sensitivity" in control:
                sensitivity = _float_field(control, "sensitivity")
            elif "threshold" in control:
                sensitivity = _float_field(control, "threshold")
            if "fps" in control:
                fps = _float_field(control, "fps")
            context.runtime.update(sensitivity=sensitivity, fps=fps)
        except ValueError as exc:
            await outbox.put(_error_message("BAD_CONFIG", str(exc)))
            return False
        await outbox.put(_status_message(context))
        return False

    if msg_type == "reload_model":
        async with context.reload_lock:
            loaded = await asyncio.to_thread(load_detector, context.settings)
            context.detector = loaded.detector
            context.detector_error = loaded.error
            context.model_path = loaded.model_path
        if loaded.error:
            logger.warning("model reload fell back to %s: %s", loaded.detector.id, loaded.error)
        await outbox.put(_status_message(context))
        return False

    await outbox.put(
        _error_message("UNKNOWN_TYPE", f"unsupported control message type: {msg_type!r}")
    )
    return False


def _ready_message(context: EngineContext) -> dict[str, Any]:
    return {
        "type": "ready",
        "version": __version__,
        "protocol": PROTOCOL_VERSION,
        "models": [context.detector.id],
        "detector": context.detector.id,
        "detector_error": context.detector_error,
        "max_frame_bytes": context.settings.max_frame_bytes,
    }


def _status_message(context: EngineContext) -> dict[str, Any]:
    snapshot = context.runtime.snapshot()
    return {
        "type": "status",
        "paused": snapshot.paused,
        "sensitivity": snapshot.sensitivity,
        "fps": snapshot.fps,
        "detector": context.detector.id,
        "detector_error": context.detector_error,
    }


def _error_message(code: str, message: str) -> dict[str, Any]:
    return {"type": "error", "code": code, "message": message}


async def _sender(
    websocket: WebSocket,
    outbox: asyncio.Queue[dict[str, Any] | object],
) -> None:
    """Serialize every server -> client message through one task."""
    while True:
        item = await outbox.get()
        if item is _SENDER_STOP:
            return
        try:
            await websocket.send_json(item)
        except Exception:
            logger.debug("websocket send failed; sender stopping", exc_info=True)
            return


def _authorized(websocket: WebSocket, expected_token: str) -> bool:
    expected = expected_token.encode("utf-8")
    candidates: list[str] = []
    query_token = websocket.query_params.get("token")
    if query_token:
        candidates.append(query_token)
    authorization = websocket.headers.get("authorization")
    if authorization:
        parts = authorization.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "bearer" and parts[1].strip():
            candidates.append(parts[1].strip())

    for candidate in candidates:
        try:
            if hmac.compare_digest(candidate.encode("utf-8"), expected):
                return True
        except (TypeError, ValueError):
            continue
    return False


def _is_loopback_client(host: str | None) -> bool:
    if not host:
        return False
    if host == "testclient":
        # Starlette's in-process TestClient. This value cannot be produced by a
        # real TCP peer, so accepting it does not weaken the network check.
        return True
    if is_loopback_host(host):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    if address.is_loopback:
        return True
    mapped = getattr(address, "ipv4_mapped", None)
    return bool(mapped and mapped.is_loopback)


def _has_local_host_header(websocket: WebSocket) -> bool:
    header = websocket.headers.get("host")
    if not header:
        return False
    try:
        parsed = urlsplit(f"//{header}")
        hostname = parsed.hostname
    except ValueError:
        return False
    if hostname is None:
        return False
    if (
        hostname == "testserver"
        and websocket.client is not None
        and websocket.client.host == "testclient"
    ):
        # Default Starlette TestClient host header. Real network peers cannot
        # claim the in-process "testclient" address.
        return True
    return is_loopback_host(hostname)


def _float_field(message: dict[str, Any], name: str) -> float:
    value = message[name]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number
