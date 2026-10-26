const { contextBridge, ipcRenderer } = require('electron');
const { IpcChannel } = require('../../shared/messages');

contextBridge.exposeInMainWorld('screenblurSettings', {
  getState: () => ipcRenderer.invoke(IpcChannel.SETTINGS_GET),
  setThresholdPercent: (percent) => ipcRenderer.send(IpcChannel.SETTINGS_SET_THRESHOLD, percent),
  onUpdate: (callback) => ipcRenderer.on(IpcChannel.SETTINGS_UPDATE, (_event, state) => callback(state)),
});
