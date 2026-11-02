import argparse
import asyncio
import csv
import json
import math
import os
import statistics
import sys
import time
import uuid
from pathlib import Path

import websockets
from PIL import Image, ImageOps

try:
    import resource
except ImportError:
    resource = None

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 4 * 1024 * 1024


def percentile(values, percentile_value):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil(percentile_value * len(ordered)) - 1)
    return round(ordered[index], 3)


def prepare_jpeg(image_path, width, height):
    with Image.open(image_path) as source:
        image = ImageOps.contain(source.convert("RGB"), (width, height))
        frame = Image.new("RGB", (width, height), (0, 0, 0))
        frame.paste(image, (0, 0))
        content_width, content_height = image.size
        from io import BytesIO

        output = BytesIO()
        frame.save(output, format="JPEG", quality=82)
        return output.getvalue(), content_width, content_height


def read_annotations(path):
    if not path:
        return {}
    with open(path, encoding="utf-8") as file:
        annotations = json.load(file)
    if not isinstance(annotations, dict):
        raise ValueError("Annotation file must map image names to arrays of normalized boxes")
    return annotations


def box_iou(left, right):
    x1, y1 = max(left["x"], right["x"]), max(left["y"], right["y"])
    x2 = min(left["x"] + left["width"], right["x"] + right["width"])
    y2 = min(left["y"] + left["height"], right["y"] + right["height"])
    intersection = max(0, x2 - x1) * max(0, y2 - y1)
    union = left["width"] * left["height"] + right["width"] * right["height"] - intersection
    return intersection / union if union else 0


def evaluate_annotations(rows, annotations):
    true_positive = false_positive = false_negative = 0
    ious = []
    for row in rows:
        expected = annotations.get(row["image"], [])
        detections = row["regions"]
        matched = set()
        for detection in detections:
            best_index = None
            best_iou = 0.5
            for index, truth in enumerate(expected):
                overlap = box_iou(detection, truth)
                if index not in matched and overlap >= best_iou:
                    best_iou, best_index = overlap, index
            if best_index is None:
                false_positive += 1
            else:
                matched.add(best_index)
                true_positive += 1
                ious.append(best_iou)
        false_negative += len(expected) - len(matched)
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "precision": round(true_positive / (true_positive + false_positive), 4)
        if true_positive + false_positive else None,
        "recall": round(true_positive / (true_positive + false_negative), 4)
        if true_positive + false_negative else None,
        "matchedMeanIoU": round(statistics.mean(ious), 4) if ious else None,
    }


async def run(args):
    token = os.environ.get("SCREENBLUR_BEARER_TOKEN")
    if not token:
        raise ValueError("Set SCREENBLUR_BEARER_TOKEN in the environment")
    paths = sorted(
        path for path in Path(args.corpus).rglob("*")
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )
    if not paths:
        raise ValueError("Corpus contains no supported image files")

    annotations = read_annotations(args.annotations)
    rows = []
    started = time.perf_counter()
    cpu_started = time.process_time()
    async with websockets.connect(
        args.endpoint,
        max_size=MAX_FRAME_BYTES + 64 * 1024,
        open_timeout=10,
        close_timeout=3,
    ) as websocket:
        await websocket.send(json.dumps({
            "type": "auth",
            "protocolVersion": PROTOCOL_VERSION,
            "token": token,
        }))
        ready = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
        if ready.get("type") != "ready" or ready.get("protocolVersion") != PROTOCOL_VERSION:
            raise RuntimeError(f"Service did not accept the protocol/authentication: {ready}")

        for seq in range(1, args.count + 1):
            image_path = paths[(seq - 1) % len(paths)]
            payload, content_width, content_height = prepare_jpeg(image_path, args.width, args.height)
            if len(payload) > MAX_FRAME_BYTES:
                raise ValueError(f"{image_path} encoded above the 4 MiB frame limit")
            capture_time_ms = time.time() * 1000
            correlation_id = str(uuid.uuid4())
            request = {
                "type": "frame",
                "protocolVersion": PROTOCOL_VERSION,
                "sessionId": ready["sessionId"],
                "correlationId": correlation_id,
                "seq": seq,
                "captureTimestampMs": capture_time_ms,
                "sceneChange": 1.0,
                "width": args.width,
                "height": args.height,
                "contentWidth": content_width,
                "contentHeight": content_height,
                "format": "jpeg",
                "payloadBytes": len(payload),
            }
            send_started = time.perf_counter()
            await websocket.send(json.dumps(request))
            await websocket.send(payload)
            send_ms = (time.perf_counter() - send_started) * 1000

            response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=args.timeout))
            while response.get("type") == "ping":
                await websocket.send(json.dumps({"type": "pong"}))
                response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=args.timeout))
            if response.get("type") != "result":
                raise RuntimeError(f"Inference failed for frame {seq}: {response}")
            if response.get("seq") != seq or response.get("correlationId") != correlation_id:
                raise RuntimeError(f"Out-of-order response for frame {seq}: {response}")
            rows.append({
                "seq": seq,
                "image": image_path.name,
                "uploadBytes": len(payload),
                "sendEnqueueMs": round(send_ms, 3),
                "roundTripMs": round((time.perf_counter() - send_started) * 1000, 3),
                "inferenceMs": round(response["inferenceMs"], 3),
                "score": response["score"],
                "decision": response["decision"],
                "regions": [region["box"] for region in response["regions"]],
            })
            if args.rate > 0:
                await asyncio.sleep(max(0, 1 / args.rate - (time.perf_counter() - send_started)))

    elapsed = time.perf_counter() - started
    cpu_seconds = time.process_time() - cpu_started
    max_rss = None
    if resource:
        max_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if sys.platform != "darwin":
            max_rss *= 1024
    rtts = [row["roundTripMs"] for row in rows]
    inference = [row["inferenceMs"] for row in rows]
    summary = {
        "endpoint": args.endpoint,
        "modelVersion": ready["modelVersion"],
        "backend": ready.get("backend"),
        "frames": len(rows),
        "elapsedSeconds": round(elapsed, 3),
        "framesPerSecond": round(len(rows) / elapsed, 3) if elapsed else 0,
        "uploadBytesTotal": sum(row["uploadBytes"] for row in rows),
        "rttMs": {
            "p50": percentile(rtts, 0.50),
            "p95": percentile(rtts, 0.95),
            "p99": percentile(rtts, 0.99),
        },
        "inferenceMs": {
            "p50": percentile(inference, 0.50),
            "p95": percentile(inference, 0.95),
            "p99": percentile(inference, 0.99),
        },
        "clientCpuPercent": round(100 * cpu_seconds / elapsed, 2) if elapsed else 0,
        "clientMaxRssBytes": max_rss,
        "accuracy": evaluate_annotations(rows, annotations) if annotations else None,
        "samples": rows,
    }
    output = Path(args.output)
    if output.suffix.lower() == ".csv":
        with output.open("w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=[
                "seq", "image", "uploadBytes", "sendEnqueueMs", "roundTripMs",
                "inferenceMs", "score", "decision", "regions",
            ])
            writer.writeheader()
            for row in rows:
                writer.writerow({**row, "regions": json.dumps(row["regions"])})
        summary_output = output.with_suffix(".summary.json")
        summary_output.write_text(json.dumps({key: value for key, value in summary.items() if key != "samples"}, indent=2))
    else:
        output.write_text(json.dumps(summary, indent=2))
    print(json.dumps({key: value for key, value in summary.items() if key != "samples"}, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Replay a local image corpus against ScreenBlur inference")
    parser.add_argument("--endpoint", default="ws://127.0.0.1:8000/v1/inference/stream")
    parser.add_argument("--corpus", required=True, help="Local directory of frames to replay")
    parser.add_argument("--annotations", help="Optional JSON file mapping image names to normalized truth boxes")
    parser.add_argument("--output", default="screenblur-benchmark.json", help="JSON or CSV output path")
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--rate", type=float, default=2, help="Maximum replay rate in frames per second")
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=544)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    if args.count < 1 or args.rate < 0:
        parser.error("--count must be positive and --rate cannot be negative")
    if args.width % 32 or args.height % 32:
        parser.error("--width and --height must be multiples of 32")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
