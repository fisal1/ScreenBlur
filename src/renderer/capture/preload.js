const { contextBridge, ipcRenderer } = require('electron');
const { WorkerMessage, CaptureCommand, IpcChannel } = require('../../shared/messages');

// MessagePorts can't cross contextBridge, so forward them to the page with window.postMessage.
ipcRenderer.on(IpcChannel.INFERENCE_PORT, (event) => {
  window.postMessage({ channel: IpcChannel.INFERENCE_PORT }, '*', event.ports);
});

contextBridge.exposeInMainWorld('screenblur', {
  WorkerMessage,
  CaptureCommand,
  INFERENCE_PORT_CHANNEL: IpcChannel.INFERENCE_PORT,
  onCommand: (callback) => ipcRenderer.on(IpcChannel.CAPTURE_COMMAND, (_event, command) => callback(command)),
  reportStatus: (level, message) => ipcRenderer.send(IpcChannel.CAPTURE_STATUS, { level, message }),
  reportProbe: (id, fraction) => ipcRenderer.send(IpcChannel.PROBE_RESULT, { id, fraction }),
  reportInferenceResult: (result) => ipcRenderer.send(IpcChannel.CAPTURE_RESULT, result),
  reportInferenceState: (state) => ipcRenderer.send(IpcChannel.CAPTURE_INFERENCE_STATE, state),
});
