const { contextBridge, ipcRenderer } = require('electron');
const { IpcChannel } = require('../../shared/messages');
const { sweptBox } = require('../../shared/motion');

contextBridge.exposeInMainWorld('screenblurOverlay', {
  onRender: (callback) => ipcRenderer.on(IpcChannel.OVERLAY_RENDER, (_event, frame) => callback(frame)),
  onSetPatch: (callback) => ipcRenderer.on(IpcChannel.OVERLAY_SET_PATCH, (_event, imageUrl) => callback(imageUrl)),
  sweptBox,
});
