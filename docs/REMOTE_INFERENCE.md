# Remote inference prototype

This desktop prototype implements the roadmap's remote-inference path. Local ONNX inference
remains the default. Remote mode is an explicit setting; it sends JPEG screen frames to the
configured server and does not fall back to local inference or treat a connection failure as a
safe result. Android/iOS clients, managed cloud deployment, and production credential issuance
are not included.

## Run the service locally

The service uses the same bundled `models/320n.onnx` model and explicit NudeNet classes as the
Electron worker. Python 3.11–3.14 is recommended.

```sh
python3 -m venv service/.venv
service/.venv/bin/python -m pip install -r service/requirements.txt
cd service
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In PowerShell, activate `service/.venv/Scripts/Activate.ps1`, install the same requirements, then
run `python -m uvicorn app.main:app --host 127.0.0.1 --port 8000` from `service/`.

The service generates a one-time authentication token and prints it at startup. Copy it to
ScreenBlur Settings → **Remote inference**. The token is not saved by the client. To supply your
own service token instead, set `SCREENBLUR_BEARER_TOKEN` in the service process environment.
Do not publish service logs or tokens.

The default `onnxruntime` package uses CPU inference. On a supported CUDA machine, create a clean
virtual environment and install `service/requirements-gpu.txt` instead of `requirements.txt`;
install the CUDA/cuDNN runtime required by that ONNX Runtime release. Check
`http://127.0.0.1:8000/model/info` to verify which execution provider is actually active.

For a containerized CPU smoke test, build from the repository root and bind the published port
to loopback:

```sh
docker build -f service/Dockerfile -t screenblur-inference .
docker run --rm -p 127.0.0.1:8000:8000 screenblur-inference
```

The container prints a generated test token. This image uses CPU inference; GPU containers and
production secret/TLS provisioning are not included.

In the settings window, enable remote mode, keep the local endpoint
`ws://127.0.0.1:8000/v1/inference/stream`, enter the one-time token, choose a profile, and apply.
The low/mid/high profiles initially cap submissions at 1/2/3 FPS. The client adjusts that cap
down under high observed round-trip latency and only keeps one request in flight. Captured frames
are encoded as JPEG at quality 82; the service returns normalized boxes and the low-resolution
mosaics needed by the existing overlay.

## LAN and remote servers

The service binds to `127.0.0.1` by default. Do not expose its unauthenticated health endpoints or
WebSocket port directly to the internet. For a LAN test, bind it to a private interface only and
put a TLS-terminating reverse proxy in front of it. Configure ScreenBlur with the proxy's
`wss://host/v1/inference/stream` URL. The client rejects non-loopback plain `ws://` connections
and validates TLS certificates normally. Keep a strong, private token in the service environment,
and firewall the proxy to trusted devices.

For local development only, health and model information are available at:

```text
GET http://127.0.0.1:8000/health
GET http://127.0.0.1:8000/model/info
GET http://127.0.0.1:8000/metrics
WS  ws://127.0.0.1:8000/v1/inference/stream
```

## Version 1 WebSocket protocol

Each connection first sends a JSON authentication message. The token is never put in the
endpoint URL:

```json
{"type":"auth","protocolVersion":1,"token":"..."}
```

After authentication, the server replies with a `ready` JSON message containing the server-created
session ID and model version. A frame request is a JSON text message immediately followed by one
binary JPEG WebSocket message:

```json
{
  "type":"frame",
  "protocolVersion":1,
  "sessionId":"server-issued-session-id",
  "correlationId":"frame-42-...",
  "seq":42,
  "captureTimestampMs":1793600000000,
  "sceneChange":0.12,
  "width":960,
  "height":544,
  "contentWidth":960,
  "contentHeight":540,
  "format":"jpeg",
  "payloadBytes":123456
}
```

Requests have increasing sequence numbers per connection. Dimensions must be multiples of 32,
at most 2048 pixels per side, and the binary payload is limited to 4 MiB. The service validates
the session, metadata, JPEG format, byte count and image dimensions before inference. It bounds
authenticated sessions and concurrent inference, never writes screenshots to disk, and does not
log payloads.

The `result` message echoes protocol/session/correlation/sequence/timestamp, a `safe`/`unsafe`
decision, score and label, normalized (0–1) region boxes, overlay mosaics, model version, and
inference time. Results that do not match the outstanding request or exceed the client's frame-age
limit are ignored. Service errors, reconnects, and overload are not safe classifications.

## Tests and benchmark

From the repository root:

```sh
npm test
python3 -m pip install -r service/requirements-test.txt
cd service
python -m unittest discover -s tests -v
```

For an end-to-end replay, start the service, put local JPEG/PNG/WebP frames in a private corpus
directory, and set `SCREENBLUR_BEARER_TOKEN` to the service token in the benchmark process:

```sh
SCREENBLUR_BEARER_TOKEN='...' python service/benchmark.py \
  --corpus /path/to/private-frames --count 100 --rate 2 \
  --output screenblur-benchmark.json
```

PowerShell equivalent:

```powershell
$env:SCREENBLUR_BEARER_TOKEN = Read-Host "Service token"
python service/benchmark.py --corpus C:\private-frames --count 100 --rate 2 --output screenblur-benchmark.json
```

The benchmark replays local files at the configured model input size, records per-frame upload
size, round-trip and inference durations, and summarizes p50/p95/p99 latency, client CPU and peak
RSS. It writes JSON or CSV output without logging image pixels. Optional annotations are a JSON
object mapping image basenames to arrays of normalized `{"x","y","width","height"}` boxes; the
report then includes basic IoU-matched precision/recall. The benchmark does not establish model
quality by itself: build a representative, consented, labelled corpus and review false negatives.

The existing local regression suite can also score a local diagnostic image using
`scripts/score-image.js`. Remote JPEG preprocessing differs from the local raw-RGBA path, so
compare both modes on the same labelled corpus before drawing quality conclusions.
