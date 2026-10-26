from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.detector import HeuristicDetector
from app.protocol import encode_frame, now_ms
from app.ws import create_app

TOKEN = "test-secret-token"


@pytest.fixture
def app(tmp_path: Path):
    settings = Settings(
        token=TOKEN,
        model_path=tmp_path / "absent.onnx",
        sensitivity=0.8,
    )
    return create_app(settings, detector=HeuristicDetector())


@pytest.fixture
def client(app):
    with TestClient(app, base_url="http://127.0.0.1") as test_client:
        yield test_client


def test_ready_and_result_flow(client: TestClient, jpeg_bytes: bytes) -> None:
    with client.websocket_connect(f"/ws/stream?token={TOKEN}") as websocket:
        ready = websocket.receive_json()
        assert ready["type"] == "ready"
        assert ready["version"] == "0.1.0"
        assert ready["protocol"] == 1
        assert ready["detector"] == "heuristic"
        assert ready["models"] == ["heuristic"]
        assert ready["max_frame_bytes"] == 8 * 1024 * 1024

        timestamp = now_ms()
        websocket.send_bytes(encode_frame(jpeg_bytes, seq=7, display_id=2, ts=timestamp))
        result = websocket.receive_json()

    assert result["type"] == "result"
    assert result["seq"] == 7
    assert result["display_id"] == 2
    assert result["detector"] == "heuristic"
    assert result["category"] in {"explicit", "sfw"}
    assert result["show"] is (result["score"] >= 0.8)
    assert result["category"] == ("explicit" if result["show"] else "sfw")
    assert len(result["boxes"]) == 1
    x1, y1, x2, y2 = result["boxes"][0]
    assert 0.0 <= x1 < x2 <= 1.0
    assert 0.0 <= y1 < y2 <= 1.0
    assert result["roi"] is None
    assert result["latency_ms"] >= 0
    assert result["processing_ms"] >= 0
    assert result["superseded"] is False
    assert result["ts"] >= timestamp

    health = client.get("/health")
    assert health.status_code == 200
    payload = health.json()
    assert payload["ok"] is True
    assert payload["version"] == "0.1.0"
    assert payload["paused"] is False
    assert payload["detector"] == "heuristic"
    assert payload["metrics"]["received"] == 1
    assert payload["metrics"]["processed"] == 1
    assert payload["metrics"]["errors"] == 0
    assert payload["metrics"]["connections"] == 0


def test_authorization_bearer_header(client: TestClient) -> None:
    with client.websocket_connect(
        "/ws/stream",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as websocket:
        assert websocket.receive_json()["type"] == "ready"


@pytest.mark.parametrize("token", ["wrong", ""])
def test_bad_token_is_rejected(client: TestClient, token: str) -> None:
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(f"/ws/stream?token={token}"):
            pass
    assert excinfo.value.code == 4401


def test_bad_bearer_token_is_rejected(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(
            "/ws/stream",
            headers={"Authorization": "Bearer nope"},
        ):
            pass
    assert excinfo.value.code == 4401


def test_non_local_host_header_is_rejected(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(
            f"/ws/stream?token={TOKEN}",
            headers={"host": "evil.example"},
        ):
            pass
    assert excinfo.value.code == 4403


def test_control_messages(client: TestClient) -> None:
    with client.websocket_connect(f"/ws/stream?token={TOKEN}") as websocket:
        assert websocket.receive_json()["type"] == "ready"

        websocket.send_json({"type": "ping", "id": 42})
        assert websocket.receive_json() == {"type": "pong", "id": 42}

        websocket.send_json({"type": "config", "threshold": 0.51, "fps": 1.5})
        status = websocket.receive_json()
        assert status["type"] == "status"
        assert status["sensitivity"] == pytest.approx(0.51)
        assert status["fps"] == pytest.approx(1.5)

        websocket.send_json({"type": "config", "sensitivity": 0.9})
        assert websocket.receive_json()["sensitivity"] == pytest.approx(0.9)

        websocket.send_json({"type": "pause"})
        assert websocket.receive_json()["paused"] is True
        websocket.send_json({"type": "resume"})
        assert websocket.receive_json()["paused"] is False

        websocket.send_json({"type": "nonsense"})
        error = websocket.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "UNKNOWN_TYPE"

        websocket.send_json({"type": "config", "sensitivity": "high"})
        error = websocket.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "BAD_CONFIG"

        websocket.send_json({"type": "ping", "id": 43})
        assert websocket.receive_json() == {"type": "pong", "id": 43}


def test_protocol_errors_do_not_close_connection(client: TestClient, jpeg_bytes: bytes) -> None:
    with client.websocket_connect(f"/ws/stream?token={TOKEN}") as websocket:
        assert websocket.receive_json()["type"] == "ready"

        websocket.send_bytes(b"garbage")
        error = websocket.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "PROTOCOL_ERROR"

        websocket.send_text("not json")
        error = websocket.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "INVALID_JSON"

        websocket.send_bytes(encode_frame(jpeg_bytes, seq=9, display_id=1, ts=now_ms()))
        result = websocket.receive_json()
        assert result["type"] == "result"
        assert result["seq"] == 9


def test_threshold_controls_show(client: TestClient, black_jpeg: bytes) -> None:
    with client.websocket_connect(f"/ws/stream?token={TOKEN}") as websocket:
        assert websocket.receive_json()["type"] == "ready"
        websocket.send_json({"type": "config", "sensitivity": 1.0})
        assert websocket.receive_json()["type"] == "status"

        websocket.send_bytes(encode_frame(black_jpeg, seq=3, display_id=1, ts=now_ms()))
        result = websocket.receive_json()
        assert result["show"] is False
        assert result["category"] == "sfw"
        assert result["score"] < 1.0


def test_reload_model_reports_status(client: TestClient) -> None:
    with client.websocket_connect(f"/ws/stream?token={TOKEN}") as websocket:
        assert websocket.receive_json()["type"] == "ready"
        websocket.send_json({"type": "reload_model"})
        status = websocket.receive_json()
        assert status["type"] == "status"
        assert status["detector"] == "heuristic"
        assert status["detector_error"] is None or isinstance(status["detector_error"], str)
