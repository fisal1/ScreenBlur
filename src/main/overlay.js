const { BrowserWindow } = require('electron');

/**
 * Creates a borderless, click-through, always-on-top window covering `bounds`.
 * With `contentProtection` the window is excluded from screen capture (RFC 3.1),
 * so our own capture keeps seeing the content underneath it.
 */
function createCoverWindow({ bounds, contentProtection, transparent = true }) {
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(contentProtection);
  return win;
}

/** The SFW overlay shown over detected content on one display. */
class OverlayManager {
  constructor(config) {
    this.config = config;
    this.window = null;
  }

  async create(display) {
    this.window = createCoverWindow({ bounds: display.bounds, contentProtection: true });
    await this.window.loadFile(this.config.paths.overlayPage, {
      query: { dismiss: this.config.hotkeys.dismiss },
    });
  }

  get visible() {
    return Boolean(this.window?.isVisible());
  }

  setVisible(visible) {
    if (!this.window || visible === this.visible) return;
    if (visible) {
      this.window.showInactive();
      this.window.moveTop();
    } else {
      this.window.hide();
    }
  }

  setBounds(display) {
    this.window?.setBounds(display.bounds);
  }

  destroy() {
    this.window?.destroy();
    this.window = null;
  }
}

module.exports = { OverlayManager, createCoverWindow };
