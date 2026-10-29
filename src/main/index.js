const { app } = require('electron');
const baseConfig = require('./config');
const { ScreenBlurApp } = require('./screenblur-app');
const { runSelfTest } = require('./self-test');

// The self-test measures throughput, so capture at full rate even on a static screen.
function selfTestConfig(config) {
  return { ...config, capture: { ...config.capture, idleFps: config.capture.fps } };
}

/** Command-line switches that must be set before the app is ready. */
function applyPlatformSwitches(platform) {
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
  applyPlatformSwitches(baseConfig.platform);
  // Tray app: keep running with no visible windows.
  app.on('window-all-closed', () => {});
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  });
}
