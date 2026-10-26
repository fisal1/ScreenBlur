# ScreenBlur wire protocol

- Transport: WebSocket over loopback only.
- Endpoint: `ws://127.0.0.1:<port>/ws/stream?token=<token>`
- Authentication: per-launch random token. The engine also accepts
  `Authorization: Bearer <token>`.
- The engine prints `PORT=<port>` on stdout before it starts serving. In development it
  prints `TOKEN=<token>` as well; in managed mode Electron passes the token through the
  environment.

## Binary frame (Electron → engine)

All integers are big-endian. The header is fixed at 24 bytes.

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 1 | `version` | `1` |
| 1 | 1 | `msg_type` | `1` = frame |
| 2 | 4 | `seq` | `uint32`, monotonically increasing |
| 6 | 4 | `display_id` | `uint32`, Electron display id |
| 10 | 8 | `ts` | `uint64`, capture time in Unix ms |
| 18 | 4 | `payload_length` | `uint32`, JPEG byte length |
| 22 | 2 | `flags` | reserved, `0` |

The JPEG bytes follow the header. The engine validates version, type, and payload length
before decoding. The maximum WebSocket message size (header + payload) defaults to 8 MiB
and is configurable with `SCREENBLUR_MAX_FRAME_BYTES`.

## JSON control (Electron → engine)

```json
{ "type": "pause" }
{ "type": "resume" }
{ "type": "config", "sensitivity": 0.35, "fps": 2 }
{ "type": "reload_model" }
{ "type": "ping", "id": 1 }
```

`sensitivity` is the minimum score for `show: true` (higher value = stricter). `fps` is
advisory; Electron owns the capture rate. Unknown fields are ignored, unknown message
types produce an `error` response.

## JSON messages (engine → Electron)

```json
{ "type": "ready", "version": "0.1.0", "protocol": 1, "models": ["heuristic"], "detector": "heuristic" }
{ "type": "result", "seq": 42, "display_id": 1, "show": true, "score": 0.91, "category": "explicit", "boxes": [[0.12, 0.18, 0.56, 0.92]], "roi": null, "latency_ms": 42, "processing_ms": 30, "superseded": false }
{ "type": "status", "paused": false, "sensitivity": 0.35, "fps": 2, "detector": "heuristic" }
{ "type": "pong", "id": 1 }
{ "type": "error", "code": "MODEL_NOT_LOADED", "message": "..." }
```

`superseded` means a newer frame was already waiting when this result was produced. The
desktop app still filters results by ascending sequence number; superseded results are
diagnostic only.

`boxes` entries are normalized `[x1, y1, x2, y2]` rectangles in the range 0..1,
relative to the captured frame. The desktop app places one overlay region per
non-overlapping box and merges overlapping/near-touching boxes. An empty list falls
back to a full-screen cover. `roi` is reserved for future detector-region metadata and
is currently `null`.

## Frame scheduling

- The engine keeps at most one active inference and one replaceable pending frame.
- Submitting a frame while another is pending replaces it and increments `dropped_frames`.
- Submitting while inference is running stores it as pending; older pending frames are
  dropped.
- Electron ignores results whose `seq` is lower than the last applied result.
- Capture pauses while the WebSocket is disconnected or the engine is paused.
