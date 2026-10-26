from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.config import Settings, default_model_path
from app.detector import (
    DetectorError,
    HeuristicDetector,
    ImageDecodeError,
    OnnxClassifierDetector,
    _score_from_logits,
    load_detector,
)


def test_heuristic_score_is_bounded(jpeg_bytes: bytes) -> None:
    detector = HeuristicDetector()
    detection = detector.detect(jpeg_bytes)
    assert detector.id == "heuristic"
    assert 0.0 <= detection.score <= 1.0
    assert len(detection.boxes) == 1
    x1, y1, x2, y2 = detection.boxes[0]
    assert 0.0 <= x1 < x2 <= 1.0
    assert 0.0 <= y1 < y2 <= 1.0


def test_heuristic_box_covers_skin_region() -> None:
    image = Image.new("RGB", (32, 32), (0, 0, 0))
    image.paste((214, 168, 132), (0, 0, 16, 32))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=95)

    detection = HeuristicDetector().detect(buffer.getvalue())
    assert len(detection.boxes) == 1
    x1, y1, x2, y2 = detection.boxes[0]
    assert x1 == pytest.approx(0.0, abs=0.08)
    assert x2 == pytest.approx(0.5, abs=0.08)
    assert y1 == pytest.approx(0.0, abs=0.08)
    assert y2 == pytest.approx(1.0, abs=0.08)


def test_heuristic_black_frame_has_no_box(jpeg_factory) -> None:
    detection = HeuristicDetector().detect(jpeg_factory(color=(0, 0, 0)))
    assert detection.boxes == []


def test_heuristic_skin_tone_scores_higher_than_black(jpeg_factory) -> None:
    detector = HeuristicDetector()
    skin = detector.detect(jpeg_factory(color=(214, 168, 132)))
    black = detector.detect(jpeg_factory(color=(0, 0, 0)))
    assert skin.score > black.score
    assert black.score == pytest.approx(0.0)


def test_heuristic_rejects_invalid_image() -> None:
    with pytest.raises(ImageDecodeError):
        HeuristicDetector().detect(b"not an image")


def test_missing_explicit_model_falls_back(tmp_path: Path) -> None:
    settings = Settings(token="t", model_path=tmp_path / "absent.onnx")
    result = load_detector(settings)
    assert result.detector.id == "heuristic"
    assert result.error is not None
    assert "not found" in result.error.lower()


def test_default_missing_model_falls_back_without_error() -> None:
    if default_model_path().is_file():
        pytest.skip("a real model exists in this checkout")
    settings = Settings(token="t")
    result = load_detector(settings)
    assert result.detector.id == "heuristic"
    assert result.error is None


def test_broken_model_never_crashes_startup(tmp_path: Path) -> None:
    model = tmp_path / "broken.onnx"
    model.write_bytes(b"this is definitely not an ONNX model")
    settings = Settings(token="t", model_path=model)
    result = load_detector(settings)
    assert result.detector.id == "heuristic"
    assert result.error is not None
    assert result.attempted_onnx is True


def test_onnx_detector_is_lazy(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # Constructing the detector must not import onnxruntime or touch the file.
    detector = OnnxClassifierDetector(tmp_path / "missing.onnx")
    assert detector.is_loaded is False
    assert detector.id == "onnx:missing"


def test_single_logit_sigmoid() -> None:
    assert _score_from_logits(np.asarray([0.0]), 1) == pytest.approx(0.5)
    assert _score_from_logits(np.asarray([100.0]), 1) > 0.99
    assert _score_from_logits(np.asarray([-100.0]), 1) < 0.01


def test_multiclass_softmax_and_explicit_index() -> None:
    logits = np.asarray([0.0, 0.0, 0.0])
    assert _score_from_logits(logits, 1) == pytest.approx(1.0 / 3.0)

    logits = np.asarray([10.0, 0.0, 0.0])
    assert _score_from_logits(logits, 0) > 0.99
    assert _score_from_logits(logits, 1) < 0.01


def test_bad_explicit_index_raises() -> None:
    with pytest.raises(DetectorError):
        _score_from_logits(np.asarray([0.0, 0.0]), 5)
