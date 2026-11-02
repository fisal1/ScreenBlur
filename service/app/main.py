import asyncio
import hmac
import logging
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse

from .model import InferenceModel
from .protocol import MAX_FRAME_BYTES, MIN_SCORE, PROTOCOL_VERSION, parse_frame_metadata

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("screenblur")
MODEL_PATH = os.environ.get(
    "SCREENBLUR_MODEL_PATH",
    str(Path(__file__).resolve().parents[2] / "models" / "320n.onnx"),
)
AUTH_TOKEN = os.environ.get("SCREENBLUR_BEARER_TOKEN") or secrets.token_urlsafe(32)
metrics = {
    "frames_received": 0,
    "frames_completed": 0,
    "frames_rejected": 0,
    "inference_errors": 0,
    "inference_latency_ms_sum": 0.0,
}
active_sessions = set()
session_slots = asyncio.Semaphore(max(1, int(os.environ.get("SCREENBLUR_MAX_SESSIONS", "16"))))
inference_slots = asyncio.Semaphore(max(1, int(os.environ.get("SCREENBLUR_MAX_CONCURRENCY", "1"))))


@asynccontextmanager
async def lifespan(app):
    app.state.model = InferenceModel(MODEL_PATH)
    app.state.started_at = time.time()
    logger.info(
        "Inference service ready (model=%s backend=%s)",
        app.state.model.model_version,
        app.state.model.backend,
    )
    if not os.environ.get("SCREENBLUR_BEARER_TOKEN"):
        logger.warning("Generated one-time test token (configure SCREENBLUR_BEARER_TOKEN to override): %s", AUTH_TOKEN)
    yield


app = FastAPI(title="ScreenBlur Inference", version="1", lifespan=lifespan)


@app.get("/health")
async def health():
    model = getattr(app.state, "model", None)
    return {
        "status": "ready" if model else "starting",
        "modelLoaded": model is not None,
        "activeSessions": len(active_sessions),
    }


@app.get("/model/info")
async def model_info():
    model = getattr(app.state, "model", None)
    if model is None:
        return {"status": "starting"}
    return {
        "modelVersion": model.model_version,
        "backend": model.backend,
        "protocolVersion": PROTOCOL_VERSION,
        "inputFormat": "jpeg",
    }


@app.get("/metrics", response_class=PlainTextResponse)
async def prometheus_metrics():
    model = getattr(app.state, "model", None)
    lines = [
        "# HELP screenblur_frames_received_total Valid frames received.",
        "# TYPE screenblur_frames_received_total counter",
        f"screenblur_frames_received_total {metrics['frames_received']}",
        "# HELP screenblur_frames_completed_total Frames successfully inferred.",
        "# TYPE screenblur_frames_completed_total counter",
        f"screenblur_frames_completed_total {metrics['frames_completed']}",
        "# HELP screenblur_frames_rejected_total Invalid or overloaded frame requests.",
        "# TYPE screenblur_frames_rejected_total counter",
        f"screenblur_frames_rejected_total {metrics['frames_rejected']}",
        "# HELP screenblur_inference_errors_total Inference failures.",
        "# TYPE screenblur_inference_errors_total counter",
        f"screenblur_inference_errors_total {metrics['inference_errors']}",
        "# HELP screenblur_active_sessions Current authenticated sessions.",
        "# TYPE screenblur_active_sessions gauge",
        f"screenblur_active_sessions {len(active_sessions)}",
        "# HELP screenblur_inference_latency_ms_sum Total model inference time in milliseconds.",
        "# TYPE screenblur_inference_latency_ms_sum counter",
        f"screenblur_inference_latency_ms_sum {metrics['inference_latency_ms_sum']:.3f}",
    ]
    if model:
        lines.extend([
            "# HELP screenblur_model_info Loaded model and execution provider.",
            "# TYPE screenblur_model_info gauge",
            f'screenblur_model_info{{version="{model.model_version}",backend="{model.backend}"}} 1',
        ])
    return "\n".join(lines) + "\n"


async def send_error(websocket, code, message, correlation_id=None, seq=None):
    await websocket.send_json({
        "type": "error",
        "code": code,
        "message": message,
        "correlationId": correlation_id,
        "seq": seq,
    })


@app.websocket("/v1/inference/stream")
async def inference_stream(websocket: WebSocket):
    origin = websocket.headers.get("origin")
    if origin not in (None, "null"):
        await websocket.close(code=1008, reason="Browser origins are not accepted")
        return

    if session_slots.locked():
        await websocket.close(code=1013, reason="Service session limit reached")
        return
    await session_slots.acquire()
    session_id = str(uuid.uuid4())
    last_seq = -1
    try:
        await websocket.accept()
        auth = await asyncio.wait_for(websocket.receive_json(), timeout=5)
        if (
            not isinstance(auth, dict)
            or auth.get("type") != "auth"
            or type(auth.get("protocolVersion")) is not int
            or auth.get("protocolVersion") != PROTOCOL_VERSION
            or not isinstance(auth.get("token"), str)
            or not hmac.compare_digest(auth["token"], AUTH_TOKEN)
        ):
            await websocket.close(code=4401, reason="Authentication failed")
            return
        active_sessions.add(session_id)
        await websocket.send_json({
            "type": "ready",
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": session_id,
            "modelVersion": app.state.model.model_version,
            "backend": app.state.model.backend,
        })

        while True:
            try:
                message = await asyncio.wait_for(websocket.receive_json(), timeout=30)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
                message = await asyncio.wait_for(websocket.receive_json(), timeout=10)
            if isinstance(message, dict) and message.get("type") == "pong":
                continue
            if not isinstance(message, dict) or message.get("type") != "frame":
                await send_error(websocket, "INVALID_MESSAGE", "Expected a frame request")
                await websocket.close(code=1008, reason="Invalid frame request")
                return
            correlation_id = message.get("correlationId") if isinstance(message, dict) else None
            seq = message.get("seq") if isinstance(message, dict) else None
            try:
                metadata = parse_frame_metadata(message, session_id, last_seq)
            except ValueError as error:
                metrics["frames_rejected"] += 1
                await send_error(websocket, "INVALID_FRAME", str(error), correlation_id, seq)
                await websocket.close(code=1008, reason="Invalid frame metadata")
                return
            payload = await asyncio.wait_for(websocket.receive_bytes(), timeout=10)
            last_seq = metadata.seq
            metrics["frames_received"] += 1

            if inference_slots.locked():
                metrics["frames_rejected"] += 1
                await send_error(websocket, "SERVER_BUSY", "Inference capacity is busy", correlation_id, seq)
                continue
            await inference_slots.acquire()
            try:
                if len(payload) != metadata.payload_bytes or len(payload) > MAX_FRAME_BYTES:
                    metrics["frames_rejected"] += 1
                    await send_error(websocket, "INVALID_PAYLOAD", "JPEG payload length does not match metadata", correlation_id, seq)
                    continue
                result = await asyncio.to_thread(app.state.model.infer, payload, metadata)
                metrics["frames_completed"] += 1
                metrics["inference_latency_ms_sum"] += result["latencyMs"]
                await websocket.send_json({
                    "type": "result",
                    "protocolVersion": PROTOCOL_VERSION,
                    "sessionId": session_id,
                    "correlationId": metadata.correlation_id,
                    "seq": metadata.seq,
                    "captureTimestampMs": metadata.capture_timestamp_ms,
                    "decision": "unsafe" if result["score"] >= MIN_SCORE else "safe",
                    "score": result["score"],
                    "label": result["label"],
                    "regions": result["regions"],
                    "modelVersion": result["modelVersion"],
                    "inferenceMs": result["latencyMs"],
                })
            except ValueError as error:
                metrics["frames_rejected"] += 1
                await send_error(websocket, "INVALID_IMAGE", str(error), correlation_id, seq)
            except Exception:
                metrics["inference_errors"] += 1
                logger.exception("Inference failed (session=%s seq=%s)", session_id, seq)
                await send_error(websocket, "INFERENCE_FAILED", "Inference failed", correlation_id, seq)
            finally:
                inference_slots.release()
    except WebSocketDisconnect:
        pass
    except asyncio.TimeoutError:
        try:
            await websocket.close(code=1001, reason="Authentication or heartbeat timeout")
        except RuntimeError:
            pass
    finally:
        active_sessions.discard(session_id)
        session_slots.release()
