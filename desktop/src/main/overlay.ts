import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';

import { IPC } from '../shared/channels';
import type { AppConfig, OverlayMode, OverlayState } from '../shared/types';
import { Logger, logger as defaultLogger } from './logger';
import { loadPage, preloadPath } from './paths';

const OVERLAY_READY_TIMEOUT_MS = 10_000;
const HIDE_AFTER_TRANSITION_MS = 400;
const BROADCAST_DEBOUNCE_MS = 40;

export interface OverlayManagerOptions {
  logger?: Logger;
  getConfig: () => AppConfig;
}

interface OverlayEntry {
  window: BrowserWindow;
  displayId: number;
  ready: boolean;
  pendingState: OverlayState | null;
  readyTimer: NodeJS.Timeout | null;
}

/**
 * One transparent, click-through, always-on-top window per display. Windows
 * are created lazily and stay hidden until a detection decision or a test
 * request shows them. Actual show/hide animation lives in the overlay page
 * (150ms opacity transition); the manager debounces rapid updates.
 */
export class OverlayManager extends EventEmitter {
  private readonly logger: Logger;
  private readonly options: OverlayManagerOptions;
  private readonly entries = new Map<number, OverlayEntry>();
  private targetVisible = false;
  private targetDisplayId: number | null = null;
  private currentScore = 0;
  private currentBoxes: number[][] = [];
  private broadcastTimer: NodeJS.Timeout | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private testTimer: NodeJS.Timeout | null = null;

  constructor(options: OverlayManagerOptions) {
    super();
    this.options = options;
    this.logger = options.logger ?? defaultLogger;

    ipcMain.on(IPC.overlayReady, this.handleReadyIpc);
    screen.on('display-added', this.handleDisplayChange);
    screen.on('display-removed', this.handleDisplayChange);
    screen.on('display-metrics-changed', this.handleDisplayChange);
  }

  get visible(): boolean {
    return this.targetVisible;
  }

  get mode(): OverlayMode {
    return this.options.getConfig().overlayMode;
  }

  /**
   * Show or update the overlay. When `displayId` is provided, only the
   * captured display is covered; other monitors are left untouched.
   */
  show(score: number, boxes: readonly (readonly number[])[] = [], displayId: number | null = null): void {
    this.targetVisible = true;
    this.targetDisplayId = displayId;
    this.currentScore = Math.min(1, Math.max(0, score));
    this.currentBoxes = boxes
      .filter((box) => Array.isArray(box) && box.length === 4)
      .map((box) => [Number(box[0]), Number(box[1]), Number(box[2]), Number(box[3])]);
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }

    this.syncDisplays();
    for (const entry of this.entries.values()) {
      const window = entry.window;
      if (window.isDestroyed()) continue;
      if (!this.isVisibleOn(entry)) {
        if (window.isVisible()) window.hide();
        continue;
      }
      if (!window.isVisible()) {
        window.showInactive();
        window.setAlwaysOnTop(true, 'screen-saver');
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.setIgnoreMouseEvents(true, { forward: true });
      }
    }
    this.scheduleBroadcast();
  }

  /** Hide the overlay after the renderer's opacity transition. */
  hide(): void {
    if (!this.targetVisible && !this.entries.size) return;
    this.targetVisible = false;
    this.scheduleBroadcast();

    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (this.targetVisible) return;
      for (const entry of this.entries.values()) {
        if (!entry.window.isDestroyed() && entry.window.isVisible()) entry.window.hide();
      }
    }, HIDE_AFTER_TRANSITION_MS);
  }

  setMode(mode: OverlayMode): void {
    if (this.mode === mode) return;
    this.logger.info('overlay', `Overlay mode set to ${mode}`);
    this.scheduleBroadcast(true);
  }

  /** Flash the overlay for a few seconds regardless of engine results. */
  test(durationMs = 3000): void {
    this.show(0.99);
    if (this.testTimer) clearTimeout(this.testTimer);
    this.testTimer = setTimeout(() => {
      this.testTimer = null;
      this.hide();
    }, Math.max(500, Math.min(15_000, durationMs)));
  }

  /** Rebuild the overlay if the GIF path/mode changed. */
  refreshConfig(): void {
    this.scheduleBroadcast(true);
  }

  dispose(): void {
    ipcMain.removeListener(IPC.overlayReady, this.handleReadyIpc);
    screen.removeListener('display-added', this.handleDisplayChange);
    screen.removeListener('display-removed', this.handleDisplayChange);
    screen.removeListener('display-metrics-changed', this.handleDisplayChange);

    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.testTimer) clearTimeout(this.testTimer);
    this.broadcastTimer = null;
    this.hideTimer = null;
    this.testTimer = null;

    for (const entry of this.entries.values()) {
      if (entry.readyTimer) clearTimeout(entry.readyTimer);
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
    this.entries.clear();
    this.removeAllListeners();
  }

  private buildState(): OverlayState {
    const config = this.options.getConfig();
    return {
      visible: this.targetVisible,
      score: this.currentScore,
      mode: config.overlayMode,
      gifUrl: this.resolveGifUrl(config.overlayGifPath),
      boxes: config.overlayCoverage === 'detected' ? this.currentBoxes : [],
    };
  }

  private resolveGifUrl(path: string): string {
    if (!path) return '';
    try {
      if (!existsSync(path)) {
        this.logger.warn('overlay', 'Configured GIF path does not exist; using placeholder');
        return '';
      }
      return pathToFileURL(path).toString();
    } catch {
      return '';
    }
  }

  private isVisibleOn(entry: OverlayEntry): boolean {
    return this.targetVisible && (this.targetDisplayId === null || entry.displayId === this.targetDisplayId);
  }

  private stateForEntry(entry: OverlayEntry): OverlayState {
    const state = this.buildState();
    return { ...state, visible: state.visible && this.isVisibleOn(entry) };
  }

  private syncDisplays(): void {
    const displays = screen
      .getAllDisplays()
      .filter((display) => this.targetDisplayId === null || display.id === this.targetDisplayId);
    const connected = new Set(displays.map((display) => display.id));

    for (const [displayId, entry] of this.entries) {
      if (!connected.has(displayId)) {
        if (entry.readyTimer) clearTimeout(entry.readyTimer);
        if (!entry.window.isDestroyed()) entry.window.destroy();
        this.entries.delete(displayId);
      }
    }

    for (const display of displays) {
      const existing = this.entries.get(display.id);
      if (existing) {
        if (!existing.window.isDestroyed()) {
          existing.window.setBounds(display.bounds);
        }
        continue;
      }
      this.createWindow(display);
    }
  }

  private createWindow(display: Electron.Display): void {
    const window = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      acceptFirstMouse: false,
      backgroundColor: '#00000000',
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      webPreferences: {
        preload: preloadPath('overlay'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        webSecurity: true,
        spellcheck: false,
        devTools: Boolean(process.env.SCREENBLUR_DEV_SERVER_URL),
      },
    });

    window.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    } else {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    window.setIgnoreMouseEvents(true, { forward: true });
    window.setMenuBarVisibility(false);

    // Keep the overlay out of the frames captured by desktopCapturer. Without
    // this, the capture loop sees the overlay instead of the content beneath
    // it: the score collapses, hysteresis hides the overlay, and the content
    // becomes visible again (the classic feedback/flicker loop).
    if (process.platform === 'darwin' || process.platform === 'win32') {
      try {
        window.setContentProtection(true);
        this.logger.info(
          'overlay',
          `Overlay for display ${display.id} is excluded from screen capture (content protection on)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('overlay', `Could not enable overlay content protection: ${message}`);
      }
    } else {
      this.logger.warn(
        'overlay',
        'Content protection is unavailable on this platform; the overlay may be captured',
      );
    }

    const entry: OverlayEntry = {
      window,
      displayId: display.id,
      ready: false,
      pendingState: null,
      readyTimer: null,
    };
    this.entries.set(display.id, entry);

    window.on('closed', () => {
      if (entry.readyTimer) clearTimeout(entry.readyTimer);
      if (this.entries.get(display.id)?.window === window) {
        this.entries.delete(display.id);
      }
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      this.logger.warn('overlay', `Overlay renderer stopped (${details.reason})`);
      if (!window.isDestroyed()) window.destroy();
      this.entries.delete(display.id);
    });

    entry.readyTimer = setTimeout(() => {
      entry.readyTimer = null;
      if (!entry.ready) this.logger.warn('overlay', `Overlay renderer for display ${display.id} did not become ready`);
    }, OVERLAY_READY_TIMEOUT_MS);

    void loadPage(window, 'overlay')
      .then(() => {
        if (window.isDestroyed()) return;
        // The overlay page reports ready over IPC. In case that message is
        // delayed, send the initial hidden state as soon as the document loads.
        entry.pendingState = this.stateForEntry(entry);
        this.sendToEntry(entry, entry.pendingState);
        // A display hot-plugged while the overlay is active must be covered
        // immediately, not only on the next detection result.
        if (this.isVisibleOn(entry)) {
          window.showInactive();
          window.setAlwaysOnTop(true, 'screen-saver');
          window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
          window.setIgnoreMouseEvents(true, { forward: true });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('overlay', `Could not load overlay page: ${message}`);
      });
  }

  private scheduleBroadcast(force = false): void {
    if (this.broadcastTimer && !force) return;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);

    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      for (const entry of this.entries.values()) this.sendToEntry(entry, this.stateForEntry(entry));
    }, BROADCAST_DEBOUNCE_MS);
  }

  private sendToEntry(entry: OverlayEntry, state: OverlayState): void {
    if (entry.window.isDestroyed()) return;
    if (!entry.ready) {
      entry.pendingState = state;
      return;
    }
    entry.window.webContents.send(IPC.overlayState, state);
  }

  private handleReadyIpc = (event: IpcMainEvent): void => {
    for (const entry of this.entries.values()) {
      if (entry.window.isDestroyed() || entry.window.webContents !== event.sender) continue;
      entry.ready = true;
      if (entry.readyTimer) clearTimeout(entry.readyTimer);
      entry.readyTimer = null;
      const state = entry.pendingState ?? this.stateForEntry(entry);
      entry.pendingState = null;
      this.sendToEntry(entry, { ...state, visible: this.isVisibleOn(entry), score: this.currentScore });
      if (this.isVisibleOn(entry) && !entry.window.isDestroyed() && !entry.window.isVisible()) {
        entry.window.showInactive();
      }
      return;
    }
  };

  private handleDisplayChange = (): void => {
    this.syncDisplays();
    if (this.targetVisible) {
      for (const entry of this.entries.values()) this.sendToEntry(entry, this.stateForEntry(entry));
    }
  };
}
