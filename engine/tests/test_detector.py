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
    NudeNetDetector,
    OnnxClassifierDetector,
    _postprocess_nudenet,
    _score_from_logits,
    load_detector,
    resolve_detector_kind,
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


def test_auto_detector_kind_from_filename() -> None:
    assert resolve_detector_kind("auto", Path("nudenet-320n.onnx")) == "nudenet"
    assert resolve_detector_kind("auto", Path("640m.onnx")) == "nudenet"
    assert resolve_detector_kind("auto", Path("nsfw.onnx")) == "classifier"
    assert resolve_detector_kind("classifier", Path("nudenet.onnx")) == "classifier"
    assert resolve_detector_kind("nudenet", Path("renamed.onnx")) == "nudenet"


def test_nudenet_detector_is_lazy(tmp_path: Path) -> None:
    detector = NudeNetDetector(tmp_path / "nudenet-320n.onnx")
    assert detector.is_loaded is False
    assert detector.id == "nudenet:nudenet-320n"


def _nudenet_output(rows: list[list[float]]) -> np.ndarray:
    output = np.zeros((1, 22, len(rows)), dtype=np.float32)
    for column, row in enumerate(rows):
        output[0, :, column] = np.asarray(row, dtype=np.float32)
    return output


def _nudenet_row(
    *,
    center_x: float,
    center_y: float,
    width: float,
    height: float,
    class_id: int,
    score: float,
) -> list[float]:
    row = [center_x, center_y, width, height] + [0.0] * 18
    row[4 + class_id] = score
    return row


def test_nudenet_postprocess_maps_and_normalizes_box() -> None:
    output = _nudenet_output(
        [
            _nudenet_row(
                center_x=160,
                center_y=80,
                width=64,
                height=64,
                class_id=4,
                score=0.9,
            )
        ]
    )
    detections = _postprocess_nudenet(
        output,
        original_width=200,
        original_height=100,
        padded_size=200,
        input_width=320,
        input_height=320,
    )
    assert len(detections) == 1
    box, score, class_id = detections[0]
    assert score == pytest.approx(0.9)
    assert class_id == 4
    assert box == pytest.approx([0.4, 0.3, 0.6, 0.7])


def test_nudenet_postprocess_ignores_covered_classes() -> None:
    output = _nudenet_output(
        [
            _nudenet_row(
                center_x=160,
                center_y=80,
                width=64,
                height=64,
                class_id=0,
                score=0.99,
            )
        ]
    )
    assert (
        _postprocess_nudenet(
            output,
            original_width=320,
            original_height=320,
            padded_size=320,
            input_width=320,
            input_height=320,
        )
        == []
    )


def test_nudenet_postprocess_applies_nms() -> None:
    output = _nudenet_output(
        [
            _nudenet_row(
                center_x=160,
                center_y=160,
                width=100,
                height=100,
                class_id=3,
                score=0.9,
            ),
            _nudenet_row(
                center_x=165,
                center_y=160,
                width=100,
                height=100,
                class_id=3,
                score=0.8,
            ),
        ]
    )
    detections = _postprocess_nudenet(
        output,
        original_width=320,
        original_height=320,
        padded_size=320,
        input_width=320,
        input_height=320,
    )
    assert len(detections) == 1
    assert detections[0][1] == pytest.approx(0.9)


def test_nudenet_postprocess_rejects_wrong_column_count() -> None:
    with pytest.raises(DetectorError):
        _postprocess_nudenet(
            np.zeros((1, 21, 1), dtype=np.float32),
            original_width=320,
            original_height=320,
            padded_size=320,
            input_width=320,
            input_height=320,
        )


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
