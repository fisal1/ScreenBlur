// Message and channel names shared by main, the inference worker and the capture preload.

/** Messages exchanged with the inference worker. */
const WorkerMessage = Object.freeze({
  INIT: 'init',
  READY: 'ready',
  FRAME: 'frame',
  DONE: 'done',
  RESULT: 'result',
  ERROR: 'error',
});

/** Commands sent from main to the capture renderer. */
const CaptureCommand = Object.freeze({
  OPEN: 'open',
  PAUSE: 'pause',
  RESUME: 'resume',
  PROBE: 'probe',
  SET_MASK: 'set-mask', // areas covered by our overlay, ignored by change detection
  CONFIGURE_INFERENCE: 'configure-inference',
});

/** Electron IPC channels between main and the renderers. */
const IpcChannel = Object.freeze({
  INFERENCE_PORT: 'inference-port',
  CAPTURE_COMMAND: 'capture-command',
  CAPTURE_STATUS: 'capture-status',
  CAPTURE_RESULT: 'capture-result',
  CAPTURE_INFERENCE_STATE: 'capture-inference-state',
  PROBE_RESULT: 'probe-result',
  OVERLAY_RENDER: 'overlay-render',
  SETTINGS_GET: 'settings-get',
  SETTINGS_SET_THRESHOLD: 'settings-set-threshold',
  SETTINGS_SET_REMOTE: 'settings-set-remote',
  SETTINGS_UPDATE: 'settings-update',
});

module.exports = { WorkerMessage, CaptureCommand, IpcChannel };
