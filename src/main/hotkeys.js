const { globalShortcut } = require('electron');

/**
 * Registers global hotkeys from an { accelerator: handler } map.
 * Returns the accelerators that could not be registered (e.g. taken by another app).
 */
function registerHotkeys(bindings) {
  return Object.entries(bindings)
    .filter(([accelerator, handler]) => !globalShortcut.register(accelerator, handler))
    .map(([accelerator]) => accelerator);
}

function unregisterHotkeys() {
  globalShortcut.unregisterAll();
}

module.exports = { registerHotkeys, unregisterHotkeys };
