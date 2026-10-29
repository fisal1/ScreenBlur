const test = require('node:test');
const assert = require('node:assert/strict');
const { describePlatform } = require('../src/main/platform');

test('Windows uses DirectML GPUs then CPU and hides the overlay from capture', () => {
  const platform = describePlatform('win32', [], {});
  assert.deepEqual(platform.backends.map((b) => b.name), ['dml', 'dml', 'dml', 'cpu']);
  assert.equal(platform.overlayHiddenFromCapture, true);
  assert.equal(platform.needsScreenRecordingPermission, false);
});

test('macOS uses CoreML, needs Screen Recording permission and assumes the overlay is captured', () => {
  const platform = describePlatform('darwin', [], {});
  assert.deepEqual(platform.backends.map((b) => b.name), ['coreml', 'cpu']);
  assert.equal(platform.overlayHiddenFromCapture, false);
  assert.equal(platform.needsScreenRecordingPermission, true);
});

test('Linux uses CUDA then CPU, assumes the overlay is captured and detects Wayland', () => {
  assert.deepEqual(describePlatform('linux', [], {}).backends.map((b) => b.name), ['cuda', 'cpu']);
  assert.equal(describePlatform('linux', [], {}).overlayHiddenFromCapture, false);
  assert.equal(describePlatform('linux', [], { XDG_SESSION_TYPE: 'x11' }).isWayland, false);
  assert.equal(describePlatform('linux', [], { XDG_SESSION_TYPE: 'wayland' }).isWayland, true);
  assert.equal(describePlatform('linux', [], { WAYLAND_DISPLAY: 'wayland-0' }).isWayland, true);
});

test('command-line flags override the overlay capture assumption', () => {
  assert.equal(describePlatform('darwin', ['--overlay-hidden-from-capture'], {}).overlayHiddenFromCapture, true);
  const imitated = describePlatform('win32', ['--overlay-visible-to-capture'], {});
  assert.equal(imitated.overlayHiddenFromCapture, false);
  assert.equal(imitated.useContentProtection, false);
  assert.equal(describePlatform('darwin', [], {}).useContentProtection, true);
});

test('unknown platforms fall back to CPU', () => {
  assert.deepEqual(describePlatform('freebsd', [], {}).backends, [{ name: 'cpu' }]);
});
