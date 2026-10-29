// Everything that differs between operating systems, in one place.

/**
 * ONNX Runtime execution providers to try, fastest first. The worker measures each one that
 * loads and keeps the fastest (see inference/backend-selector.js).
 * - Windows: DirectML on every GPU (laptops usually list the integrated GPU first).
 * - macOS: CoreML (Apple GPU / Neural Engine).
 * - Linux: CUDA, only when running from source with onnxruntime's CUDA libraries and NVIDIA's
 *   CUDA toolkit installed (the installers leave them out; they would add ~500 MB).
 * CPU always works and is the fallback everywhere.
 */
const BACKENDS = Object.freeze({
  win32: [{ name: 'dml', deviceId: 0 }, { name: 'dml', deviceId: 1 }, { name: 'dml', deviceId: 2 }, { name: 'cpu' }],
  darwin: [{ name: 'coreml' }, { name: 'cpu' }],
  linux: [{ name: 'cuda' }, { name: 'cpu' }],
});

/**
 * Whether our overlay window is hidden from our own screen capture.
 * - Windows 10 2004+: yes (WDA_EXCLUDEFROMCAPTURE), verified by the self-test.
 * - macOS: setContentProtection maps to NSWindowSharingNone, which ScreenCaptureKit is reported
 *   to ignore on recent versions. Assumed not hidden until the self-test proves otherwise
 *   (run with --overlay-hidden-from-capture to override).
 * - Linux: no equivalent exists.
 * When the overlay is visible to capture, the region tracker holds covered areas instead of
 * expecting to keep seeing them (see region-tracker.js).
 */
function overlayHiddenFromCapture(platform, argv) {
  if (argv.includes('--overlay-hidden-from-capture')) return true;
  if (argv.includes('--overlay-visible-to-capture')) return false;
  return platform === 'win32';
}

function isWaylandSession(env) {
  return env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
}

function describePlatform(platform = process.platform, argv = process.argv, env = process.env) {
  return Object.freeze({
    name: platform,
    backends: BACKENDS[platform] ?? [{ name: 'cpu' }],
    overlayHiddenFromCapture: overlayHiddenFromCapture(platform, argv),
    // Always ask the OS to hide the overlay from capture (it may still work on macOS) unless
    // --overlay-visible-to-capture is given, which lets Windows imitate macOS/Linux for testing.
    useContentProtection: !argv.includes('--overlay-visible-to-capture'),
    needsScreenRecordingPermission: platform === 'darwin',
    isWayland: platform === 'linux' && isWaylandSession(env),
  });
}

module.exports = { describePlatform, BACKENDS };
