import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';

import { IPC } from '../shared/channels';
import type { AppConfig, AppStatus, LogEntry } from '../shared/types';
import { Logger, logger as defaultLogger } from './logger';

export interface IpcContext {
  getStatus: () => AppStatus;
  getConfig: () => AppConfig;
  updateConfig: (patch: unknown) => AppConfig;
  pause: () => void;
  resume: () => void;
  restartEngine: () => void;
  testOverlay: () => void;
  openPermissionSettings: () => void;
  getLogs: () => LogEntry[];
  logger?: Logger;
}

/**
 * Settings-window IPC. Every handler rejects invocations that did not come
 * from the registered settings BrowserWindow, so other renderers (capture,
 * overlay) cannot change configuration.
 */
export class IpcBridge {
  private readonly context: IpcContext;
  private readonly logger: Logger;
  private settingsWindow: BrowserWindow | null = null;
  private handlers: Array<[string, (...args: never[]) => unknown]> = [];

  constructor(context: IpcContext) {
    this.context = context;
    this.logger = context.logger ?? defaultLogger;
  }

  setSettingsWindow(window: BrowserWindow | null): void {
    this.settingsWindow = window;
  }

  register(): void {
    this.handle(IPC.getStatus, () => this.context.getStatus());
    this.handle(IPC.getConfig, () => this.context.getConfig());
    this.handle(IPC.updateConfig, (_event, patch: unknown) => this.context.updateConfig(patch));
    this.handle(IPC.pause, () => {
      this.context.pause();
    });
    this.handle(IPC.resume, () => {
      this.context.resume();
    });
    this.handle(IPC.restartEngine, () => {
      this.context.restartEngine();
    });
    this.handle(IPC.testOverlay, () => {
      this.context.testOverlay();
    });
    this.handle(IPC.openPermissionSettings, () => {
      this.context.openPermissionSettings();
    });
    this.handle(IPC.getLogs, () => this.context.getLogs().slice(-200));
    this.handle(IPC.chooseGif, () => this.chooseGif());
  }

  broadcastStatus(status: AppStatus): void {
    this.send(IPC.statusPush, status);
  }

  broadcastConfig(config: AppConfig): void {
    this.send(IPC.configPush, config);
  }

  dispose(): void {
    for (const [channel] of this.handlers) ipcMain.removeHandler(channel);
    this.handlers = [];
    this.settingsWindow = null;
  }

  private handle(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void {
    const wrapped = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> => {
      if (!this.isTrusted(event)) {
        this.logger.warn('app', `Rejected IPC "${channel}" from an untrusted sender`);
        throw new Error('Unauthorized IPC sender');
      }
      try {
        return await handler(event, ...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('app', `IPC "${channel}" failed: ${message}`);
        throw error;
      }
    };
    ipcMain.handle(channel, wrapped);
    this.handlers.push([channel, wrapped as unknown as (...args: never[]) => unknown]);
  }

  private isTrusted(event: IpcMainInvokeEvent): boolean {
    const window = this.settingsWindow;
    if (!window || window.isDestroyed()) return false;
    return event.sender === window.webContents;
  }

  private send(channel: string, payload: unknown): void {
    const window = this.settingsWindow;
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }

  private async chooseGif(): Promise<string | null> {
    const window = this.settingsWindow;
    const options: OpenDialogOptions = {
      title: 'Choose overlay image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['gif', 'png', 'jpg', 'jpeg', 'webp', 'avif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const result =
      window && !window.isDestroyed()
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  }
}
