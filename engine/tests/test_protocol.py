from __future__ import annotations

import pytest

from app.protocol import (
    HEADER_SIZE,
    PROTOCOL_VERSION,
    Frame,
    ProtocolError,
    encode_frame,
    now_ms,
    parse_control_message,
    parse_frame,
)


def test_header_is_exactly_24_bytes() -> None:
    assert HEADER_SIZE == 24


def test_frame_roundtrip(jpeg_bytes: bytes) -> None:
    timestamp = now_ms()
    frame = Frame(payload=jpeg_bytes, seq=123, display_id=2, ts=timestamp, flags=0)
    encoded = encode_frame(frame)

    assert len(encoded) == HEADER_SIZE + len(jpeg_bytes)
    parsed = parse_frame(encoded)
    assert parsed == frame
    assert parsed.version == PROTOCOL_VERSION
    assert parsed.size == len(encoded)


def test_encode_raw_payload_defaults_to_current_time(jpeg_bytes: bytes) -> None:
    before = now_ms()
    encoded = encode_frame(jpeg_bytes, seq=7, display_id=3)
    after = now_ms()
    frame = parse_frame(encoded)
    assert frame.seq == 7
    assert frame.display_id == 3
    assert before <= frame.ts <= after


def test_encode_rejects_out_of_range_fields(jpeg_bytes: bytes) -> None:
    with pytest.raises(ValueError):
        encode_frame(jpeg_bytes, seq=2**32)
    with pytest.raises(ValueError):
        encode_frame(jpeg_bytes, flags=2**16)


@pytest.mark.parametrize(
    ("data", "code"),
    [
        (b"\x00" * 4, "FRAME_TOO_SHORT"),
        (b"\xff\xd8\xff\xd9", "FRAME_TOO_SHORT"),
    ],
)
def test_rejects_short_frames(data: bytes, code: str) -> None:
    with pytest.raises(ProtocolError) as excinfo:
        parse_frame(data)
    assert excinfo.value.code == code


def test_rejects_wrong_version(jpeg_bytes: bytes) -> None:
    data = encode_frame(Frame(payload=jpeg_bytes, version=2))
    with pytest.raises(ProtocolError, match="unsupported protocol version"):
        parse_frame(data)


def test_rejects_wrong_message_type(jpeg_bytes: bytes) -> None:
    data = encode_frame(Frame(payload=jpeg_bytes, msg_type=2))
    with pytest.raises(ProtocolError) as excinfo:
        parse_frame(data)
    assert excinfo.value.code == "UNSUPPORTED_MSG_TYPE"


def test_rejects_payload_length_mismatch(jpeg_bytes: bytes) -> None:
    data = encode_frame(jpeg_bytes, seq=1, payload_length=len(jpeg_bytes) + 10)
    with pytest.raises(ProtocolError) as excinfo:
        parse_frame(data)
    assert excinfo.value.code == "PAYLOAD_LENGTH_MISMATCH"


def test_rejects_oversized_frame(jpeg_bytes: bytes) -> None:
    data = encode_frame(Frame(payload=jpeg_bytes, seq=1))
    with pytest.raises(ProtocolError) as excinfo:
        parse_frame(data, max_frame_bytes=len(data) - 1)
    assert excinfo.value.code == "FRAME_TOO_LARGE"


def test_rejects_empty_payload() -> None:
    data = encode_frame(Frame(payload=b"", seq=1))
    with pytest.raises(ProtocolError) as excinfo:
        parse_frame(data)
    assert excinfo.value.code == "EMPTY_PAYLOAD"


def test_rejects_missing_jpeg_soi() -> None:
    data = encode_frame(Frame(payload=b"not-a-jpeg\xff\xd9", seq=1))
    with pytest.raises(ProtocolError) as excinfo:
        parse_frame(data)
    assert excinfo.value.code == "INVALID_JPEG"
    assert "SOI" in excinfo.value.message


def test_rejects_missing_jpeg_eoi() -> None:
    data = encode_frame(Frame(payload=b"\xff\xd8not-a-jpeg", seq=1))
    with pytest.raises(ProtocolError) as excinfo:
        parse_frame(data)
    assert excinfo.value.code == "INVALID_JPEG"
    assert "EOI" in excinfo.value.message


def test_parse_control_message() -> None:
    assert parse_control_message('{"type": "ping", "id": 1}') == {"type": "ping", "id": 1}
    assert parse_control_message(b'{"type": "pause"}') == {"type": "pause"}


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("{", "INVALID_JSON"),
        ("[]", "INVALID_CONTROL"),
        ('{"id": 1}', "INVALID_CONTROL"),
        ('{"type": ""}', "INVALID_CONTROL"),
        (b"\xff\xfe", "INVALID_JSON"),
    ],
)
def test_parse_control_message_errors(raw: str | bytes, code: str) -> None:
    with pytest.raises(ProtocolError) as excinfo:
        parse_control_message(raw)
    assert excinfo.value.code == code
