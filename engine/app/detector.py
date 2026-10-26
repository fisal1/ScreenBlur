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

# NudeNet v3 (320n / 640m) is a YOLOv8 detector with 18 body-part classes.
# Only exposed classes should trigger a privacy cover; covered/face/feet/
# armpit/belly labels are deliberately ignored.
NUDENET_LABELS = (
    "FEMALE_GENITALIA_COVERED",
    "FACE_FEMALE",
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "FEET_EXPOSED",
    "BELLY_COVERED",
    "FEET_COVERED",
    "ARMPITS_COVERED",
    "ARMPITS_EXPOSED",
    "FACE_MALE",
    "BELLY_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "ANUS_COVERED",
    "FEMALE_BREAST_COVERED",
    "BUTTOCKS_COVERED",
)
NUDENET_EXPLICIT_CLASS_IDS = frozenset({2, 3, 4, 6, 14})
_NUDENET_SCORE_THRESHOLD = 0.25
_NUDENET_IOU_THRESHOLD = 0.45


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

    ``score`` is the probability/confidence that the frame contains explicit
    content. ``boxes`` contains normalized ``[x1, y1, x2, y2]`` regions for
    detector models such as NudeNet; classifier-only models leave it empty.
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
            session = _create_onnx_session(self._model_path)

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


class NudeNetDetector:
    """NudeNet v3 YOLOv8 detector with body-part bounding boxes.

    NudeNet's model expects an RGB ``1 x 3 x H x W`` tensor in ``[0, 1]``.
    The frame is padded to a square at the bottom/right (the same layout as the
    upstream detector), resized to the model input, and the decoded YOLO boxes
    are mapped back to normalized frame coordinates. Only exposed body-part
    labels can trigger a detection; covered and non-explicit labels are ignored.
    """

    def __init__(
        self,
        model_path: Path | str,
        *,
        input_size: int | None = None,
        score_threshold: float = _NUDENET_SCORE_THRESHOLD,
        iou_threshold: float = _NUDENET_IOU_THRESHOLD,
    ) -> None:
        self._model_path = Path(model_path)
        self._configured_input_size = int(input_size) if input_size else None
        self._score_threshold = float(score_threshold)
        self._iou_threshold = float(iou_threshold)
        self._session: Any | None = None
        self._input_name: str | None = None
        self._input_width = 0
        self._input_height = 0
        self._load_lock = threading.Lock()

    @property
    def id(self) -> str:
        return f"nudenet:{self._model_path.stem}"

    @property
    def model_path(self) -> Path:
        return self._model_path

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
            session = _create_onnx_session(self._model_path)

            inputs = session.get_inputs()
            if not inputs:
                raise DetectorError("ONNX model exposes no inputs")
            input_meta = inputs[0]
            self._input_name = str(input_meta.name)

            default_size = self._configured_input_size or _default_nudenet_input_size(
                self._model_path
            )
            self._input_width = default_size
            self._input_height = default_size

            shape = getattr(input_meta, "shape", None) or []
            if len(shape) >= 4:
                height, width = shape[2], shape[3]
                if isinstance(height, int) and height > 0:
                    self._input_height = height
                if isinstance(width, int) and width > 0:
                    self._input_width = width

            if self._input_width <= 0 or self._input_height <= 0:
                raise DetectorError("NudeNet model exposes an invalid input shape")

            self._session = session
            logger.info(
                "loaded NudeNet detector %s (%dx%d, %d explicit classes)",
                self._model_path.name,
                self._input_width,
                self._input_height,
                len(NUDENET_EXPLICIT_CLASS_IDS),
            )
            return session

    def detect(self, jpeg: bytes) -> Detection:
        session = self._ensure_session()
        image = _load_rgb_image(jpeg)
        original_width, original_height = image.size
        padded_size = max(original_width, original_height)

        # Upstream NudeNet pads right/bottom with black, then resizes the square
        # to the model input. Matching that layout keeps boxes aligned.
        canvas = Image.new("RGB", (padded_size, padded_size), (0, 0, 0))
        canvas.paste(image, (0, 0))
        resized = canvas.resize(
            (self._input_width, self._input_height),
            Image.Resampling.BILINEAR,
        )
        array = np.asarray(resized, dtype=np.float32) / 255.0
        tensor = np.ascontiguousarray(array.transpose(2, 0, 1)[np.newaxis, ...])

        try:
            outputs = session.run(None, {self._input_name: tensor})
        except Exception as exc:
            raise DetectorError(f"NudeNet inference failed: {_safe_exception(exc)}") from exc

        if not outputs:
            raise DetectorError("NudeNet model returned no outputs")
        detections = _postprocess_nudenet(
            outputs[0],
            original_width=original_width,
            original_height=original_height,
            padded_size=padded_size,
            input_width=self._input_width,
            input_height=self._input_height,
            score_threshold=self._score_threshold,
            iou_threshold=self._iou_threshold,
        )
        if not detections:
            return Detection(score=0.0, boxes=[])

        score = max(detection[1] for detection in detections)
        boxes = [detection[0] for detection in detections]
        return Detection(score=score, boxes=boxes)


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


def resolve_detector_kind(model_kind: str, model_path: Path | str) -> str:
    """Resolve ``auto`` to a concrete detector adapter.

    Explicit configuration always wins. In auto mode, filenames containing
    ``nudenet``/``yolo`` or the upstream ``320n``/``640m`` names select the
    NudeNet adapter; everything else is treated as the legacy classifier.
    """

    kind = model_kind.strip().lower()
    if kind in {"classifier", "nudenet"}:
        return kind
    name = Path(model_path).name.lower()
    if "nudenet" in name or "yolo" in name or name in {"320n.onnx", "640m.onnx"}:
        return "nudenet"
    return "classifier"


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

    kind = resolve_detector_kind(settings.model_kind, path)
    if kind == "nudenet":
        detector: Detector = NudeNetDetector(path)
    else:
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


def _create_onnx_session(model_path: Path) -> Any:
    try:
        import onnxruntime as ort
    except Exception as exc:  # ImportError or a broken native install
        raise DetectorError("ONNX Runtime is not installed; install requirements-onnx.txt") from exc

    if not model_path.is_file():
        raise DetectorError(f"ONNX model not found: {model_path}")

    try:
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        return ort.InferenceSession(
            str(model_path),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
    except Exception as exc:
        raise DetectorError(f"failed to load ONNX model: {_safe_exception(exc)}") from exc


def _default_nudenet_input_size(model_path: Path) -> int:
    return 640 if "640" in model_path.stem.lower() else 320


def _postprocess_nudenet(
    output: Any,
    *,
    original_width: int,
    original_height: int,
    padded_size: int,
    input_width: int,
    input_height: int,
    score_threshold: float = _NUDENET_SCORE_THRESHOLD,
    iou_threshold: float = _NUDENET_IOU_THRESHOLD,
) -> list[tuple[list[float], float, int]]:
    """Decode YOLO rows into explicit, NMS-filtered, normalized boxes."""

    rows = _yolo_rows(output, expected_columns=4 + len(NUDENET_LABELS))
    candidates: list[tuple[list[float], float, int]] = []
    scale_x = padded_size / float(input_width)
    scale_y = padded_size / float(input_height)

    for row in rows:
        class_scores = row[4:]
        class_id = int(np.argmax(class_scores))
        score = float(class_scores[class_id])
        if score < score_threshold or class_id not in NUDENET_EXPLICIT_CLASS_IDS:
            continue

        center_x, center_y, width, height = (float(value) for value in row[:4])
        x1 = (center_x - width / 2.0) * scale_x
        y1 = (center_y - height / 2.0) * scale_y
        x2 = (center_x + width / 2.0) * scale_x
        y2 = (center_y + height / 2.0) * scale_y

        x1 = max(0.0, min(x1, float(original_width)))
        y1 = max(0.0, min(y1, float(original_height)))
        x2 = max(0.0, min(x2, float(original_width)))
        y2 = max(0.0, min(y2, float(original_height)))
        if x2 <= x1 or y2 <= y1:
            continue
        candidates.append(([x1, y1, x2, y2], score, class_id))

    keep = _nms(
        [candidate[0] for candidate in candidates],
        [candidate[1] for candidate in candidates],
        iou_threshold,
    )
    detections: list[tuple[list[float], float, int]] = []
    for index in keep:
        box, score, class_id = candidates[index]
        normalized = [
            round(max(0.0, min(1.0, box[0] / original_width)), 6),
            round(max(0.0, min(1.0, box[1] / original_height)), 6),
            round(max(0.0, min(1.0, box[2] / original_width)), 6),
            round(max(0.0, min(1.0, box[3] / original_height)), 6),
        ]
        detections.append((normalized, score, class_id))
    return detections


def _yolo_rows(output: Any, *, expected_columns: int) -> np.ndarray:
    array = np.asarray(output, dtype=np.float64)
    array = np.squeeze(array)
    if array.ndim == 1 and array.size == expected_columns:
        array = array.reshape(1, -1)
    if array.ndim == 3 and array.shape[0] == 1:
        array = array[0]
    if array.ndim != 2:
        raise DetectorError(f"unsupported YOLO output shape: {array.shape}")
    if array.shape[1] != expected_columns:
        if array.shape[0] == expected_columns:
            array = array.T
        else:
            raise DetectorError(
                f"YOLO output has {array.shape[1]} columns; expected {expected_columns}"
            )
    if array.size == 0:
        raise DetectorError("YOLO model returned an empty output")
    if not np.all(np.isfinite(array)):
        raise DetectorError("YOLO model returned non-finite values")
    return array


def _nms(
    boxes: list[list[float]],
    scores: list[float],
    iou_threshold: float,
) -> list[int]:
    if not boxes:
        return []
    order = sorted(range(len(scores)), key=scores.__getitem__, reverse=True)
    keep: list[int] = []
    while order:
        index = order.pop(0)
        keep.append(index)
        order = [other for other in order if _box_iou(boxes[index], boxes[other]) <= iou_threshold]
    return keep


def _box_iou(first: list[float], second: list[float]) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    if intersection <= 0.0:
        return 0.0
    first_area = max(0.0, first[2] - first[0]) * max(0.0, first[3] - first[1])
    second_area = max(0.0, second[2] - second[0]) * max(0.0, second[3] - second[1])
    union = first_area + second_area - intersection
    if union <= 0.0:
        return 0.0
    return intersection / union


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
