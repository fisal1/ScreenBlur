import { contextBridge, ipcRenderer } from 'electron';

import { IPC } from '../shared/channels';
import type {
  AppConfig,
  AppStatus,
  LogEntry,
  ScreenBlurApi,
} from '../shared/types';

const api: ScreenBlurApi = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus) as Promise<AppStatus>,
  getConfig: () => ipcRenderer.invoke(IPC.getConfig) as Promise<AppConfig>,
  updateConfig: (patch: Partial<AppConfig>) =>
    ipcRenderer.invoke(IPC.updateConfig, patch) as Promise<AppConfig>,
  pause: () => ipcRenderer.invoke(IPC.pause) as Promise<void>,
  resume: () => ipcRenderer.invoke(IPC.resume) as Promise<void>,
  restartEngine: () => ipcRenderer.invoke(IPC.restartEngine) as Promise<void>,
  testOverlay: () => ipcRenderer.invoke(IPC.testOverlay) as Promise<void>,
  openPermissionSettings: () => ipcRenderer.invoke(IPC.openPermissionSettings) as Promise<void>,
  getLogs: () => ipcRenderer.invoke(IPC.getLogs) as Promise<LogEntry[]>,
  chooseGif: () => ipcRenderer.invoke(IPC.chooseGif) as Promise<string | null>,

  onStatus: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: AppStatus): void => listener(status);
    ipcRenderer.on(IPC.statusPush, wrapped);
    return () => ipcRenderer.removeListener(IPC.statusPush, wrapped);
  },

  onConfig: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, config: AppConfig): void => listener(config);
    ipcRenderer.on(IPC.configPush, wrapped);
    return () => ipcRenderer.removeListener(IPC.configPush, wrapped);
  },
};

contextBridge.exposeInMainWorld('screenblur', api);
