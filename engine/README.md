# ScreenBlur engine

Local-only Python sidecar for [ScreenBlur](../README.md). It accepts JPEG frames
from the Electron app over a WebSocket, runs a classifier, and returns a
show/hide decision. Frames never leave the machine and are not written to disk.

- Endpoint: `ws://127.0.0.1:<port>/ws/stream?token=<token>`
- Health: `GET http://127.0.0.1:<port>/health`
- Bind address: loopback only (`127.0.0.1`, `::1`, or `localhost`)
- Protocol: [docs/protocol.md](../docs/protocol.md)

## Setup

Python 3.11+ is required. This checkout is tested on Python 3.14.5.

```bash
cd engine
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

# Optional real inference. Skip if your platform/Python has no onnxruntime wheel.
pip install -r requirements-onnx.txt
```

## Run

```bash
cd engine
python -m app.main --port 8000
```

Use `--port 0` to let the OS choose a free port. The engine prints the actual
port on stdout before serving:

```text
PORT=53421
TOKEN=...          # only when the token was auto-generated
```

Electron reads `PORT=` from the child process. In managed mode it supplies the
token through `SCREENBLUR_TOKEN`, so `TOKEN=` is **not** printed. Never log or
persist the token.

A ready file can be used instead of stdout parsing:

```bash
python -m app.main --port 0 --ready-file /tmp/screenblur-ready.json
```

It contains `{ "port": 53421, "pid": 12345 }`, plus `"token"` only when the
engine generated the token. The file is written atomically after binding.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCREENBLUR_HOST` | `127.0.0.1` | Loopback bind address (`127.0.0.1`, `::1`, `localhost`) |
| `SCREENBLUR_PORT` | `0` | TCP port; `0` selects a free port |
| `SCREENBLUR_TOKEN` | auto-generated | Per-launch bearer token |
| `SCREENBLUR_MODEL_PATH` | `models/nsfw.onnx` | ONNX classifier path |
| `SCREENBLUR_MODEL_INPUT_SIZE` | `224` | Square input size (overridden by static model dimensions) |
| `SCREENBLUR_EXPLICIT_CLASS_INDEX` | `1` | Output index for the explicit class |
| `SCREENBLUR_SENSITIVITY` | `0.8` | Minimum score for `show: true` |
| `SCREENBLUR_FPS` | `2` | Advisory capture FPS echoed in `status` |
| `SCREENBLUR_MAX_FRAME_BYTES` | `8388608` (8 MiB) | Maximum binary WebSocket message |
| `SCREENBLUR_LOG_LEVEL` | `info` | `debug`, `info`, `warning`, `error`, `critical` |
| `SCREENBLUR_READY_FILE` | unset | Optional startup handshake file |

CLI flags mirror the settings: `--host`, `--port`, `--token`, `--model`,
`--model-input-size`, `--explicit-class-index`, `--sensitivity`, `--fps`,
`--max-frame-bytes`, `--log-level`, `--ready-file`.

## Detectors

At startup the engine loads `models/nsfw.onnx` when it exists. If the file is
missing, ONNX Runtime is unavailable, or the model fails to load, the engine
**still starts** and reports the `heuristic` fallback. The reason is included in
`ready`, `status`, and `/health` as `detector_error`.

The heuristic detector uses a skin-tone ratio and returns one coarse normalized
bounding box for the detected skin-tone region, which lets the desktop app place
a detected-area overlay. It is a development aid only, not a content classifier.
See [models/README.md](models/README.md) for model input/output requirements and
licensing notes.

## Messages

Electron → engine:

```json
{ "type": "pause" }
{ "type": "resume" }
{ "type": "config", "sensitivity": 0.8, "fps": 2 }
{ "type": "reload_model" }
{ "type": "ping", "id": 1 }
```

`sensitivity` and `threshold` are synonyms. `fps` is advisory. Unknown fields
are ignored; unknown message types return an error.

Engine → Electron:

- `ready`: version, protocol, detector/model list, `max_frame_bytes`
- `result`: full result for a frame (see below)
- `status`: reply to pause/resume/config/reload
- `pong`: echoes `id`
- `error`: stable `code` plus a short message

Example result:

```json
{
  "type": "result",
  "seq": 42,
  "display_id": 1,
  "show": true,
  "score": 0.91,
  "category": "explicit",
  "boxes": [[0.12, 0.18, 0.56, 0.92]],
  "roi": null,
  "latency_ms": 42,
  "processing_ms": 30,
  "superseded": false,
  "ts": 1793043659731,
  "detector": "onnx:nsfw"
}
```

Only one frame is processed at a time. While inference is busy, the newest
incoming frame replaces the waiting frame; replaced frames are counted as
dropped. `superseded` is true when a newer frame was already waiting as this
result completed. The desktop app should still ignore results with a lower
`seq` than the last applied result.

## `/health`

```json
{
  "ok": true,
  "version": "0.1.0",
  "paused": false,
  "detector": "heuristic",
  "detector_error": null,
  "model_path": ".../models/nsfw.onnx",
  "sensitivity": 0.8,
  "fps": 2.0,
  "metrics": {
    "received": 10,
    "processed": 9,
    "dropped": 1,
    "errors": 0,
    "connections": 1,
    "last_seq": 10
  },
  "uptime_s": 12.5
}
```

## Tests

```bash
cd engine
source .venv/bin/activate
pip install -r requirements-dev.txt
pytest
```

The suite uses Pillow to generate small JPEGs and does not require ONNX Runtime
or a model file. Lint/format with `ruff check .` and `ruff format --check .`.

## Build a standalone binary

```bash
cd engine
source .venv/bin/activate
pip install pyinstaller
./scripts/build-engine.sh
```

The output is `engine/dist/screenblur-engine`. The script:

- uses `run_engine.py` as the frozen entrypoint so `app.*` imports remain
  package-relative;
- collects Uvicorn/websockets submodules loaded dynamically;
- bundles `models/` when the directory exists;
- includes ONNX Runtime only when it is installed in the build environment;
- marks the binary executable.

## Security notes

- The server binds loopback only and rejects non-local WebSocket clients.
  The `Host` header is validated to prevent DNS rebinding.
- Every WebSocket connection requires the per-launch token via `?token=` or
  `Authorization: Bearer ...`, compared with `hmac.compare_digest`.
- Bad tokens are closed with code `4401` before the WebSocket handshake where
  the ASGI server allows it. Some servers translate a pre-accept close into an
  HTTP 403 during the handshake.
- Uvicorn access logging (which could include a token in the query string) is
  disabled. The engine never logs frame bytes or tokens.
- Aggressive malformed-message streams are closed with code `4400` after 20
  consecutive protocol errors. Normal protocol errors return an `error`
  message and keep the connection open.
- No telemetry, cloud calls, or external network requests are made.

## Package layout

| File | Purpose |
| --- | --- |
| `app/config.py` | Environment/CLI settings, loopback helpers, live runtime config |
| `app/protocol.py` | 24-byte frame header, validation, control JSON parsing |
| `app/scheduler.py` | Single-worker latest-frame scheduler and stats |
| `app/detector.py` | Detector protocol, ONNX classifier, heuristic fallback |
| `app/ws.py` | FastAPI app, auth/host checks, receive loop, sender queue |
| `app/main.py` | Socket binding, startup announcements, Uvicorn lifecycle |
| `run_engine.py` | PyInstaller entrypoint |
