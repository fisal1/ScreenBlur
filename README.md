# ScreenBlur

Cross-platform desktop app that detects explicit scenes on screen and covers them with a
SFW overlay. Screen capture, JPEG encoding, and all inference stay on the device.

The app is split into two processes:

| Component | Path | Responsibility |
| --- | --- | --- |
| Electron desktop app | `desktop/` | Tray, settings, global hotkeys, screen capture, WebSocket client, overlay, sidecar lifecycle |
| Python sidecar | `engine/` | FastAPI WebSocket server, binary frame parsing, latest-only scheduling, ONNX inference |

The protocol is documented in [ScreenBlur-Hybrid-RFC.md](ScreenBlur-Hybrid-RFC.md) and
[docs/protocol.md](docs/protocol.md).

## Quick start (development)

### 1. Engine

```bash
cd engine
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
# Optional: real inference (skip on Python versions without onnxruntime wheels)
pip install -r requirements-onnx.txt

# Optional: install the box-capable NudeNet 320n detector.
python3 ../scripts/fetch_nudenet_model.py

# Models are auto-detected in engine/models/. Without one, the dev heuristic runs.
python -m app.main --port 8000
```

The engine prints `PORT=<port>` and, when no token is supplied, `TOKEN=<token>` on
stdout. It binds to `127.0.0.1` only.

### 2. Desktop app

```bash
cd desktop
npm install
npm run dev
```

> npm 11 may hold new dependency install scripts for approval. The current versions are
> approved in `package.json`; after upgrading dependencies, run
> `npm install-scripts approve electron esbuild fsevents` if Electron's binary is missing.

In dev the Electron app spawns the engine from `engine/` using the local
`.venv` Python when present (override with `SCREENBLUR_PYTHON`). If you want to
attach to an engine you already started:

```bash
SCREENBLUR_ENGINE_URL=ws://127.0.0.1:8000/ws/stream \
SCREENBLUR_ENGINE_TOKEN=<token> \
npm run dev
```

> On macOS grant Screen Recording permission when prompted (System Settings → Privacy &
> Security → Screen Recording). The app must be restarted after the permission changes.

### 3. Try it

- The overlay can be toggled manually from the tray (`Test overlay`) or with
  `CmdOrCtrl+Shift+O`.
- `CmdOrCtrl+Shift+B` pauses/resumes monitoring.
- `CmdOrCtrl+Shift+,` opens settings.
- Overlay **Coverage** defaults to **Detected area**: the visible cover follows
  the engine's normalized boxes and leaves the rest of the screen visible. It
  falls back to a full-screen cover when the detector has no boxes. Change this
  under Settings → Overlay if you prefer full-screen coverage.
- Overlay windows use OS content protection so the capture loop reads the screen
  underneath them, not the overlay. The Settings log panel shows one line per
  detector result, engine output, and each overlay show/hide decision.
- With NudeNet installed, the engine reports `nudenet:<model>` and returns one
  normalized box per exposed body part. The overlay merges only overlapping boxes,
  so separate people/regions stay separate instead of becoming one full-screen cover.
- With no ONNX model the engine reports `detector: "heuristic"` and uses a skin-tone
  heuristic. It exists only to exercise the pipeline; it is not a real NSFW classifier.

## Production packaging

1. Build the sidecar on the target architecture:

   ```bash
   cd engine
   ./scripts/build-engine.sh        # PyInstaller one-file binary in engine/dist/
   ```

2. Package the app:

   ```bash
   cd desktop
   npm run package                  # electron-builder, see desktop/electron-builder.yml
   ```

`electron-builder` copies `engine/dist/screenblur-engine` into the app's resources. At
runtime `SidecarManager` prefers that bundled binary, then a previously downloaded binary
in `userData/bin/`, then (in development) `python -m app.main`. The macOS target builds
for the host architecture by default because the bundled engine binary is
architecture-specific; build the engine on each architecture you intend to ship.

The optional downloader (`desktop/src/main/engineInstaller.ts`) verifies SHA-256 checksums
for release assets and is wired for future GitHub Releases flow; it is not used unless a
bundled binary is missing and `SCREENBLUR_ENGINE_DOWNLOAD_URL` is configured.

## Tests

```bash
cd engine && pytest
cd desktop && npm test
```

## Safety and privacy

- Frames exist only in memory and are discarded after decoding/sending.
- The engine binds to loopback and requires a per-launch bearer token.
- No telemetry, no cloud calls.
- Overlay windows request OS content protection so capture reads the screen underneath;
  the exclusion is best effort and is unavailable on Linux.
- Overlay coverage is best effort: some fullscreen/DRM-protected surfaces cannot be
  covered on every platform. Do not rely on this app as a parental control or safety
  mechanism.
