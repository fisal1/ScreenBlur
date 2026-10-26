"""Wire protocol primitives for the ScreenBlur sidecar.

The binary frame header is fixed at 24 bytes and is fully described in
``docs/protocol.md``::

    offset  size  field
    0       1     version        (uint8,  == 1)
    1       1     msg_type       (uint8,  == 1 for frames)
    2       4     seq            (uint32, big endian)
    6       4     display_id     (uint32, big endian)
    10      8     ts             (uint64, big endian, Unix milliseconds)
    18      4     payload_length (uint32, big endian, JPEG bytes)
    22      2     flags          (uint16, big endian, reserved)

All parsing raises :class:`ProtocolError` with a short, log-safe ``code`` and
``message``. Frame payloads and control-message bodies are never echoed back in
errors or logs.
"""

from __future__ import annotations

import json
import struct
import time
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
MSG_TYPE_FRAME = 1

HEADER_FORMAT = ">BBIIQIH"
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)  # 24

DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_FRAME_BYTES = DEFAULT_MAX_FRAME_BYTES
MAX_CONTROL_MESSAGE_BYTES = 64 * 1024

_JPEG_SOI = b"\xff\xd8"
_JPEG_EOI = b"\xff\xd9"

_HEADER = struct.Struct(HEADER_FORMAT)


class ProtocolError(Exception):
    """A malformed frame or control message.

    ``code`` is a stable machine-readable identifier suitable for an ``error``
    JSON response. The message is deliberately free of frame bytes and secrets.
    """

    def __init__(self, code: str, message: str, *, fatal: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.fatal = fatal

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


@dataclass(frozen=True, slots=True)
class Frame:
    """A validated binary frame received from Electron.

    ``payload_length`` is normally derived from ``payload``. It can be set
    explicitly to build intentionally malformed headers in protocol tests.
    """

    payload: bytes
    seq: int = 0
    display_id: int = 0
    ts: int = 0
    version: int = PROTOCOL_VERSION
    msg_type: int = MSG_TYPE_FRAME
    flags: int = 0
    payload_length: int | None = None

    def __post_init__(self) -> None:
        if self.payload_length is None:
            object.__setattr__(self, "payload_length", len(self.payload))

    @property
    def jpeg(self) -> bytes:
        """Alias used by detector code."""
        return self.payload

    @property
    def size(self) -> int:
        """Total encoded size, including the header."""
        return HEADER_SIZE + len(self.payload)


def now_ms() -> int:
    """Current Unix time in milliseconds."""
    return time.time_ns() // 1_000_000


def parse_frame(data: bytes, *, max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES) -> Frame:
    """Parse and validate a binary WebSocket message.

    Raises :class:`ProtocolError` on any header or JPEG validation failure.
    """

    total = len(data)
    if total < HEADER_SIZE:
        raise ProtocolError(
            "FRAME_TOO_SHORT",
            f"frame is {total} bytes; header requires {HEADER_SIZE}",
        )
    if total > max_frame_bytes:
        raise ProtocolError(
            "FRAME_TOO_LARGE",
            f"frame is {total} bytes; limit is {max_frame_bytes}",
        )

    version, msg_type, seq, display_id, ts, payload_length, flags = _HEADER.unpack_from(data, 0)

    if version != PROTOCOL_VERSION:
        raise ProtocolError(
            "UNSUPPORTED_VERSION",
            f"unsupported protocol version {version}; expected {PROTOCOL_VERSION}",
        )
    if msg_type != MSG_TYPE_FRAME:
        raise ProtocolError(
            "UNSUPPORTED_MSG_TYPE",
            f"unsupported message type {msg_type}; expected {MSG_TYPE_FRAME}",
        )

    actual_payload_length = total - HEADER_SIZE
    if payload_length != actual_payload_length:
        raise ProtocolError(
            "PAYLOAD_LENGTH_MISMATCH",
            f"header declares {payload_length} payload bytes; received {actual_payload_length}",
        )
    if payload_length == 0:
        raise ProtocolError("EMPTY_PAYLOAD", "frame payload is empty")

    payload = data[HEADER_SIZE:]
    if not payload.startswith(_JPEG_SOI):
        raise ProtocolError("INVALID_JPEG", "payload does not start with JPEG SOI marker")
    if not payload.endswith(_JPEG_EOI):
        raise ProtocolError("INVALID_JPEG", "payload does not end with JPEG EOI marker")

    return Frame(
        payload=payload,
        seq=seq,
        display_id=display_id,
        ts=ts,
        version=version,
        msg_type=msg_type,
        flags=flags,
    )


def encode_frame(
    frame: Frame | bytes,
    *,
    seq: int = 0,
    display_id: int = 0,
    ts: int | None = None,
    version: int = PROTOCOL_VERSION,
    msg_type: int = MSG_TYPE_FRAME,
    flags: int = 0,
    payload_length: int | None = None,
) -> bytes:
    """Encode a frame for tests or client fixtures.

    Accepts either a :class:`Frame` or raw JPEG bytes. When raw bytes are given,
    the keyword metadata fields are used; ``ts`` defaults to the current time.
    ``payload_length`` may be overridden to construct intentionally malformed
    frames in protocol tests.
    """

    if isinstance(frame, Frame):
        payload = frame.payload
        seq = frame.seq
        display_id = frame.display_id
        ts = frame.ts
        version = frame.version
        msg_type = frame.msg_type
        flags = frame.flags
        if payload_length is None:
            payload_length = (
                frame.payload_length if frame.payload_length is not None else len(payload)
            )
    else:
        payload = frame
        if ts is None:
            ts = now_ms()

    if payload_length is None:
        payload_length = len(payload)

    _check_uint(seq, 32, "seq")
    _check_uint(display_id, 32, "display_id")
    _check_uint(ts, 64, "ts")
    _check_uint(payload_length, 32, "payload_length")
    _check_uint(version, 8, "version")
    _check_uint(msg_type, 8, "msg_type")
    _check_uint(flags, 16, "flags")

    header = _HEADER.pack(
        version,
        msg_type,
        seq,
        display_id,
        ts,
        payload_length,
        flags,
    )
    return header + bytes(payload)


def parse_control_message(raw: str | bytes) -> dict[str, Any]:
    """Decode a JSON control message and require a non-empty string ``type``."""

    if isinstance(raw, bytes):
        if len(raw) > MAX_CONTROL_MESSAGE_BYTES:
            raise ProtocolError("CONTROL_TOO_LARGE", "control message is too large")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ProtocolError("INVALID_JSON", "control message is not valid UTF-8") from exc
    else:
        text = raw
        if len(text.encode("utf-8", errors="replace")) > MAX_CONTROL_MESSAGE_BYTES:
            raise ProtocolError("CONTROL_TOO_LARGE", "control message is too large")

    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProtocolError("INVALID_JSON", "control message is not valid JSON") from exc

    if not isinstance(value, dict):
        raise ProtocolError("INVALID_CONTROL", "control message must be a JSON object")
    msg_type = value.get("type")
    if not isinstance(msg_type, str) or not msg_type:
        raise ProtocolError("INVALID_CONTROL", "control message requires a string 'type'")
    return value


def _check_uint(value: int, bits: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    if not 0 <= value < (1 << bits):
        raise ValueError(f"{name} must fit in uint{bits}")
