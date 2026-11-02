import math
from dataclasses import dataclass

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_FRAME_DIMENSION = 2048
MAX_DETECTIONS = 20
MIN_SCORE = 0.1
IOU_THRESHOLD = 0.45
PADDING = 0.2
MOSAIC_CELLS = 10

LABELS = (
    "FEMALE_GENITALIA_COVERED", "FACE_FEMALE", "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED", "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED", "ANUS_EXPOSED", "FEET_EXPOSED", "BELLY_COVERED",
    "FEET_COVERED", "ARMPITS_COVERED", "ARMPITS_EXPOSED", "FACE_MALE",
    "BELLY_EXPOSED", "MALE_GENITALIA_EXPOSED", "ANUS_COVERED",
    "FEMALE_BREAST_COVERED", "BUTTOCKS_COVERED",
)
EXPLICIT_LABELS = (
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "ANUS_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
)
EXPLICIT_CLASS_IDS = tuple(LABELS.index(label) for label in EXPLICIT_LABELS)


@dataclass(frozen=True)
class FrameMetadata:
    protocol_version: int
    session_id: str
    correlation_id: str
    seq: int
    capture_timestamp_ms: float
    width: int
    height: int
    content_width: int
    content_height: int
    payload_bytes: int
    scene_change: float
    format: str


def parse_frame_metadata(message, session_id, last_seq):
    if not isinstance(message, dict) or message.get("type") != "frame":
        raise ValueError("Expected a frame metadata message")
    try:
        metadata = FrameMetadata(
            protocol_version=message["protocolVersion"],
            session_id=message["sessionId"],
            correlation_id=message["correlationId"],
            seq=message["seq"],
            capture_timestamp_ms=message["captureTimestampMs"],
            width=message["width"],
            height=message["height"],
            content_width=message["contentWidth"],
            content_height=message["contentHeight"],
            payload_bytes=message["payloadBytes"],
            scene_change=message["sceneChange"],
            format=message["format"],
        )
    except (KeyError, TypeError) as error:
        raise ValueError(f"Missing or invalid frame metadata: {error}") from error

    if type(metadata.protocol_version) is not int or metadata.protocol_version != PROTOCOL_VERSION:
        raise ValueError("Unsupported protocol version")
    if metadata.session_id != session_id:
        raise ValueError("Session ID does not match this connection")
    if not isinstance(metadata.correlation_id, str) or not 1 <= len(metadata.correlation_id) <= 128:
        raise ValueError("Invalid correlation ID")
    if type(metadata.seq) is not int or metadata.seq <= last_seq:
        raise ValueError("Sequence ID must increase for each frame")
    if (
        isinstance(metadata.capture_timestamp_ms, bool)
        or not isinstance(metadata.capture_timestamp_ms, (int, float))
        or not math.isfinite(metadata.capture_timestamp_ms)
        or metadata.capture_timestamp_ms <= 0
    ):
        raise ValueError("Invalid capture timestamp")
    if type(metadata.width) is not int or type(metadata.height) is not int:
        raise ValueError("Invalid frame dimensions")
    if (
        not 32 <= metadata.width <= MAX_FRAME_DIMENSION
        or not 32 <= metadata.height <= MAX_FRAME_DIMENSION
        or metadata.width % 32
        or metadata.height % 32
    ):
        raise ValueError("Frame dimensions must be multiples of 32 and no larger than 2048")
    if (
        type(metadata.content_width) is not int
        or type(metadata.content_height) is not int
        or not 1 <= metadata.content_width <= metadata.width
        or not 1 <= metadata.content_height <= metadata.height
    ):
        raise ValueError("Invalid content dimensions")
    if type(metadata.payload_bytes) is not int or not 1 <= metadata.payload_bytes <= MAX_FRAME_BYTES:
        raise ValueError("Invalid payload size")
    if (
        isinstance(metadata.scene_change, bool)
        or not isinstance(metadata.scene_change, (int, float))
        or not math.isfinite(metadata.scene_change)
        or not 0 <= metadata.scene_change <= 1
    ):
        raise ValueError("Invalid scene-change value")
    if metadata.format != "jpeg":
        raise ValueError("Only JPEG frames are supported")

    return metadata


def box_iou(left, right):
    x1 = max(left[0], right[0])
    y1 = max(left[1], right[1])
    x2 = min(left[0] + left[2], right[0] + right[2])
    y2 = min(left[1] + left[3], right[1] + right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = left[2] * left[3] + right[2] * right[3] - intersection
    return intersection / union if union > 0 else 0.0


def round_half_up(value):
    return math.floor(value + 0.5)


def decode_detections(output, width, height, content_width, content_height):
    _, channels, anchors = output.dims
    expected_channels = 4 + len(LABELS)
    if channels != expected_channels or len(output.data) != channels * anchors:
        raise ValueError("Unexpected NudeNet output tensor shape")

    data = output.data
    candidates = []
    score = 0.0
    label = None
    for anchor in range(anchors):
        best_score = 0.0
        best_class = -1
        for class_id in EXPLICIT_CLASS_IDS:
            confidence = float(data[(4 + class_id) * anchors + anchor])
            if confidence > best_score:
                best_score = confidence
                best_class = class_id
        if best_score > score:
            score = best_score
            label = LABELS[best_class]
        if best_score < MIN_SCORE:
            continue

        cx = float(data[anchor])
        cy = float(data[anchors + anchor])
        box_width = float(data[2 * anchors + anchor])
        box_height = float(data[3 * anchors + anchor])
        if (
            not all(math.isfinite(value) for value in (cx, cy, box_width, box_height))
            or box_width <= 0
            or box_height <= 0
        ):
            continue
        candidates.append({
            "score": best_score,
            "label": LABELS[best_class],
            "box": [cx - box_width / 2, cy - box_height / 2, box_width, box_height],
        })

    candidates.sort(key=lambda item: item["score"], reverse=True)
    kept = []
    for candidate in candidates:
        if len(kept) >= MAX_DETECTIONS:
            break
        if all(box_iou(candidate["box"], other["box"]) < IOU_THRESHOLD for other in kept):
            kept.append(candidate)

    regions = []
    for detection in kept:
        x, y, box_width, box_height = detection["box"]
        x1 = max(0.0, x - box_width * PADDING)
        y1 = max(0.0, y - box_height * PADDING)
        x2 = min(content_width, x + box_width * (1 + PADDING))
        y2 = min(content_height, y + box_height * (1 + PADDING))
        if x2 <= x1 or y2 <= y1:
            continue
        regions.append({
            "score": detection["score"],
            "label": detection["label"],
            "box": {
                "x": x1 / content_width,
                "y": y1 / content_height,
                "width": (x2 - x1) / content_width,
                "height": (y2 - y1) / content_height,
            },
            "pixelBox": [x1, y1, x2 - x1, y2 - y1],
        })
    return score, label, regions


def make_mosaic(image, box):
    x, y, width, height = box
    long_side = max(width, height)
    cols = max(1, round_half_up(MOSAIC_CELLS * width / long_side))
    rows = max(1, round_half_up(MOSAIC_CELLS * height / long_side))
    cell_width = width / cols
    cell_height = height / rows
    step = max(1, math.floor(min(cell_width, cell_height) / 4))
    pixels = []
    for row in range(rows):
        for col in range(cols):
            x0 = math.floor(x + col * cell_width)
            y0 = math.floor(y + row * cell_height)
            x1 = max(x0 + 1, math.floor(x + (col + 1) * cell_width))
            y1 = max(y0 + 1, math.floor(y + (row + 1) * cell_height))
            samples = [
                image.getpixel((sample_x, sample_y))
                for sample_y in range(y0, min(y1, image.height), step)
                for sample_x in range(x0, min(x1, image.width), step)
            ]
            count = max(1, len(samples))
            pixels.extend(
                [
                    round_half_up(sum(sample[0] for sample in samples) / count),
                    round_half_up(sum(sample[1] for sample in samples) / count),
                    round_half_up(sum(sample[2] for sample in samples) / count),
                    255,
                ]
            )
    return {"cols": cols, "rows": rows, "data": pixels}
