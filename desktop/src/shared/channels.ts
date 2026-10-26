/** IPC channel names shared by main and preload scripts. */
export const IPC = {
  // Renderer (settings) -> main
  getStatus: 'app:get-status',
  getConfig: 'app:get-config',
  updateConfig: 'app:update-config',
  pause: 'app:pause',
  resume: 'app:resume',
  restartEngine: 'app:restart-engine',
  testOverlay: 'app:test-overlay',
  openPermissionSettings: 'app:open-permission-settings',
  getLogs: 'app:get-logs',
  chooseGif: 'app:choose-gif',

  // main -> settings renderer
  statusPush: 'app:status',
  configPush: 'app:config',

  // main -> capture renderer
  captureInit: 'capture:init',
  captureConfig: 'capture:config',
  capturePaused: 'capture:paused',
  captureStop: 'capture:stop',

  // capture renderer -> main
  captureFrame: 'capture:frame',
  captureReady: 'capture:ready',
  captureError: 'capture:error',

  // main -> overlay renderer
  overlayState: 'overlay:state',

  // overlay renderer -> main
  overlayReady: 'overlay:ready',
} as const;
