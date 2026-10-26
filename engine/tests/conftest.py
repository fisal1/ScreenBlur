from __future__ import annotations

import io

import pytest
from PIL import Image


def _jpeg(
    size: tuple[int, int] = (32, 32),
    color: tuple[int, int, int] = (214, 168, 132),
    *,
    quality: int = 90,
) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()


@pytest.fixture
def jpeg_factory():
    """Return a callable that produces small real JPEGs."""

    return _jpeg


@pytest.fixture
def jpeg_bytes() -> bytes:
    return _jpeg()


@pytest.fixture
def black_jpeg() -> bytes:
    return _jpeg(color=(0, 0, 0))
