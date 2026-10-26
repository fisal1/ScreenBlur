"""Detector abstraction, ONNX classifier backend, and heuristic fallback.

The heuristic detector exists only to exercise the transport and scheduling
pipeline during development. It is not a content classifier and must not be
presented to users as one.
"""

from __future__ import annotations

import logging
import threading
from io import BytesIO
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import numpy as np
from PIL import Image, UnidentifiedImageError

from .config import Settings, default_model_path

logger = logging.getLogger(__name__)

_IMAGENET_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
_MAX_DECODE_PIXELS = 64_000_000


class DetectorError(RuntimeError):
    """Inference failed in a way that should become a protocol error."""


class ImageDecodeError(DetectorError):
    """The frame payload could not be decoded as an image."""


@runtime_checkable
class Detector(Protocol):
    """Anything that can score a JPEG frame.

    ``detect`` is synchronous and CPU/GPU-bound; callers must invoke it in a
    worker thread (``asyncio.to_thread`` / ``run_in_executor``).
    """

    @property
    def id(self) -> str: ...

    def detect(self, jpeg: bytes) -> Detection: ...


class Detection:
    """A single detector output.

    ``score`` is the probability that the frame belongs to the explicit class.
    ``boxes`` is intentionally empty for classifier-only models; ROI/detector
    fusion is a later phase.
    """

    __slots__ = ("boxes", "score")

    def __init__(self, score: float, boxes: list[list[float]] | None = None) -> None:
        self.score = float(score)
        self.boxes: list[list[float]] = [] if boxes is None else boxes


class OnnxClassifierDetector:
    """ImageNet-normalized NCHW classifier backed by ONNX Runtime.

    The ONNX Runtime import happens at first use so the sidecar can run on
    Python versions/platforms without onnxruntime wheels and fall back to the
    heuristic detector.
    """

    def __init__(
        self,
        model_path: Path | str,
        *,
        input_size: int = 224,
        explicit_class_index: int = 1,
    ) -> None:
        self._model_path = Path(model_path)
        self._input_size = int(input_size)
        self._explicit_class_index = int(explicit_class_index)
        self._session: Any | None = None
        self._input_name: str | None = None
        self._input_height = self._input_size
        self._input_width = self._input_size
        self._load_lock = threading.Lock()

    @property
    def id(self) -> str:
        return f"onnx:{self._model_path.stem}"

    @property
    def model_path(self) -> Path:
        return self._model_path

    @property
    def input_size(self) -> int:
        return self._input_size

    @property
    def is_loaded(self) -> bool:
        return self._session is not None

    def load(self) -> None:
        """Create the inference session immediately (used for startup checks)."""
        self._ensure_session()

    def _ensure_session(self) -> Any:
        if self._session is not None:
            return self._session
        with self._load_lock:
            if self._session is not None:
                return self._session
            try:
                import onnxruntime as ort
            except Exception as exc:  # ImportError or a broken native install
                raise DetectorError(
                    "ONNX Runtime is not installed; install requirements-onnx.txt"
                ) from exc

            if not self._model_path.is_file():
                raise DetectorError(f"ONNX model not found: {self._model_path}")

            try:
                options = ort.SessionOptions()
                options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                session = ort.InferenceSession(
                    str(self._model_path),
                    sess_options=options,
                    providers=["CPUExecutionProvider"],
                )
            except Exception as exc:
                raise DetectorError(f"failed to load ONNX model: {_safe_exception(exc)}") from exc

            inputs = session.get_inputs()
            if not inputs:
                raise DetectorError("ONNX model exposes no inputs")
            input_meta = inputs[0]
            self._input_name = str(input_meta.name)

            shape = getattr(input_meta, "shape", None) or []
            if len(shape) >= 4:
                height, width = shape[2], shape[3]
                if isinstance(height, int) and height > 0:
                    self._input_height = height
                if isinstance(width, int) and width > 0:
                    self._input_width = width
                if self._input_height != self._input_size or self._input_width != self._input_size:
                    logger.info(
                        "ONNX model expects %dx%d input; overriding configured size %d",
                        self._input_width,
                        self._input_height,
                        self._input_size,
                    )

            self._session = session
            logger.info(
                "loaded ONNX classifier %s (%dx%d, explicit class %d)",
                self._model_path.name,
                self._input_width,
                self._input_height,
                self._explicit_class_index,
            )
            return session

    def detect(self, jpeg: bytes) -> Detection:
        session = self._ensure_session()
        image = _load_rgb_image(jpeg)
        resized = image.resize(
            (self._input_width, self._input_height),
            Image.Resampling.BILINEAR,
        )
        array = np.asarray(resized, dtype=np.float32) / 255.0
        array = (array - _IMAGENET_MEAN) / _IMAGENET_STD
        tensor = np.ascontiguousarray(array.transpose(2, 0, 1)[np.newaxis, ...])

        try:
            outputs = session.run(None, {self._input_name: tensor})
        except Exception as exc:
            raise DetectorError(f"ONNX inference failed: {_safe_exception(exc)}") from exc

        if not outputs:
            raise DetectorError("ONNX model returned no outputs")
        logits = _as_logits(outputs[0])
        score = _score_from_logits(logits, self._explicit_class_index)
        return Detection(score=score, boxes=[])


class HeuristicDetector:
    """Development-only skin-tone ratio fallback.

    WARNING: this is not an NSFW classifier. It exists so the engine, protocol,
    scheduler, and desktop app can be developed without a model. It can produce
    both false positives and false negatives. The returned box is only a coarse
    union of skin-tone pixels used to place the detected-area overlay.
    """

    id = "heuristic"

    def __init__(self, *, max_dimension: int = 96) -> None:
        self._max_dimension = int(max_dimension)

    def detect(self, jpeg: bytes) -> Detection:
        image = _load_rgb_image(jpeg)
        image.thumbnail((self._max_dimension, self._max_dimension), Image.Resampling.BILINEAR)
        rgb = np.asarray(image, dtype=np.float32)
        if rgb.ndim != 3 or rgb.size == 0:
            return Detection(score=0.0, boxes=[])

        red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        y = 0.299 * red + 0.587 * green + 0.114 * blue
        cb = 128.0 - 0.168736 * red - 0.331264 * green + 0.5 * blue
        cr = 128.0 + 0.5 * red - 0.418688 * green - 0.081312 * blue

        skin = (cb >= 77.0) & (cb <= 127.0) & (cr >= 133.0) & (cr <= 173.0) & (y >= 50.0)
        skin_ratio = float(np.count_nonzero(skin)) / float(skin.size)
        # A large skin-colored region (typical for explicit scenes) saturates the
        # score. The divisor is a deliberate dev-only tuning knob.
        score = float(np.clip(skin_ratio / 0.35, 0.0, 1.0))

        boxes: list[list[float]] = []
        rows, columns = np.nonzero(skin)
        if columns.size > 0:
            height, width = skin.shape
            x1 = float(columns.min()) / float(width)
            y1 = float(rows.min()) / float(height)
            x2 = float(columns.max() + 1) / float(width)
            y2 = float(rows.max() + 1) / float(height)
            boxes.append(
                [
                    round(max(0.0, min(1.0, x1)), 6),
                    round(max(0.0, min(1.0, y1)), 6),
                    round(max(0.0, min(1.0, x2)), 6),
                    round(max(0.0, min(1.0, y2)), 6),
                ]
            )
        return Detection(score=score, boxes=boxes)


class DetectorLoadResult:
    """Selected detector plus any load error surfaced by ready/status/health."""

    __slots__ = ("attempted_onnx", "detector", "error", "model_path")

    def __init__(
        self,
        detector: Detector,
        *,
        error: str | None = None,
        model_path: str | None = None,
        attempted_onnx: bool = False,
    ) -> None:
        self.detector = detector
        self.error = error
        self.model_path = model_path
        self.attempted_onnx = attempted_onnx


def load_detector(settings: Settings, *, force_heuristic: bool = False) -> DetectorLoadResult:
    """Choose ONNX when the model exists and loads; otherwise use the fallback.

    Startup must never fail because of a missing/broken model. The returned
    ``error`` is included in ``ready``/``status``/``/health`` so the desktop app
    can explain why it is running with the heuristic detector.
    """

    path = Path(settings.model_path)

    if force_heuristic:
        logger.info("heuristic detector forced by configuration")
        return DetectorLoadResult(HeuristicDetector(), attempted_onnx=False)

    if not path.is_file():
        error = None
        if _resolved(path) != _resolved(default_model_path()):
            error = f"ONNX model not found: {path}"
        logger.info("no ONNX model at %s; using heuristic detector", path)
        return DetectorLoadResult(
            HeuristicDetector(),
            error=error,
            model_path=str(path),
            attempted_onnx=False,
        )

    detector = OnnxClassifierDetector(
        path,
        input_size=settings.model_input_size,
        explicit_class_index=settings.explicit_class_index,
    )
    try:
        # Validate/load now so `ready` reports the truth. The session itself is
        # also created lazily if this detector is constructed elsewhere.
        detector.load()
    except Exception as exc:
        message = _safe_exception(exc)
        logger.warning(
            "ONNX model %s failed to load (%s); using heuristic detector",
            path.name,
            message,
        )
        return DetectorLoadResult(
            HeuristicDetector(),
            error=message,
            model_path=str(path),
            attempted_onnx=True,
        )

    return DetectorLoadResult(
        detector,
        error=None,
        model_path=str(path),
        attempted_onnx=True,
    )


def _load_rgb_image(jpeg: bytes) -> Image.Image:
    if not jpeg:
        raise ImageDecodeError("frame payload is empty")
    try:
        with Image.open(BytesIO(jpeg)) as image:
            width, height = image.size
            if width <= 0 or height <= 0:
                raise ImageDecodeError("image has invalid dimensions")
            if width * height > _MAX_DECODE_PIXELS:
                raise ImageDecodeError("image dimensions exceed the decode limit")
            return image.convert("RGB")
    except ImageDecodeError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise ImageDecodeError("payload could not be decoded as an image") from exc


def _as_logits(output: Any) -> np.ndarray:
    array = np.asarray(output, dtype=np.float64)
    array = np.squeeze(array)
    if array.ndim == 0:
        array = array.reshape(1)
    elif array.ndim == 2:
        if array.shape[0] == 1:
            array = array[0]
        elif array.shape[1] == 1:
            array = array[:, 0]
        else:
            raise DetectorError(f"unsupported ONNX output shape: {array.shape}")
    elif array.ndim > 2:
        raise DetectorError(f"unsupported ONNX output shape: {array.shape}")
    array = np.ravel(array)
    if array.size == 0:
        raise DetectorError("ONNX model returned an empty output")
    if not np.all(np.isfinite(array)):
        raise DetectorError("ONNX model returned non-finite values")
    return array


def _score_from_logits(logits: np.ndarray, explicit_class_index: int) -> float:
    if logits.size == 1:
        # Single-logit models conventionally emit the explicit-class logit.
        value = float(logits[0])
        if value >= 0:
            score = 1.0 / (1.0 + np.exp(-value))
        else:
            exp_value = np.exp(value)
            score = exp_value / (1.0 + exp_value)
        return float(np.clip(score, 0.0, 1.0))

    if not 0 <= explicit_class_index < logits.size:
        raise DetectorError(
            f"explicit class index {explicit_class_index} is outside the {logits.size}-class output"
        )
    shifted = logits - np.max(logits)
    exponentials = np.exp(shifted)
    probabilities = exponentials / np.sum(exponentials)
    return float(np.clip(probabilities[explicit_class_index], 0.0, 1.0))


def _safe_exception(exc: BaseException) -> str:
    text = str(exc).strip()
    if not text:
        return type(exc).__name__
    return f"{type(exc).__name__}: {text}"[:300]


def _resolved(path: Path) -> Path:
    try:
        return path.resolve()
    except (OSError, RuntimeError):
        return path.absolute()
