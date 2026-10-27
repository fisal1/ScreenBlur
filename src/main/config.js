const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

const config = Object.freeze({
  paths: Object.freeze({
    root: ROOT,
    model: path.join(ROOT, 'models', '320n.onnx'),
    inferenceWorker: path.join(SRC, 'inference', 'worker.js'),
    capturePage: path.join(SRC, 'renderer', 'capture', 'index.html'),
    capturePreload: path.join(SRC, 'renderer', 'capture', 'preload.js'),
    overlayPage: path.join(SRC, 'renderer', 'overlay', 'index.html'),
    overlayPreload: path.join(SRC, 'renderer', 'overlay', 'preload.js'),
    patchGif: path.join(ROOT, 'assets', 'patch.gif'), // shown over detected areas; blur is used if missing
    settingsPage: path.join(SRC, 'renderer', 'settings', 'index.html'),
    settingsPreload: path.join(SRC, 'renderer', 'settings', 'preload.js'),
    selfTestReport: path.join(ROOT, 'selftest-results.json'),
  }),

  // The model accepts any input size that is a multiple of 32. Frames keep the screen's aspect
  // ratio; a larger long side finds smaller content but costs more time per frame
  // (CPU, Ryzen 7 4800H: 640 -> ~50 ms, 960 -> ~135 ms; RTX 3050: 960 -> ~19 ms, 1280 -> ~25 ms).
  // The screen is captured at this size too: reading larger frames back from the GPU was the
  // main bottleneck (1920x1080 capture: ~11 fps; 960x540: ~25 fps).
  modelInput: Object.freeze({
    longSide: 960,
    stride: 32,
  }),

  capture: Object.freeze({
    fps: 30, // upper limit while the screen is changing; the real rate is bounded by inference time
    idleFps: 2, // rate while the screen is static (keeps areas on still images confirmed)
    maxStreamFps: 30, // frame rate requested from the screen capture stream
    thumbnailWidth: 64, // change-detection thumbnail (height follows the screen's aspect ratio)
    staticPixelDelta: 10, // brightness change (0-255) for a thumbnail pixel to count as changed
    staticMaxChangedPixels: 2, // a frame with at most this many changed pixels counts as static
    busyTimeoutMs: 3000, // give up waiting for a "done" reply after this
    maxInFlight: 2, // capture the next frame while the previous one is being analyzed
  }),

  inference: Object.freeze({
    restartDelayMs: 1000,
    // Tried at startup; the fastest one that works is used. DirectML device numbering differs
    // between machines (laptops usually list the integrated GPU first), so all are measured.
    // Measured on a Ryzen 7 4800H laptop at 960x544: CPU ~140 ms, Radeon iGPU ~45 ms, RTX 3050 ~19 ms.
    backends: Object.freeze([
      Object.freeze({ name: 'dml', deviceId: 0 }),
      Object.freeze({ name: 'dml', deviceId: 1 }),
      Object.freeze({ name: 'dml', deviceId: 2 }),
      Object.freeze({ name: 'cpu' }),
    ]),
    benchmarkRuns: 5,
  }),

  // Detected areas, sent from the inference worker.
  detection: Object.freeze({
    minScore: 0.1, // detections below this are never reported
    iouThreshold: 0.45, // overlapping detections above this are merged (NMS)
    maxDetections: 20,
    padding: 0.2, // grow each box by this fraction per side so movement doesn't expose edges
    mosaicCells: 10, // resolution of the averaged-color grid the blur is drawn from
  }),

  // How long blurred areas live (see region-tracker.js).
  regionTracking: Object.freeze({
    holdMs: 1500, // keep an area this long after it was last confirmed
    matchIou: 0.1, // overlap needed to treat a new detection as the same area
    dismissMs: 10000, // "this was wrong" blocks new areas for this long
    // Motion compensation (see shared/motion.js): patches keep moving along each area's
    // estimated velocity between results.
    velocitySmoothing: 0.5, // weight of the newest velocity measurement (0..1)
    maxSpeed: 4, // screens per second; faster estimates are treated as detection noise
    // Time from computing a position until it is on screen: the overlay frame plus Windows
    // compositing (1-2 refreshes). Predicting slightly too far is safe because a patch always
    // covers both the captured and the predicted position.
    renderDelayMs: 40,
    maxLeadMs: 200, // never predict further ahead than this
  }),

  hotkeys: Object.freeze({
    toggle: 'Control+Alt+B',
    dismiss: 'Control+Alt+W',
    testOverlay: 'Control+Alt+O',
  }),

  settingsFileName: 'settings.json', // stored in Electron's userData folder
  snoozeMinutes: Object.freeze([5, 15, 60]),
  trayRefreshMs: 1000,

  flags: Object.freeze({
    selfTest: process.argv.includes('--selftest'),
    verbose: process.argv.includes('--verbose'), // "--debug" is reserved by Electron
    detectFaces: process.argv.includes('--detect-faces'), // test mode: blur faces too (safe to test with)
  }),
});

module.exports = config;
