# Models

The engine does not ship model weights. Place an ONNX image classifier here as:

```text
engine/models/nsfw.onnx
```

or point the engine at another file:

```bash
SCREENBLUR_MODEL_PATH=/absolute/path/to/classifier.onnx python -m app.main
```

`engine/models/*.onnx` and `*.ort` are ignored by git. Do not commit weights
unless you own or have the rights to redistribute them.

## Expected model interface

- Input: one float32 tensor in NCHW layout, `1 x 3 x H x W`.
- Color order: RGB, scaled to `[0, 1]`.
- Normalization: ImageNet mean `[0.485, 0.456, 0.406]` and standard deviation
  `[0.229, 0.224, 0.225]` (applied per channel).
- Input size: `SCREENBLUR_MODEL_INPUT_SIZE` (default `224`). If the model
  declares static spatial dimensions, those win and the configured size is
  logged as overridden. Aspect ratio is squashed to the square input.
- Output: logits for a batch size of one.
  - **1 logit**: interpreted as the explicit-class logit and passed through a
    sigmoid.
  - **2 or more logits**: softmax, then the probability at
    `SCREENBLUR_EXPLICIT_CLASS_INDEX` (default `1`) is the score.
  - The score is clamped to `[0, 1]`; scores at or above sensitivity produce
    `show: true`.
- Bounding boxes are not produced by this classifier interface (`boxes: []`).
  A detector model that returns boxes will need a future adapter.

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
  third-party NSFW classifier.
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
