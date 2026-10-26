import { EventEmitter } from 'node:events';
import { BrowserWindow, desktopCapturer, ipcMain, screen, systemPreferences, type IpcMainEvent } from 'electron';

import { IPC } from '../shared/channels';
import type {
  AppConfig,
  CaptureConfig,
  CaptureInit,
  CaptureState,
  CaptureStatus,
  ScreenPermission,
} from '../shared/types';
import { Logger, logger as defaultLogger } from './logger';
import { loadPage, preloadPath } from './paths';
import { encodeFrame, MAX_FRAME_PAYLOAD_BYTES } from './protocol';

const CAPTURE_READY_TIMEOUT_MS = 15_000;
const FPS_SAMPLE_MS = 5_000;

export interface CaptureManagerOptions {
  logger?: Logger;
  getConfig: () => AppConfig;
  /** False while the engine is disconnected or monitoring is paused. */
  isCaptureAllowed: () => boolean;
  /** Send an encoded frame to the engine. Returns false when it was dropped. */
  sendFrame: (frame: Uint8Array, seq: number) => boolean;
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * Owns the hidden capture renderer and turns its JPEG frames into wire frames.
 * The capture page receives its desktop source id over IPC (never a query
 * string) after the page finishes loading.
 */
export class CaptureManager extends EventEmitter {
  private readonly logger: Logger;
  private readonly options: CaptureManagerOptions;

  private window: BrowserWindow | null = null;
  private display: Electron.Display | null = null;
  private state: CaptureState = 'stopped';
  private permission: ScreenPermission = process.platform === 'darwin' ? 'not-determined' : 'unknown';
  private error: string | null = null;
  private paused = false;
  private starting = false;
  private seq = 0;
  private framesCaptured = 0;
  private framesSent = 0;
  private framesDropped = 0;
  private lastFrameAt: number | null = null;
  private sentTimes: number[] = [];
  private readyTimer: NodeJS.Timeout | null = null;

  constructor(options: CaptureManagerOptions) {
    super();
    this.options = options;
    this.logger = options.logger ?? defaultLogger;

    ipcMain.on(IPC.captureFrame, this.handleFrameIpc);
    ipcMain.on(IPC.captureReady, this.handleReadyIpc);
    ipcMain.on(IPC.captureError, this.handleErrorIpc);
  }

  getStatus(): CaptureStatus {
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((ts) => now - ts <= FPS_SAMPLE_MS);
    const span = this.sentTimes.length > 1 ? now - (this.sentTimes[0] ?? now) : 0;
    const actualFps =
      this.sentTimes.length > 0 && span > 0
        ? Math.round((this.sentTimes.length / Math.max(span / 1000, 1)) * 10) / 10
        : 0;

    return {
      state: this.state,
      displayId: this.display?.id ?? null,
      displayName: this.display?.label ?? null,
      framesCaptured: this.framesCaptured,
      framesSent: this.framesSent,
      framesDropped: this.framesDropped,
      actualFps,
      lastFrameAt: this.lastFrameAt,
      permission: this.permission,
      error: this.error,
    };
  }

  getPermission(): ScreenPermission {
    return this.permission;
  }

  isPaused(): boolean {
    return this.paused;
  }

  async start(): Promise<void> {
    if (this.starting) return;
    if (this.window && (this.state === 'running' || this.state === 'paused' || this.state === 'starting')) {
      return;
    }

    // A window can linger after an error or permission failure. Drop it before
    // creating a replacement so two capture renderers never run at once.
    const stale = this.window;
    this.window = null;
    if (stale && !stale.isDestroyed()) stale.destroy();

    this.starting = true;
    this.error = null;
    this.setState('starting');

    try {
      const before = this.readPermission();
      this.permission = before;
      if (process.platform === 'darwin' && (before === 'denied' || before === 'restricted')) {
        this.permissionDenied(
          'Screen Recording permission is not granted. Open System Settings → Privacy & Security → Screen Recording and enable ScreenBlur, then restart the app.',
        );
        return;
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });

      // Calling getSources is what triggers the macOS permission prompt; read
      // the status again afterwards to surface the real result.
      this.permission = this.readPermission();

      if (sources.length === 0) {
        if (process.platform === 'darwin') {
          this.permissionDenied(
            'No screen capture source is available. Grant Screen Recording permission in System Settings and restart ScreenBlur.',
          );
        } else {
          this.fail('No screen capture source is available');
        }
        return;
      }

      if (process.platform === 'darwin' && this.permission !== 'granted' && this.permission !== 'not-determined') {
        this.permissionDenied(
          'Screen Recording permission was denied. Enable it in System Settings → Privacy & Security → Screen Recording and restart ScreenBlur.',
        );
        return;
      }

      const selection = this.selectSource(sources);
      if (!selection) {
        this.fail('No screen matching the configured display was found');
        return;
      }

      this.display = selection.display;
      const config = this.options.getConfig();
      const init: CaptureInit = {
        sourceId: selection.source.id,
        displayId: selection.display.id,
        fps: config.fps,
        jpegQuality: config.jpegQuality,
        maxWidth: config.maxWidth,
      };

      await this.createCaptureWindow(init);
      this.logger.info(
        'capture',
        `Capturing "${selection.source.name}" at ${config.fps} FPS, max width ${config.maxWidth}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(`Screen capture could not start: ${message}`);
    } finally {
      this.starting = false;
    }
  }

  async restart(): Promise<void> {
    const paused = this.paused;
    await this.stop();
    this.paused = paused;
    await this.start();
  }

  async stop(): Promise<void> {
    this.clearReadyTimer();
    const window = this.window;
    this.window = null;
    this.display = null;
    if (window && !window.isDestroyed()) {
      // Give the renderer a moment to stop its MediaStream tracks before the
      // window (and with it the OS screen-capture indicator) is torn down.
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(IPC.captureStop);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      if (!window.isDestroyed()) window.destroy();
    }
    this.error = null;
    this.setState('stopped');
    this.logger.info('capture', 'Capture stopped');
  }

  setPaused(paused: boolean): void {
    const changed = this.paused !== paused;
    this.paused = paused;

    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC.capturePaused, paused);
      if (paused) {
        this.setState('paused');
      } else if (this.state === 'paused' || this.state === 'starting') {
        this.setState('running');
      }
    }

    if (changed) {
      this.logger.info('capture', paused ? 'Capture paused' : 'Capture resumed');
    }
    // `setPaused(false)` is also the "ensure running" path on startup and after
    // a resume; don't rely on the pause flag having changed to start capture.
    if (!paused && !this.window) {
      void this.start();
    }
  }

  /** Update capture parameters without recreating the source. */
  updateConfig(config: AppConfig): void {
    if (!this.window || this.window.isDestroyed()) return;
    const payload: CaptureConfig = {
      fps: config.fps,
      jpegQuality: config.jpegQuality,
      maxWidth: config.maxWidth,
    };
    this.window.webContents.send(IPC.captureConfig, payload);
  }

  async changeDisplay(displayId: number | null): Promise<void> {
    const current = this.display?.id ?? null;
    if (current === displayId) return;
    // Changing the preferred display must not start screen capture while the
    // app is stopped or paused before the first frame. The next start() will
    // pick up the new preference.
    if (!this.window) return;
    await this.restart();
  }

  /** Ask the capture page for a new frame immediately (used for testing). */
  requestPermission(): ScreenPermission {
    if (process.platform !== 'darwin') return 'unknown';
    // The actual prompt is triggered by the next desktopCapturer.getSources()
    // call; this returns the current state for the UI.
    this.permission = this.readPermission();
    return this.permission;
  }

  dispose(): void {
    ipcMain.removeListener(IPC.captureFrame, this.handleFrameIpc);
    ipcMain.removeListener(IPC.captureReady, this.handleReadyIpc);
    ipcMain.removeListener(IPC.captureError, this.handleErrorIpc);
    this.clearReadyTimer();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.removeAllListeners();
  }

  private async createCaptureWindow(init: CaptureInit): Promise<void> {
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 180,
      skipTaskbar: true,
      focusable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'ScreenBlur capture',
      webPreferences: {
        preload: preloadPath('capture'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        webSecurity: true,
        spellcheck: false,
        devTools: Boolean(process.env.SCREENBLUR_DEV_SERVER_URL),
      },
    });

    this.window = window;

    window.on('closed', () => {
      if (this.window !== window) return;
      this.window = null;
      this.clearReadyTimer();
      if (this.state !== 'stopped') this.setState('stopped');
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      if (this.window !== window) return;
      this.fail(`Capture renderer stopped (${details.reason}); restart monitoring to recover`);
    });

    await loadPage(window, 'capture');
    if (window.isDestroyed() || this.window !== window) return;

    // Source id and configuration are delivered over IPC after load, never in
    // the page URL.
    window.webContents.send(IPC.captureInit, init);
    window.webContents.send(IPC.capturePaused, this.paused);

    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.window !== window || this.state === 'running') return;
      this.fail('Capture renderer did not become ready within 15s');
    }, CAPTURE_READY_TIMEOUT_MS);
  }

  private selectSource(sources: Electron.DesktopCapturerSource[]): {
    source: Electron.DesktopCapturerSource;
    display: Electron.Display;
  } | null {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const config = this.options.getConfig();
    const wantedId = config.displayId;

    if (wantedId !== null) {
      const source = sources.find((candidate) => Number.parseInt(candidate.display_id, 10) === wantedId);
      const display = displays.find((candidate) => candidate.id === wantedId);
      if (source && display) return { source, display };
      this.logger.warn('capture', `Configured display ${wantedId} not found; falling back to primary`);
    }

    const primarySource =
      sources.find((candidate) => Number.parseInt(candidate.display_id, 10) === primary.id) ?? sources[0];
    if (!primarySource) return null;
    const sourceDisplayId = Number.parseInt(primarySource.display_id, 10);
    const display = displays.find((candidate) => candidate.id === sourceDisplayId) ?? primary;
    return { source: primarySource, display };
  }

  private readPermission(): ScreenPermission {
    if (process.platform !== 'darwin') return 'unknown';
    try {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (
        status === 'granted' ||
        status === 'denied' ||
        status === 'restricted' ||
        status === 'not-determined'
      ) {
        return status;
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private handleFrameIpc = (event: IpcMainEvent, data: unknown): void => {
    if (!this.window || event.sender !== this.window.webContents) return;

    const buffer = toBuffer(data);
    if (!buffer || buffer.byteLength === 0) {
      this.framesDropped += 1;
      this.logger.warn('capture', 'Ignored empty or malformed capture frame');
      return;
    }
    if (buffer.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
      this.framesDropped += 1;
      this.logger.warn('capture', `Ignored oversized capture frame (${buffer.byteLength} bytes)`);
      return;
    }

    const now = Date.now();
    this.framesCaptured += 1;

    if (this.paused || !this.options.isCaptureAllowed()) {
      this.framesDropped += 1;
      this.logger.debug(
        'capture',
        `Dropped a frame (${this.paused ? 'monitoring paused' : 'engine not ready'})`,
      );
      return;
    }
    if (!this.display) {
      this.framesDropped += 1;
      return;
    }

    this.seq += 1;
    const seq = this.seq;
    let framed: Buffer;
    try {
      framed = encodeFrame(seq, this.display.id >>> 0, now, buffer);
    } catch (error) {
      this.framesDropped += 1;
      this.logger.warn('capture', `Could not frame capture: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (!this.options.sendFrame(framed, seq)) {
      this.framesDropped += 1;
      this.logger.debug('capture', `Dropped frame seq=${seq} (WebSocket not ready)`);
      return;
    }

    this.framesSent += 1;
    this.lastFrameAt = now;
    this.sentTimes.push(now);
    if (this.sentTimes.length > 100) this.sentTimes.splice(0, this.sentTimes.length - 100);
    if (this.state === 'starting') this.setState('running');
    this.error = null;
  };

  private handleReadyIpc = (event: IpcMainEvent, payload: unknown): void => {
    if (!this.window || event.sender !== this.window.webContents) return;
    this.clearReadyTimer();
    if (this.paused) {
      if (this.state !== 'paused') this.setState('paused');
    } else if (this.state !== 'running') {
      this.setState('running');
    }

    let detail = '';
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      if (typeof record.width === 'number' && typeof record.height === 'number') {
        detail = ` (${Math.trunc(record.width)}x${Math.trunc(record.height)})`;
      }
    }
    this.logger.info('capture', `Capture renderer ready${detail}`);
  };

  private handleErrorIpc = (event: IpcMainEvent, payload: unknown): void => {
    if (!this.window || event.sender !== this.window.webContents) return;
    const message = typeof payload === 'string' ? payload.slice(0, 2000) : 'Unknown capture renderer error';
    this.fail(`Capture error: ${message}`);
  };

  private permissionDenied(message: string): void {
    this.error = message;
    this.logger.warn('capture', message);
    this.setState('permission-denied');
  }

  private fail(message: string): void {
    this.error = message;
    this.logger.error('capture', message);
    this.setState('error');
  }

  private setState(state: CaptureState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('change');
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }
}
