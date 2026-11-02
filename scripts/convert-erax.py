# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["ultralytics==8.3.*", "onnx", "onnxslim"]
# ///
"""Converts the EraX-Anti-NSFW v1.1 YOLO11 weights (PyTorch) to ONNX for ScreenBlur.

Usage:  uv run scripts/convert-erax.py [n s m]

Downloads each .pt file from Hugging Face (erax-ai/EraX-Anti-NSFW-V1.1), exports it with
dynamic input size (any multiple of 32, like NudeNet) and writes models/erax-yolo11{size}.onnx.
Prints the class names and SHA256 of each file for src/inference/models.js and fetch-model.js.

Note: .pt files are Python pickles and run code when loaded; only convert weights from a
source you trust.
"""

import hashlib
import shutil
import sys
import urllib.request
from pathlib import Path

from ultralytics import YOLO

REPO = "https://huggingface.co/erax-ai/EraX-Anti-NSFW-V1.1/resolve/main"
ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "models" / "erax-work"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def convert(size: str) -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    weights = WORK / f"erax-anti-nsfw-yolo11{size}-v1.1.pt"
    if not weights.exists():
        print(f"Downloading {weights.name}")
        urllib.request.urlretrieve(f"{REPO}/{weights.name}", weights)

    model = YOLO(str(weights))
    exported = Path(model.export(format="onnx", dynamic=True, simplify=True, opset=17, imgsz=640))
    target = ROOT / "models" / f"erax-yolo11{size}.onnx"
    shutil.move(exported, target)

    print(f"{target.name}: classes={model.names} size={target.stat().st_size} sha256={sha256(target)}")


if __name__ == "__main__":
    for size in sys.argv[1:] or ["n", "s", "m"]:
        convert(size)
    shutil.rmtree(WORK, ignore_errors=True)
