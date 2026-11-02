// Message and channel names shared by main, the inference worker and the capture preload.

/** Messages exchanged with the inference worker. */
const WorkerMessage = Object.freeze({
  INIT: 'init',
  CONFIGURE: 'configure', // change detection options (e.g. cover size) without a restart
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
});

/** Electron IPC channels between main and the renderers. */
const IpcChannel = Object.freeze({
  INFERENCE_PORT: 'inference-port',
  CAPTURE_COMMAND: 'capture-command',
  CAPTURE_STATUS: 'capture-status',
  PROBE_RESULT: 'probe-result',
  OVERLAY_RENDER: 'overlay-render',
  OVERLAY_SET_PATCH: 'overlay-set-patch', // image URL covering areas, '' for a blur
  SETTINGS_GET: 'settings-get',
  SETTINGS_SET_THRESHOLD: 'settings-set-threshold',
  SETTINGS_SET_MODEL: 'settings-set-model',
  SETTINGS_SET_PERFORMANCE_MODE: 'settings-set-performance-mode',
  SETTINGS_SET_PATCH_STYLE: 'settings-set-patch-style',
  SETTINGS_SET_COVER_SIZE: 'settings-set-cover-size',
  SETTINGS_CHOOSE_PATCH_IMAGE: 'settings-choose-patch-image',
  SETTINGS_PREVIEW_PATCH: 'settings-preview-patch',
  SETTINGS_UPDATE: 'settings-update',
});

module.exports = { WorkerMessage, CaptureCommand, IpcChannel };
