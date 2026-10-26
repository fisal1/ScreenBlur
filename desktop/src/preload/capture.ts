import { contextBridge, ipcRenderer } from 'electron';

import { IPC } from '../shared/channels';
import type { CaptureBridge, CaptureConfig, CaptureInit } from '../shared/types';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge: CaptureBridge = {
  onInit: (listener) => subscribe<CaptureInit>(IPC.captureInit, listener),
  onConfig: (listener) => subscribe<CaptureConfig>(IPC.captureConfig, listener),
  onPaused: (listener) => subscribe<boolean>(IPC.capturePaused, listener),
  onStop: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on(IPC.captureStop, wrapped);
    return () => ipcRenderer.removeListener(IPC.captureStop, wrapped);
  },
  ready: (payload) => ipcRenderer.send(IPC.captureReady, payload),
  frame: (buffer) => ipcRenderer.send(IPC.captureFrame, buffer),
  error: (message) => ipcRenderer.send(IPC.captureError, String(message).slice(0, 2000)),
};

contextBridge.exposeInMainWorld('captureBridge', bridge);
