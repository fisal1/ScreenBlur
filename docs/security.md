# Security notes

ScreenBlur is a local-only utility. It does not send frames, scores, or telemetry off the
device.

## Transport

- The engine binds to `127.0.0.1` (IPv4 loopback) by default. Do not expose it on
  `0.0.0.0`.
- Electron generates a fresh 32-byte random token at launch and passes it to the engine
  through the environment. The WebSocket connection must present the token as a query
  parameter or `Authorization: Bearer` header. Comparison is constant-time.
- The engine rejects WebSocket connections from non-loopback peers and validates the
  `Host` header to reduce DNS-rebinding risk.
- Only loopback origins are used. No remote content is loaded in any renderer, and the
  overlay/settings/capture pages ship with a restrictive CSP. Every window uses
  `contextIsolation: true` and `nodeIntegration: false`; privileged access is limited to
  the typed preload bridge.

## Frames

- Frames are JPEG-encoded in a hidden capture renderer, transferred to the main process
  as an `ArrayBuffer`, and written to the WebSocket with a fixed 24-byte header.
- The engine validates version, message type, declared payload length, maximum size,
  and JPEG markers before decoding.
- Frame bytes are never logged. The engine keeps only the newest pending frame.
- Frames are discarded after inference; no frame is written to disk.

## Process lifecycle

- The sidecar is spawned as a child process, receives `SIGTERM` on quit, and is force
  killed after a grace period. Restarts use exponential backoff.
- In packaged builds the engine binary lives under the app's resources directory. If a
  downloaded engine is used instead, its SHA-256 checksum is verified before execution.

## Limitations

- The overlay is a best-effort visual cover, not a security boundary. Exclusive
  fullscreen surfaces, DRM-protected video, secure input fields, and some compositor
  configurations may appear above or outside the overlay.
- Detected-area coverage intentionally leaves the rest of the display visible. If you
  need to guarantee that no screen content is visible, use full-screen coverage.
- Overlay windows request OS content protection (macOS/Windows) so the capture loop
  does not read the overlay instead of the content beneath it. This exclusion is
  best effort; Linux and some capture/compositor paths may still include the overlay.
  If the detector score collapses while the overlay is visible, switch to full-screen
  coverage or use a capture path that honors content protection.
- Screen capture itself requires OS permission. On macOS the app cannot capture until
  Screen Recording is granted, and the app must be restarted afterwards.
- The bundled heuristic detector is for pipeline development only. Use a vetted ONNX
  detector/classifier for real detection and evaluate its accuracy and false-positive
  rate. NudeNet (320n/640m) is supported as an opt-in box detector; its weights are
  not bundled. NudeNet's repository is AGPL-3.0, so review the licence before
  redistributing an engine that contains its weights.
