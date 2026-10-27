const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { BrowserWindow } = require('electron');
const { IpcChannel } = require('../shared/messages');

/**
 * Creates a borderless, click-through, always-on-top window covering `bounds`.
 * With `contentProtection` the window is excluded from screen capture (RFC 3.1),
 * so our own capture keeps seeing the content underneath it.
 */
function createCoverWindow({ bounds, contentProtection, transparent = true, preload }) {
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
    webPreferences: preload
      ? {
          preload,
          contextIsolation: true,
          sandbox: false, // preload needs require() for shared modules
          backgroundThrottling: false, // keep animating patches although the window never has focus
        }
      : { contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(contentProtection);
  return win;
}

/** Sample patch for the "Test overlay" control: a soft gradient in the middle of the screen. */
function createTestRegion() {
  const cols = 8;
  const rows = 6;
  const data = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      data.push(70 + col * 15, 110 + row * 12, 170, 255);
    }
  }
  return {
    id: 'test',
    box: { x: 0.375, y: 0.3, width: 0.25, height: 0.4 },
    velocity: { x: 0, y: 0 },
    capturedAt: Date.now(),
    mosaic: { cols, rows, data },
  };
}

/** file:// URL of the patch GIF, or '' to draw blurred patches instead. */
function patchImageUrl(gifPath) {
  return fs.existsSync(gifPath) ? pathToFileURL(gifPath).href : '';
}

/**
 * Transparent, capture-excluded window over one display that covers detected areas with
 * the patch GIF (or a blur when no GIF is installed). Region boxes are normalized (0..1)
 * to the display; the page keeps moving each patch along its velocity between updates.
 */
class OverlayManager {
  constructor(config) {
    this.config = config;
    this.window = null;
  }

  async create(display) {
    this.window = createCoverWindow({
      bounds: display.bounds,
      contentProtection: true,
      preload: this.config.paths.overlayPreload,
    });
    await this.window.loadFile(this.config.paths.overlayPage, {
      query: { patch: patchImageUrl(this.config.paths.patchGif) },
    });
  }

  get visible() {
    return Boolean(this.window?.isVisible());
  }

  /**
   * Draws the given regions ({ id, box, velocity, capturedAt, mosaic }); hides the window
   * when there are none.
   */
  render(regions) {
    if (!this.window) return;
    const { renderDelayMs, maxLeadMs } = this.config.regionTracking;
    this.window.webContents.send(IpcChannel.OVERLAY_RENDER, {
      regions: regions.map(({ id, box, velocity, capturedAt, mosaic }) => ({ id, box, velocity, capturedAt, mosaic })),
      motion: { renderDelayMs, maxLeadMs },
    });
    this.setVisible(regions.length > 0);
  }

  renderTestRegion() {
    this.render([createTestRegion()]);
  }

  setBounds(display) {
    this.window?.setBounds(display.bounds);
  }

  destroy() {
    this.window?.destroy();
    this.window = null;
  }

  setVisible(visible) {
    if (visible === this.visible) return;
    if (visible) {
      this.window.showInactive();
      this.window.moveTop();
    } else {
      this.window.hide();
    }
  }
}

module.exports = { OverlayManager, createCoverWindow };
