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
    settingsPage: path.join(SRC, 'renderer', 'settings', 'index.html'),
    settingsPreload: path.join(SRC, 'renderer', 'settings', 'preload.js'),
    selfTestReport: path.join(ROOT, 'selftest-results.json'),
  }),

  // The model accepts any input size that is a multiple of 32. Frames keep the screen's aspect
  // ratio; a larger long side finds smaller content but costs more time per frame
  // (measured on a Ryzen 7 4800H: 640 -> ~50 ms, 800 -> ~80 ms, 960 -> ~135 ms).
  modelInput: Object.freeze({
    longSide: 960,
    stride: 32,
  }),

  capture: Object.freeze({
    fps: 5, // rate while the screen is changing
    idleFps: 1, // rate while the screen is static
    tickMs: 50, // how often the thumbnail diff is checked
    thumbnailSize: 32,
    sceneChangeThreshold: 12, // mean grayscale diff (0-255) that triggers an immediate frame
    staticThreshold: 2, // below this the screen is treated as static
    busyTimeoutMs: 3000, // give up waiting for a "done" reply after this
    maxSourceSize: 3840, // capture at native resolution; downscaling happens once, to the model input
  }),

  inference: Object.freeze({
    restartDelayMs: 1000,
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
  }),
});

module.exports = config;
