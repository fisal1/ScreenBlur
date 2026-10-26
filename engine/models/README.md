# Models

The engine does not ship model weights. Place a model in this directory or
point the engine at one explicitly:

```bash
SCREENBLUR_MODEL_PATH=/absolute/path/to/model.onnx python -m app.main
```

`engine/models/*.onnx` and `*.ort` are ignored by git. Do not commit weights
unless you own or have the rights to redistribute them.

## NudeNet v3 (YOLO detector with boxes)

NudeNet is the supported box-capable detector. It is a YOLOv8n/m model that
returns body-part bounding boxes rather than a whole-image score.

```bash
# Downloads the official 320n weights from the nudenet PyPI wheel.
python3 scripts/fetch_nudenet_model.py

# Or use your own downloaded 320n/640m ONNX file.
SCREENBLUR_MODEL_PATH=/absolute/path/to/nudenet-320n.onnx \
  python -m app.main
```

The engine auto-selects the NudeNet adapter when the filename contains
`nudenet`/`yolo`, or is `320n.onnx`/`640m.onnx`. Override the choice with
`SCREENBLUR_MODEL_KIND=nudenet` (or `classifier`) and the matching
`--model-kind` CLI flag.

Supported filenames in the default search order:

```text
engine/models/nsfw.onnx
engine/models/nudenet-320n.onnx
engine/models/nudenet.onnx
engine/models/320n.onnx
engine/models/640m.onnx
```

### NudeNet model interface

- Input: one float32 tensor in NCHW layout, `1 x 3 x H x W`.
- Color order: RGB, scaled to `[0, 1]`, no ImageNet normalization.
- Preprocessing: the frame is padded to a square at the bottom/right, then
  resized to the model input. This matches NudeNet's upstream preprocessing.
- Input size: `320` for `320n`, `640` for `640m`. A static model input shape
  wins when the ONNX file declares one.
- Output: YOLOv8 rows with `4 + 18` columns: center-x, center-y, width,
  height, followed by the 18 class scores.
- Explicit classes used for `show` and boxes:
  `BUTTOCKS_EXPOSED`, `FEMALE_BREAST_EXPOSED`, `FEMALE_GENITALIA_EXPOSED`,
  `ANUS_EXPOSED`, `MALE_GENITALIA_EXPOSED`.
- Covered, face, feet, belly, and armpit classes are ignored.
- The engine applies an explicit-class confidence threshold of `0.25` and
  class-agnostic NMS at IoU `0.45`, then returns normalized
  `[x1, y1, x2, y2]` boxes. The result score is the highest explicit-box
  confidence.
- `320n` is the small/fast default. `640m` is larger and more accurate but
  slower on CPU.

NudeNet's GitHub repository is **AGPL-3.0**. Verify the code, model-weight, and
acceptable-use terms before distributing an engine binary that bundles the
weights. The desktop app only sends frames to the local engine; it does not
upload them.

## Classifier interface

The legacy classifier adapter still works for whole-image models:

- Input: one float32 tensor in NCHW layout, `1 x 3 x H x W`.
- Color order: RGB, scaled to `[0, 1]`.
- Normalization: ImageNet mean `[0.485, 0.456, 0.406]` and standard deviation
  `[0.229, 0.224, 0.225]` (applied per channel).
- Input size: `SCREENBLUR_MODEL_INPUT_SIZE` (default `224`). If the model
  declares static spatial dimensions, those win.
- Output: logits for a batch size of one.
  - **1 logit**: interpreted as the explicit-class logit and passed through a
    sigmoid.
  - **2 or more logits**: softmax, then the probability at
    `SCREENBLUR_EXPLICIT_CLASS_INDEX` (default `1`) is the score.
- Classifier boxes are always empty (`boxes: []`), so the desktop app falls
  back to a full-screen cover when detected-area coverage is selected.

## Validation and fallback

The engine validates the model at startup. A missing, corrupt, or incompatible
model never prevents the sidecar from starting: it logs a warning, exposes
`detector_error` in `ready`/`status`/`/health`, and runs the development-only
heuristic fallback.

## ONNX Runtime

ONNX Runtime is optional:

```bash
pip install -r requirements-onnx.txt
```

It is imported lazily. On platforms or Python versions without an
`onnxruntime` wheel (including some Python 3.14 configurations), the engine
still runs with the heuristic detector. Build a packaged engine with ONNX
Runtime by installing it in the build environment before running
`scripts/build-engine.sh`; the script then bundles it.

## Licensing

You are responsible for the model you install.

- ScreenBlur includes **no** model weights and makes no license claim about any
  third-party NSFW classifier/detector.
- Check the model's license and acceptable-use terms before redistributing an
  engine binary that bundles it. Some popular research models are
  non-commercial or require attribution.
- Do not use this app or a model to process other people's screens or images
  without permission. Follow local laws and platform terms of service.

## Development fallback

With no model the engine reports `detector: "heuristic"`. That detector
computes a YCbCr skin-tone ratio on a downscaled frame and returns one coarse
normalized box around the skin-tone region. It is only for exercising the
capture → WebSocket → scheduler → overlay pipeline and is not a real NSFW
classifier.
