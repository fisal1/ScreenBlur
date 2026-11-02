const { BrowserWindow, ipcMain, screen } = require('electron');
const { IpcChannel } = require('../shared/messages');
const { isAlive } = require('./window-utils');

const WINDOW_WIDTH = 460;
const CONTENT_HEIGHT = 880; // the page scrolls when the screen is smaller

/**
 * Settings window: sensitivity slider with a live score meter, and the detection engine
 * (model and performance mode). `getState()` supplies what the page shows; the other
 * callbacks apply changes.
 */
class SettingsWindow {
  constructor(config, { getState, setThresholdPercent, setModel, setPerformanceMode }) {
    this.config = config;
    this.window = null;
    this.onGet = (event) => (this.isFromWindow(event) ? getState() : null);
    // Channel -> handler; each only accepts messages from our own settings page.
    this.listeners = {
      [IpcChannel.SETTINGS_SET_THRESHOLD]: setThresholdPercent,
      [IpcChannel.SETTINGS_SET_MODEL]: setModel,
      [IpcChannel.SETTINGS_SET_PERFORMANCE_MODE]: setPerformanceMode,
    };
    this.guarded = Object.fromEntries(
      Object.entries(this.listeners).map(([channel, handler]) => [channel, (event, value) => this.isFromWindow(event) && handler(value)]),
    );
    ipcMain.handle(IpcChannel.SETTINGS_GET, this.onGet);
    for (const [channel, listener] of Object.entries(this.guarded)) ipcMain.on(channel, listener);
  }

  open() {
    if (isAlive(this.window)) {
      this.window.show();
      this.window.focus();
      return;
    }
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    this.window = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: Math.min(CONTENT_HEIGHT, workArea.height - 60),
      useContentSize: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: 'ScreenBlur Settings',
      backgroundColor: '#14202e',
      webPreferences: {
        preload: this.config.paths.settingsPreload,
        contextIsolation: true,
        sandbox: false, // preload needs require() for shared message constants
      },
    });
    this.window.on('closed', () => {
      this.window = null;
    });
    this.window.loadFile(this.config.paths.settingsPage);
  }

  /** Sends fresh state to the page if the window is open. */
  update(state) {
    if (isAlive(this.window)) this.window.webContents.send(IpcChannel.SETTINGS_UPDATE, state);
  }

  destroy() {
    ipcMain.removeHandler(IpcChannel.SETTINGS_GET);
    for (const [channel, listener] of Object.entries(this.guarded)) ipcMain.off(channel, listener);
    if (isAlive(this.window)) this.window.destroy();
    this.window = null;
  }

  isFromWindow(event) {
    return isAlive(this.window) && event.sender === this.window.webContents;
  }
}

module.exports = { SettingsWindow };
