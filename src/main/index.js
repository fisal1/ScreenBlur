const { app } = require('electron');
const baseConfig = require('./config');
const { ScreenBlurApp } = require('./screenblur-app');
const { runSelfTest } = require('./self-test');

// The self-test measures throughput, so capture at full rate even on a static screen.
function selfTestConfig(config) {
  return { ...config, capture: { ...config.capture, idleFps: config.capture.fps } };
}

/** Command-line switches that must be set before the app is ready. */
function applyPlatformSwitches(platform, flags) {
  // Only fatal Chromium log messages: screen capture otherwise floods the console with
  // harmless warnings (e.g. mouse_cursor_monitor_win). Our own [capture]/[inference] logs are
  // unaffected.
  app.commandLine.appendSwitch('log-level', '3');
  // Chromium's GPU process cost ~105 MB for no measurable gain: with it off, capture still ran
  // at ~27 fps with the same CPU use (the model keeps its own GPU through ONNX Runtime).
  if (!flags.chromiumGpu) app.disableHardwareAcceleration();
  if (!platform.isWayland) return;
  // Native Wayland doesn't let apps place always-on-top, click-through windows, so the overlay
  // runs through XWayland. Screen capture still goes through the PipeWire portal.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

async function main() {
  await app.whenReady();
  if (process.platform === 'darwin') app.dock?.hide(); // tray-only app on macOS

  if (baseConfig.flags.selfTest) {
    const passed = await runSelfTest(selfTestConfig(baseConfig));
    app.exit(passed ? 0 : 1);
    return;
  }

  const screenBlur = new ScreenBlurApp(baseConfig);
  app.on('before-quit', () => screenBlur.stop());
  await screenBlur.start();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  applyPlatformSwitches(baseConfig.platform, baseConfig.flags);
  // Tray app: keep running with no visible windows.
  app.on('window-all-closed', () => {});
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  });
}
