"""Process settings, environment parsing, and live runtime configuration."""

from __future__ import annotations

import ipaddress
import logging
import math
import os
import re
import secrets
import sys
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from .protocol import DEFAULT_MAX_FRAME_BYTES, HEADER_SIZE, PROTOCOL_VERSION

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
_LOG_FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"
_TOKEN_RE = re.compile(r"(?i)(token=)[^\s&\"']+")
_BEARER_RE = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+")


def redact_token(text: str) -> str:
    """Remove credentials from a log line.

    Uvicorn logs WebSocket handshakes with the request target, which may contain
    a ``?token=`` query parameter. The desktop app redacts its own copy, but the
    engine must never emit the secret either.
    """

    text = _TOKEN_RE.sub(r"\1[redacted]", text)
    return _BEARER_RE.sub(r"\1[redacted]", text)


class _RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact_token(super().format(record))


def default_model_path() -> Path:
    """Return the conventional ONNX model location.

    Supports both a source checkout (``engine/models/nsfw.onnx``) and a
    PyInstaller one-file build (bundled data in ``sys._MEIPASS``, or a model
    dropped next to the executable).
    """

    source_default = Path(__file__).resolve().parents[1] / "models" / "nsfw.onnx"
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidates.append(Path(meipass) / "models" / "nsfw.onnx")
        candidates.append(Path(sys.executable).resolve().parent / "models" / "nsfw.onnx")
    candidates.append(source_default)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return candidates[0]


def generate_token() -> str:
    """Generate a per-launch bearer token (URL-safe, 256 bits of entropy)."""
    return secrets.token_urlsafe(32)


def is_loopback_host(host: str) -> bool:
    """True when *host* is unambiguously a loopback address."""

    normalized = host.strip().lower()
    if normalized in LOOPBACK_HOSTS:
        return True
    if normalized.startswith("[") and normalized.endswith("]"):
        normalized = normalized[1:-1]
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    if address.is_loopback:
        return True
    mapped = getattr(address, "ipv4_mapped", None)
    return bool(mapped and mapped.is_loopback)


def host_for_bind(host: str) -> str:
    """Normalize a validated host for :func:`socket.bind`."""
    normalized = host.strip()
    if normalized.startswith("[") and normalized.endswith("]"):
        normalized = normalized[1:-1]
    return "127.0.0.1" if normalized.lower() == "localhost" else normalized


@dataclass(frozen=True, slots=True)
class Settings:
    """Immutable startup settings composed from environment + CLI."""

    host: str = "127.0.0.1"
    port: int = 0
    token: str | None = None
    model_path: Path = field(default_factory=default_model_path)
    model_input_size: int = 224
    explicit_class_index: int = 1
    sensitivity: float = 0.8
    fps: float = 2.0
    max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES
    log_level: str = "info"
    ready_file: Path | None = None

    def validate(self) -> None:
        """Validate invariants. Raises ``ValueError`` (never including secrets)."""
        if not is_loopback_host(self.host):
            raise ValueError("host must be a loopback address (127.0.0.1, ::1, or localhost)")
        if not 0 <= self.port <= 65535:
            raise ValueError("port must be between 0 and 65535")
        if self.token is not None and not self.token:
            raise ValueError("token must not be empty when supplied")
        if not 32 <= self.model_input_size <= 4096:
            raise ValueError("model input size must be between 32 and 4096")
        if not 0 <= self.explicit_class_index <= 4096:
            raise ValueError("explicit class index must be a non-negative integer")
        if not math.isfinite(self.sensitivity) or not 0.0 <= self.sensitivity <= 1.0:
            raise ValueError("sensitivity must be between 0.0 and 1.0")
        if not math.isfinite(self.fps) or not 0.0 < self.fps <= 240.0:
            raise ValueError("fps must be greater than 0 and at most 240")
        if self.max_frame_bytes < HEADER_SIZE + 2:
            raise ValueError(f"max frame bytes must be at least {HEADER_SIZE + 2}")
        if self.log_level.lower() not in {"debug", "info", "warning", "error", "critical"}:
            raise ValueError("log level must be debug, info, warning, error, or critical")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        """Build settings from ``SCREENBLUR_*`` environment variables."""
        values = os.environ if env is None else env

        host = values.get("SCREENBLUR_HOST", "127.0.0.1").strip() or "127.0.0.1"
        port = _env_int(values, "SCREENBLUR_PORT", 0)
        token = values.get("SCREENBLUR_TOKEN") or None
        model_path = _env_path(values, "SCREENBLUR_MODEL_PATH") or default_model_path()
        ready_file = _env_path(values, "SCREENBLUR_READY_FILE")
        settings = cls(
            host=host,
            port=port,
            token=token,
            model_path=model_path,
            model_input_size=_env_int(values, "SCREENBLUR_MODEL_INPUT_SIZE", 224),
            explicit_class_index=_env_int(values, "SCREENBLUR_EXPLICIT_CLASS_INDEX", 1),
            sensitivity=_env_float(values, "SCREENBLUR_SENSITIVITY", 0.8),
            fps=_env_float(values, "SCREENBLUR_FPS", 2.0),
            max_frame_bytes=_env_int(values, "SCREENBLUR_MAX_FRAME_BYTES", DEFAULT_MAX_FRAME_BYTES),
            log_level=values.get("SCREENBLUR_LOG_LEVEL", "info").strip().lower() or "info",
            ready_file=ready_file,
        )
        settings.validate()
        return settings

    @property
    def protocol(self) -> int:
        return PROTOCOL_VERSION


def _env_int(values: Mapping[str, str], name: str, default: int) -> int:
    raw = values.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip(), 10)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc


def _env_float(values: Mapping[str, str], name: str, default: float) -> float:
    raw = values.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw.strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return value


def _env_path(values: Mapping[str, str], name: str) -> Path | None:
    raw = values.get(name)
    if raw is None or not raw.strip():
        return None
    return Path(raw.strip()).expanduser()


@dataclass(frozen=True, slots=True)
class RuntimeSnapshot:
    """A consistent snapshot of live, client-adjustable settings."""

    sensitivity: float = 0.8
    fps: float = 2.0
    paused: bool = False

    def to_dict(self) -> dict[str, float | bool]:
        return {
            "sensitivity": self.sensitivity,
            "fps": self.fps,
            "paused": self.paused,
        }


class RuntimeConfig:
    """Thread-safe live configuration shared by the WS and health handlers.

    Access is cheap and lock-protected so a future inference thread can safely
    read settings without touching ``asyncio`` primitives.
    """

    __slots__ = ("_fps", "_lock", "_paused", "_sensitivity")

    def __init__(self, *, sensitivity: float = 0.8, fps: float = 2.0, paused: bool = False) -> None:
        self._lock = threading.Lock()
        self._sensitivity = float(sensitivity)
        self._fps = float(fps)
        self._paused = bool(paused)

    def snapshot(self) -> RuntimeSnapshot:
        with self._lock:
            return RuntimeSnapshot(
                sensitivity=self._sensitivity,
                fps=self._fps,
                paused=self._paused,
            )

    def update(
        self,
        *,
        sensitivity: float | None = None,
        fps: float | None = None,
    ) -> RuntimeSnapshot:
        if sensitivity is not None:
            if not math.isfinite(sensitivity) or not 0.0 <= sensitivity <= 1.0:
                raise ValueError("sensitivity must be between 0.0 and 1.0")
        if fps is not None:
            if not math.isfinite(fps) or not 0.0 < fps <= 240.0:
                raise ValueError("fps must be greater than 0 and at most 240")
        with self._lock:
            if sensitivity is not None:
                self._sensitivity = float(sensitivity)
            if fps is not None:
                self._fps = float(fps)
            return RuntimeSnapshot(
                sensitivity=self._sensitivity,
                fps=self._fps,
                paused=self._paused,
            )

    def set_paused(self, paused: bool) -> RuntimeSnapshot:
        with self._lock:
            self._paused = bool(paused)
            return RuntimeSnapshot(
                sensitivity=self._sensitivity,
                fps=self._fps,
                paused=self._paused,
            )


def configure_logging(level: str = "info") -> None:
    """Configure root logging without ever enabling token-bearing access logs."""

    handler = logging.StreamHandler()
    handler.setFormatter(_RedactingFormatter(_LOG_FORMAT))
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        handlers=[handler],
        force=True,
    )
    # Uvicorn access logs include the request target. The token may be supplied
    # as a query parameter, so access logging is disabled defensively here as
    # well as via ``access_log=False`` in main.
    logging.getLogger("uvicorn.access").disabled = True
