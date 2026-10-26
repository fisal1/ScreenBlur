import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  powerMonitor,
  shell,
} from 'electron';

import type {
  AppConfig,
  AppStatus,
  CaptureStatus,
  ConnectionStatus,
  EngineResultMessage,
  EngineStatus,
  MonitoringStatus,
  ReadyMessage,
  ScreenPermission,
} from '../shared/types';
import { CaptureManager } from './capture';
import { ConfigStore } from './config';
import { installEngine, installerConfig } from './engineInstaller';
import { Hysteresis, StaleSeqFilter } from './hysteresis';
import { IpcBridge } from './ipc';
import { logger } from './logger';
import { OverlayManager } from './overlay';
import { loadPage, preloadPath } from './paths';
import { SidecarManager, type SidecarTarget } from './sidecar';
import { TrayManager } from './tray';
import { WsClient } from './wsClient';

const STATUS_INTERVAL_MS = 1000;

function engineLabel(state: EngineStatus['state']): string {
  switch (state) {
    case 'external':
      return 'external';
    case 'running':
      return 'ready';
    case 'restarting':
      return 'restarting';
    default:
      return state;
  }
}

function defaultConnectionStatus(): ConnectionStatus {
  return {
    state: 'disconnected',
    reconnectAttempts: 0,
    lastError: null,
    latencyMs: null,
    lastResultAt: null,
    lastSentSeq: 0,
  };
}

function defaultCaptureStatus(permission: ScreenPermission): CaptureStatus {
  return {
    state: 'stopped',
    displayId: null,
    displayName: null,
    framesCaptured: 0,
    framesSent: 0,
    framesDropped: 0,
    actualFps: 0,
    lastFrameAt: null,
    permission,
    error: null,
  };
}

class ScreenBlurApp {
  private configStore: ConfigStore | null = null;
  private config: AppConfig | null = null;

  private sidecar: SidecarManager | null = null;
  private ws: WsClient | null = null;
  private capture: CaptureManager | null = null;
  private overlay: OverlayManager | null = null;
  private tray: TrayManager | null = null;
  private ipcBridge: IpcBridge | null = null;

  private hysteresis: Hysteresis | null = null;
  private staleSeq = new StaleSeqFilter();

  private settingsWindow: BrowserWindow | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private engineInfo: ReadyMessage | null = null;

  private monitoringPaused = true;
  private engineRequested = false;
  private lastScore: number | null = null;
  private lastResultAt: number | null = null;

  private quitting = false;
  private shutdownStarted = false;

  async start(): Promise<void> {
    app.setName('ScreenBlur');
    if (process.platform === 'darwin') app.dock?.hide();
    app.setAppUserModelId('com.screenblur.desktop');

    this.configStore = new ConfigStore();
    this.config = this.configStore.load();
    this.monitoringPaused = !this.config.autoStart || this.config.startPaused;
    this.engineRequested = this.config.autoStart;

    logger.info(
      'app',
      `ScreenBlur ${app.getVersion()} starting (${app.isPackaged ? 'packaged' : 'development'})`,
    );

    this.hysteresis = new Hysteresis({
      windowSize: this.config.hysteresisWindow,
      showThreshold: this.config.showThreshold,
      hideThreshold: this.config.hideThreshold,
    });

    this.createIpcBridge();
    this.createSettingsWindow();
    this.createPipeline();
    this.registerGlobalShortcuts();
    this.registerAppLifecycle();
    this.applyLoginItemSettings(this.config.launchAtLogin);
    this.wireConfigStore();

    this.statusTimer = setInterval(() => this.pushStatus(), STATUS_INTERVAL_MS);
    this.statusTimer.unref();

    if (this.configStore?.isFirstRun) {
      logger.info('app', 'First run: opening settings');
      this.showSettings();
    }

    this.pushStatus();
    this.tray?.update();

    if (this.config.autoStart) {
      logger.info('app', 'Auto-start enabled; launching engine and monitoring');
      this.sidecar?.start();
    } else {
      logger.info('app', 'Auto-start disabled; engine will start when monitoring resumes');
    }

    if (this.config.startPaused && this.config.autoStart) {
      logger.info('app', 'Started paused by configuration');
    }

    void this.maybeInstallEngine();
  }

  showSettings(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      if (this.settingsWindow.isMinimized()) this.settingsWindow.restore();
      this.settingsWindow.show();
      this.settingsWindow.focus();
      return;
    }
    this.createSettingsWindow();
  }

  private createIpcBridge(): void {
    this.ipcBridge = new IpcBridge({
      logger,
      getStatus: () => this.buildStatus(),
      getConfig: () => this.currentConfig(),
      updateConfig: (patch) => {
        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
          throw new Error('Config patch must be an object');
        }
        return this.configStore?.update(patch) ?? this.currentConfig();
      },
      pause: () => this.pauseMonitoring(),
      resume: () => this.beginMonitoring(),
      restartEngine: () => this.restartEngine(),
      testOverlay: () => this.overlay?.test(3000),
      openPermissionSettings: () => this.openPermissionSettings(),
      getLogs: () => logger.getEntries(200),
    });
    this.ipcBridge.register();
  }

  private createSettingsWindow(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.ipcBridge?.setSettingsWindow(this.settingsWindow);
      return;
    }

    const window = new BrowserWindow({
      width: 960,
      height: 820,
      minWidth: 760,
      minHeight: 620,
      show: false,
      title: 'ScreenBlur',
      backgroundColor: '#0b0d12',
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath('index'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        spellcheck: false,
        devTools: Boolean(process.env.SCREENBLUR_DEV_SERVER_URL),
      },
    });

    this.settingsWindow = window;
    this.ipcBridge?.setSettingsWindow(window);

    window.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });

    window.on('closed', () => {
      if (this.settingsWindow === window) this.settingsWindow = null;
      this.ipcBridge?.setSettingsWindow(null);
    });

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());

    void loadPage(window, 'renderer').catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('app', `Could not load settings window: ${message}`);
    });
  }

  private createPipeline(): void {
    this.overlay = new OverlayManager({
      logger,
      getConfig: () => this.currentConfig(),
    });

    this.capture = new CaptureManager({
      logger,
      getConfig: () => this.currentConfig(),
      isCaptureAllowed: () => this.ws?.getStatus().state === 'ready' && !this.monitoringPaused,
      sendFrame: (frame, seq) => this.ws?.sendFrame(frame, seq) ?? false,
    });
    this.capture.on('change', () => {
      this.pushStatus();
      this.tray?.update();
    });

    this.sidecar = new SidecarManager({
      appPath: app.getAppPath(),
      userDataDir: app.getPath('userData'),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      logger,
    });

    this.sidecar.on('port', (target: SidecarTarget) => this.connectEngine(target));
    this.sidecar.on('state', () => {
      this.pushStatus();
      this.tray?.update();
      if (this.sidecar && this.sidecar.stateValue !== 'running' && this.sidecar.stateValue !== 'external') {
        this.capture?.setPaused(true);
        this.overlay?.hide();
      }
    });
    this.sidecar.on('exit', () => {
      logger.warn('app', 'Engine process exited; pausing capture');
      this.engineInfo = null;
      this.ws?.close();
      this.capture?.setPaused(true);
      this.overlay?.hide();
      this.pushStatus();
    });

    this.tray = new TrayManager({
      getSnapshot: () => {
        const captureState = this.capture?.getStatus().state ?? 'stopped';
        const engineState = this.sidecar?.stateValue ?? 'stopped';
        return {
          engine: engineLabel(engineState),
          capture: captureState,
          paused: this.monitoringPaused,
          launchAtLogin: this.currentConfig().launchAtLogin,
        };
      },
      onTogglePause: () => {
        if (this.monitoringPaused) this.beginMonitoring();
        else this.pauseMonitoring();
      },
      onTestOverlay: () => this.overlay?.test(3000),
      onOpenSettings: () => this.showSettings(),
      onRestartEngine: () => this.restartEngine(),
      onToggleLaunchAtLogin: (enabled) => {
        this.configStore?.update({ launchAtLogin: enabled });
      },
      onQuit: () => app.quit(),
    });
  }

  private connectEngine(target: SidecarTarget): void {
    if (!this.ws) {
      this.ws = new WsClient({ url: target.url, token: target.token, logger });
      this.wireWsEvents(this.ws);
    }
    this.ws.connect(target.url, target.token);
  }

  private wireWsEvents(client: WsClient): void {
    client.on('connection', (status: ConnectionStatus) => {
      if (status.state !== 'ready') {
        this.capture?.setPaused(true);
        if (status.state === 'disconnected' || status.state === 'error') this.overlay?.hide();
      }
      this.pushStatus();
      this.tray?.update();
    });

    client.on('ready', (ready: ReadyMessage) => {
      this.engineInfo = ready;
      // A restarted engine starts its sequence numbers from zero; a fresh
      // connection must not inherit the previous session's stale-result or
      // hysteresis state.
      this.staleSeq.reset();
      this.hysteresis?.reset();
      this.lastScore = null;
      this.lastResultAt = null;
      logger.info(
        'app',
        `Engine ready (v${ready.version}, protocol ${ready.protocol}, detector ${ready.detector})`,
      );

      if (this.engineRequested && !this.monitoringPaused) {
        client.sendConfig(this.currentConfig());
        client.sendControl({ type: 'resume' });
        this.capture?.setPaused(false);
      } else {
        client.sendControl({ type: 'pause' });
        this.capture?.setPaused(true);
      }
      this.pushStatus();
    });

    client.on('result', (result: EngineResultMessage) => {
      this.handleResult(result);
    });

    client.on('engine-error', () => {
      this.pushStatus();
    });

    client.on('pong', () => {
      this.pushStatus();
    });
  }

  private handleResult(result: EngineResultMessage): void {
    if (this.monitoringPaused) return;
    if (!this.staleSeq.accept(result.seq)) {
      logger.debug('app', `Ignoring stale result seq=${result.seq}`);
      return;
    }

    this.lastScore = result.score;
    this.lastResultAt = Date.now();

    const wasVisible = this.hysteresis?.visible ?? false;
    const visible = this.hysteresis?.add(result.show) ?? false;
    const options = this.hysteresis?.optionsSnapshot;
    const positives = this.hysteresis?.positives ?? 0;
    const samples = this.hysteresis?.size ?? 0;
    const cover =
      this.currentConfig().overlayCoverage === 'detected' && result.boxes.length > 0
        ? 'detected'
        : 'full';

    // Emit one line per engine result so the Settings log panel shows exactly
    // what the detector reported and why the overlay changed. Do not include
    // frame bytes or bounding-box contents; those can contain screen data.
    logger.info(
      'app',
      `detect seq=${result.seq} score=${result.score.toFixed(3)} verdict=${result.show ? 'positive' : 'negative'} window=${positives}/${samples} overlay=${visible ? 'on' : 'off'} cover=${cover} latency=${result.latency_ms}ms boxes=${result.boxes.length}${result.superseded ? ' superseded' : ''}`,
    );

    if (visible) {
      this.overlay?.show(result.score, result.boxes, result.display_id);
    } else if (wasVisible || this.overlay?.visible) {
      this.overlay?.hide();
    }

    if (visible !== wasVisible) {
      logger.info(
        'app',
        `Overlay ${visible ? 'shown' : 'hidden'} (score ${result.score.toFixed(2)}, window ${positives}/${samples}${options ? `, show>=${options.showThreshold}, hide<${options.hideThreshold}` : ''})`,
      );
    }
    this.pushStatus();
    this.tray?.update();
  }

  private beginMonitoring(): void {
    this.engineRequested = true;
    this.monitoringPaused = false;
    this.hysteresis?.reset();
    this.staleSeq.reset();
    this.lastScore = null;

    if (this.sidecar) {
      const state = this.sidecar.stateValue;
      if (this.sidecar.isExternal) {
        if (!this.ws) this.sidecar.start();
      } else if (state === 'stopped' || state === 'error') {
        this.sidecar.start();
      }
    }

    if (this.ws?.getStatus().state === 'ready') {
      this.ws.sendConfig(this.currentConfig());
      this.ws.sendControl({ type: 'resume' });
      this.capture?.setPaused(false);
    }

    logger.info('app', 'Monitoring resumed');
    this.pushStatus();
    this.tray?.update();
  }

  private pauseMonitoring(): void {
    this.monitoringPaused = true;
    this.ws?.sendControl({ type: 'pause' });
    this.capture?.setPaused(true);
    this.overlay?.hide();
    this.hysteresis?.reset();
    this.staleSeq.reset();
    this.lastScore = null;
    logger.info('app', 'Monitoring paused');
    this.pushStatus();
    this.tray?.update();
  }

  private restartEngine(): void {
    this.engineInfo = null;
    this.hysteresis?.reset();
    this.staleSeq = new StaleSeqFilter();
    this.lastScore = null;
    this.lastResultAt = null;
    this.overlay?.hide();
    this.capture?.setPaused(true);
    logger.info('app', 'Restarting engine');
    this.sidecar?.restart();
    this.pushStatus();
  }

  private openPermissionSettings(): void {
    let target = '';
    if (process.platform === 'darwin') {
      target = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    } else if (process.platform === 'win32') {
      target = 'ms-settings:privacy';
    }

    if (target) {
      void shell.openExternal(target).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('app', `Could not open system settings: ${message}`);
      });
    } else {
      logger.info('app', 'This platform has no dedicated screen-capture permission pane');
    }

    this.capture?.requestPermission();
    setTimeout(() => this.pushStatus(), 1000);
  }

  private registerGlobalShortcuts(): void {
    const shortcuts: Array<[string, () => void]> = [
      [
        'CommandOrControl+Shift+B',
        () => {
          if (this.monitoringPaused) this.beginMonitoring();
          else this.pauseMonitoring();
        },
      ],
      ['CommandOrControl+Shift+O', () => this.overlay?.test(3000)],
      ['CommandOrControl+Shift+,', () => this.showSettings()],
    ];

    for (const [accelerator, handler] of shortcuts) {
      try {
        const ok = globalShortcut.register(accelerator, handler);
        if (!ok) logger.warn('app', `Global shortcut ${accelerator} is already in use`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('app', `Could not register ${accelerator}: ${message}`);
      }
    }
  }

  private registerAppLifecycle(): void {
    app.on('activate', () => this.showSettings());
    app.on('window-all-closed', () => {
      // Tray app: keep running with no windows.
    });
    powerMonitor.on('resume', () => {
      logger.info('app', 'System resumed; reconnecting engine socket');
      const target = this.sidecar?.getTarget();
      if (target && this.ws) this.ws.connect(target.url, target.token);
    });
  }

  private wireConfigStore(): void {
    this.configStore?.subscribe((next) => this.applyConfig(next));
  }

  private applyConfig(next: AppConfig): void {
    const previous = this.config;
    this.config = next;

    this.hysteresis?.updateOptions({
      windowSize: next.hysteresisWindow,
      showThreshold: next.showThreshold,
      hideThreshold: next.hideThreshold,
    });
    this.capture?.updateConfig(next);
    if (previous && previous.displayId !== next.displayId) {
      void this.capture?.changeDisplay(next.displayId);
    }
    this.overlay?.refreshConfig();

    if (!previous || previous.launchAtLogin !== next.launchAtLogin) {
      this.applyLoginItemSettings(next.launchAtLogin);
    }

    if (this.ws?.getStatus().state === 'ready') {
      this.ws.sendConfig(next);
    }

    this.ipcBridge?.broadcastConfig(next);
    this.pushStatus();
    this.tray?.update();
  }

  private applyLoginItemSettings(enabled: boolean): void {
    if (!app.isPackaged) {
      logger.debug('app', 'Skipping launch-at-login registration in development');
      return;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
      logger.info('app', `Launch at login ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('app', `Could not update launch-at-login setting: ${message}`);
    }
  }

  private buildStatus(): AppStatus {
    const config = this.currentConfig();
    const captureStatus = this.capture?.getStatus() ?? defaultCaptureStatus('unknown');
    const connection = this.ws?.getStatus() ?? defaultConnectionStatus();
    const permission = captureStatus.permission;

    const engine: EngineStatus = {
      state: this.sidecar?.stateValue ?? 'stopped',
      managed: !(this.sidecar?.isExternal ?? false),
      port: this.sidecar?.enginePort ?? null,
      pid: this.sidecar?.enginePid ?? null,
      version: this.engineInfo?.version ?? null,
      models: this.engineInfo?.models ?? [],
      detector: this.engineInfo?.detector ?? null,
      lastError: this.sidecar?.error ?? connection.lastError,
      restartAttempts: this.sidecar?.attempts ?? 0,
    };

    const monitoring: MonitoringStatus = {
      paused: this.monitoringPaused,
      overlayVisible: this.overlay?.visible ?? false,
      overlayMode: config.overlayMode,
      lastScore: this.lastScore,
      lastSeq: this.staleSeq.lastApplied >= 0 ? this.staleSeq.lastApplied : null,
      lastResultAt: this.lastResultAt,
    };

    return {
      engine,
      connection,
      capture: captureStatus,
      monitoring,
      permission,
      permissionNeedsAction: process.platform === 'darwin' && permission !== 'granted',
      updatedAt: Date.now(),
    };
  }

  private pushStatus(): void {
    if (!this.ipcBridge) return;
    const status = this.buildStatus();
    this.ipcBridge.broadcastStatus(status);
    this.tray?.update();
  }

  private currentConfig(): AppConfig {
    if (this.config) return this.config;
    if (this.configStore) return this.configStore.get();
    throw new Error('Configuration not loaded yet');
  }

  private async maybeInstallEngine(): Promise<void> {
    if (!app.isPackaged) return;
    if (!installerConfig()) return;

    const binary = process.platform === 'win32' ? 'screenblur-engine.exe' : 'screenblur-engine';
    const bundled = join(process.resourcesPath, 'engine', binary);
    const downloaded = join(app.getPath('userData'), 'bin', binary);
    if (existsSync(bundled) || existsSync(downloaded)) return;

    const installed = await installEngine({
      userDataDir: app.getPath('userData'),
      logger,
      onProgress: (progress) => {
        if (progress.percent !== null && progress.percent % 25 === 0) {
          logger.info('app', `Engine download ${progress.percent}%`);
        }
      },
    });
    if (installed) {
      logger.info('app', 'Engine installed; restarting sidecar');
      this.sidecar?.restart();
    }
  }

  beforeQuit(event: { preventDefault: () => void }): void {
    this.quitting = true;
    if (this.shutdownStarted) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    this.shutdownStarted = true;
    void this.shutdown().finally(() => app.exit(0));
  }

  private async shutdown(): Promise<void> {
    logger.info('app', 'Shutting down');
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    globalShortcut.unregisterAll();

    this.overlay?.dispose();
    this.capture?.dispose();
    this.ws?.dispose();
    await this.sidecar?.dispose();
    this.tray?.dispose();
    this.ipcBridge?.dispose();

    this.overlay = null;
    this.capture = null;
    this.ws = null;
    this.sidecar = null;
    this.tray = null;
    this.ipcBridge = null;
    logger.info('app', 'Shutdown complete');
  }
}

const controller = new ScreenBlurApp();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => controller.showSettings());
  app.on('before-quit', (event) => controller.beforeQuit(event));
  app.on('window-all-closed', () => {
    // Keep the tray app alive.
  });

  app
    .whenReady()
    .then(() => controller.start())
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      logger.error('app', `Fatal startup error: ${message}`);
      dialog.showErrorBox('ScreenBlur could not start', message);
      app.quit();
    });
}
