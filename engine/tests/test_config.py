from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.config import (
    RuntimeConfig,
    Settings,
    generate_token,
    is_loopback_host,
    redact_token,
)
from app.main import bind_socket, write_ready_file


def test_redact_token_query_parameter() -> None:
    line = '127.0.0.1:5000 - "WebSocket /ws/stream?token=super-secret_123" [accepted]'
    redacted = redact_token(line)
    assert "super-secret_123" not in redacted
    assert "token=[redacted]" in redacted


def test_redact_token_authorization_header() -> None:
    redacted = redact_token("Authorization: Bearer abc.DEF-123")
    assert "abc.DEF-123" not in redacted
    assert "Bearer [redacted]" in redacted


def test_settings_from_env() -> None:
    settings = Settings.from_env(
        {
            "SCREENBLUR_HOST": "::1",
            "SCREENBLUR_PORT": "8123",
            "SCREENBLUR_TOKEN": "from-env",
            "SCREENBLUR_MODEL_PATH": "/tmp/model.onnx",
            "SCREENBLUR_MODEL_KIND": "NUDENET",
            "SCREENBLUR_MODEL_INPUT_SIZE": "320",
            "SCREENBLUR_EXPLICIT_CLASS_INDEX": "2",
            "SCREENBLUR_SENSITIVITY": "0.7",
            "SCREENBLUR_FPS": "3",
            "SCREENBLUR_MAX_FRAME_BYTES": "1048576",
            "SCREENBLUR_LOG_LEVEL": "DEBUG",
            "SCREENBLUR_READY_FILE": "/tmp/ready.json",
        }
    )
    assert settings.host == "::1"
    assert settings.port == 8123
    assert settings.token == "from-env"
    assert settings.model_path == Path("/tmp/model.onnx")
    assert settings.model_kind == "nudenet"
    assert settings.model_input_size == 320
    assert settings.explicit_class_index == 2
    assert settings.sensitivity == pytest.approx(0.7)
    assert settings.fps == pytest.approx(3.0)
    assert settings.max_frame_bytes == 1_048_576
    assert settings.log_level == "debug"
    assert settings.ready_file == Path("/tmp/ready.json")


def test_settings_defaults() -> None:
    settings = Settings.from_env({})
    assert settings.host == "127.0.0.1"
    assert settings.port == 0
    assert settings.token is None
    assert settings.model_kind == "auto"
    assert settings.sensitivity == pytest.approx(0.8)
    assert settings.max_frame_bytes == 8 * 1024 * 1024
    assert settings.log_level == "info"


@pytest.mark.parametrize(
    "environment",
    [
        {"SCREENBLUR_HOST": "0.0.0.0"},
        {"SCREENBLUR_HOST": "example.com"},
        {"SCREENBLUR_PORT": "70000"},
        {"SCREENBLUR_SENSITIVITY": "1.5"},
        {"SCREENBLUR_FPS": "0"},
        {"SCREENBLUR_MAX_FRAME_BYTES": "10"},
        {"SCREENBLUR_MODEL_INPUT_SIZE": "8"},
        {"SCREENBLUR_MODEL_KIND": "yolo"},
        {"SCREENBLUR_LOG_LEVEL": "verbose"},
        {"SCREENBLUR_PORT": "not-a-number"},
    ],
)
def test_invalid_environment_is_rejected(environment: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        Settings.from_env(environment)


def test_loopback_detection() -> None:
    assert is_loopback_host("127.0.0.1")
    assert is_loopback_host("127.0.0.2")
    assert is_loopback_host("::1")
    assert is_loopback_host("[::1]")
    assert is_loopback_host("LOCALHOST")
    assert not is_loopback_host("0.0.0.0")
    assert not is_loopback_host("192.168.1.2")
    assert not is_loopback_host("evil.example")


def test_runtime_config_updates_and_pauses() -> None:
    runtime = RuntimeConfig(sensitivity=0.8, fps=2.0)
    snapshot = runtime.snapshot()
    assert snapshot.sensitivity == pytest.approx(0.8)
    assert snapshot.paused is False

    snapshot = runtime.update(sensitivity=0.5, fps=4.0)
    assert snapshot.sensitivity == pytest.approx(0.5)
    assert snapshot.fps == pytest.approx(4.0)

    assert runtime.set_paused(True).paused is True
    assert runtime.snapshot().paused is True

    with pytest.raises(ValueError):
        runtime.update(sensitivity=2.0)
    with pytest.raises(ValueError):
        runtime.update(fps=-1.0)


def test_generate_token_is_random() -> None:
    first = generate_token()
    second = generate_token()
    assert first != second
    assert len(first) >= 32
    assert "=" not in first


def test_bind_socket_chooses_a_free_port() -> None:
    sock = bind_socket("127.0.0.1", 0)
    try:
        port = sock.getsockname()[1]
        assert 0 < port <= 65535
    finally:
        sock.close()


def test_write_ready_file_includes_token_only_when_given(tmp_path: Path) -> None:
    with_token = tmp_path / "ready-token.json"
    write_ready_file(with_token, port=1234, token="secret-token")
    payload = json.loads(with_token.read_text(encoding="utf-8"))
    assert payload == {"port": 1234, "pid": os.getpid(), "token": "secret-token"}

    without_token = tmp_path / "ready.json"
    write_ready_file(without_token, port=5678, token=None)
    payload = json.loads(without_token.read_text(encoding="utf-8"))
    assert payload == {"port": 5678, "pid": os.getpid()}
