const { BrowserWindow, ipcMain } = require('electron');
const { IpcChannel } = require('../shared/messages');

/**
 * Settings window with the sensitivity slider and a live score meter.
 * `getState()` supplies what the page shows; `setThresholdPercent(percent)` applies a change.
 */
class SettingsWindow {
  constructor(config, { getState, setThresholdPercent }) {
    this.config = config;
    this.window = null;
    this.onGet = (event) => (this.isFromWindow(event) ? getState() : null);
    this.onSetThreshold = (event, percent) => this.isFromWindow(event) && setThresholdPercent(percent);
    ipcMain.handle(IpcChannel.SETTINGS_GET, this.onGet);
    ipcMain.on(IpcChannel.SETTINGS_SET_THRESHOLD, this.onSetThreshold);
  }

  open() {
    if (this.window) {
      this.window.show();
      this.window.focus();
      return;
    }
    this.window = new BrowserWindow({
      width: 460,
      height: 450,
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
    this.window?.webContents.send(IpcChannel.SETTINGS_UPDATE, state);
  }

  destroy() {
    ipcMain.removeHandler(IpcChannel.SETTINGS_GET);
    ipcMain.off(IpcChannel.SETTINGS_SET_THRESHOLD, this.onSetThreshold);
    this.window?.destroy();
    this.window = null;
  }

  isFromWindow(event) {
    return this.window && event.sender === this.window.webContents;
  }
}

module.exports = { SettingsWindow };
