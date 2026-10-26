import { contextBridge, ipcRenderer } from 'electron';

import { IPC } from '../shared/channels';
import type { OverlayBridge, OverlayState } from '../shared/types';

const bridge: OverlayBridge = {
  onState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: OverlayState): void => listener(state);
    ipcRenderer.on(IPC.overlayState, wrapped);
    return () => ipcRenderer.removeListener(IPC.overlayState, wrapped);
  },
  ready: () => ipcRenderer.send(IPC.overlayReady),
};

contextBridge.exposeInMainWorld('overlayBridge', bridge);
