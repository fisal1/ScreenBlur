# Third-party notices

ScreenBlur is licensed under the GNU Affero General Public License v3.0 or later (see
[LICENSE](LICENSE)). It includes or downloads the following third-party components.

## Detection models

| Model | Source | License |
| :-- | :-- | :-- |
| NudeNet v3.4 `320n.onnx` | [notAI-tech/NudeNet](https://github.com/notAI-tech/NudeNet) | AGPL-3.0 |
| EraX-Anti-NSFW v1.1 (YOLO11 nano and small), converted to ONNX by `scripts/convert-erax.py` | [erax-ai/EraX-Anti-NSFW-V1.1](https://huggingface.co/erax-ai/EraX-Anti-NSFW-V1.1) | Apache-2.0 (as stated by EraX); the models were trained with [Ultralytics](https://github.com/ultralytics/ultralytics), which is AGPL-3.0 |

The converted EraX files are published unmodified (apart from the format conversion) on the
[`models-v1` release](https://github.com/fisal1/ScreenBlur/releases/tag/models-v1).

## Libraries

| Component | License |
| :-- | :-- |
| [Electron](https://github.com/electron/electron) (includes Chromium and Node.js) | MIT, plus the licenses of its bundled components (listed in `LICENSES.chromium.html` inside the app) |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-node`, includes DirectML on Windows) | MIT |

## Media

| File | Notes |
| :-- | :-- |
| `assets/patch.gif` | Third-party animated GIF found on Pinterest; not created by this project. It is only the default cover: users can pick their own image in Settings > Cover style. Replace the file if you redistribute ScreenBlur and don't have the rights to it. |
