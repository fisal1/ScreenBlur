/**
 * Settings renderer. No framework: DOM references are gathered once, config
 * changes are debounced, and status comes from the main process push channel.
 */

import type { AppConfig, AppStatus, LogEntry, OverlayCoverage, OverlayMode } from '../shared/types';

type Tone = 'neutral' | 'good' | 'warn' | 'bad';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const api = window.screenblur;

const refs = {
  statusPill: byId<HTMLSpanElement>('status-pill'),
  statusPillText: byId<HTMLSpanElement>('status-pill-text'),
  updatedAt: byId<HTMLSpanElement>('updated-at'),
  permissionBanner: byId<HTMLDivElement>('permission-banner'),
  permissionTitle: byId<HTMLElement>('permission-title'),
  permissionText: byId<HTMLElement>('permission-text'),
  btnPermission: byId<HTMLButtonElement>('btn-permission'),
  engineState: byId<HTMLSpanElement>('engine-state'),
  engineDetail: byId<HTMLSpanElement>('engine-detail'),
  engineMeta: byId<HTMLSpanElement>('engine-meta'),
  connectionState: byId<HTMLSpanElement>('connection-state'),
  connectionDetail: byId<HTMLSpanElement>('connection-detail'),
  connectionMeta: byId<HTMLSpanElement>('connection-meta'),
  captureState: byId<HTMLSpanElement>('capture-state'),
  captureDetail: byId<HTMLSpanElement>('capture-detail'),
  captureMeta: byId<HTMLSpanElement>('capture-meta'),
  overlayState: byId<HTMLSpanElement>('overlay-state'),
  overlayDetail: byId<HTMLSpanElement>('overlay-detail'),
  overlayMeta: byId<HTMLSpanElement>('overlay-meta'),
  metricLatency: byId<HTMLSpanElement>('metric-latency'),
  metricFps: byId<HTMLSpanElement>('metric-fps'),
  metricSent: byId<HTMLSpanElement>('metric-sent'),
  metricDropped: byId<HTMLSpanElement>('metric-dropped'),
  metricScore: byId<HTMLSpanElement>('metric-score'),
  metricResult: byId<HTMLSpanElement>('metric-result'),
  errorLine: byId<HTMLParagraphElement>('error-line'),
  monitorStatus: byId<HTMLParagraphElement>('monitor-status'),
  btnToggle: byId<HTMLButtonElement>('btn-toggle-monitoring'),
  btnTest: byId<HTMLButtonElement>('btn-test-overlay'),
  btnRestart: byId<HTMLButtonElement>('btn-restart-engine'),
  sensitivity: byId<HTMLInputElement>('sensitivity'),
  sensitivityValue: byId<HTMLOutputElement>('sensitivity-value'),
  fps: byId<HTMLInputElement>('fps'),
  fpsValue: byId<HTMLOutputElement>('fps-value'),
  jpegQuality: byId<HTMLInputElement>('jpeg-quality'),
  jpegQualityValue: byId<HTMLOutputElement>('jpeg-quality-value'),
  maxWidth: byId<HTMLInputElement>('max-width'),
  maxWidthValue: byId<HTMLOutputElement>('max-width-value'),
  hysteresisWindow: byId<HTMLInputElement>('hysteresis-window'),
  hysteresisWindowValue: byId<HTMLOutputElement>('hysteresis-window-value'),
  showThreshold: byId<HTMLInputElement>('show-threshold'),
  showThresholdValue: byId<HTMLOutputElement>('show-threshold-value'),
  hideThreshold: byId<HTMLInputElement>('hide-threshold'),
  hideThresholdValue: byId<HTMLOutputElement>('hide-threshold-value'),
  hysteresisSummary: byId<HTMLParagraphElement>('hysteresis-summary'),
  gifRow: byId<HTMLDivElement>('gif-row'),
  gifPath: byId<HTMLSpanElement>('gif-path'),
  btnChooseGif: byId<HTMLButtonElement>('btn-choose-gif'),
  btnClearGif: byId<HTMLButtonElement>('btn-clear-gif'),
  launchAtLogin: byId<HTMLInputElement>('launch-at-login'),
  autoStart: byId<HTMLInputElement>('auto-start'),
  startPaused: byId<HTMLInputElement>('start-paused'),
  logs: byId<HTMLPreElement>('logs'),
  autoScroll: byId<HTMLInputElement>('auto-scroll'),
  btnRefreshLogs: byId<HTMLButtonElement>('btn-refresh-logs'),
  toast: byId<HTMLDivElement>('toast'),
};

let currentStatus: AppStatus | null = null;
let pendingPatch: Partial<AppConfig> = {};
let patchTimer: number | null = null;
let toastTimer: number | null = null;
let logsInFlight = false;

function toneForEngine(state: AppStatus['engine']['state']): Tone {
  switch (state) {
    case 'running':
    case 'external':
      return 'good';
    case 'starting':
    case 'restarting':
      return 'warn';
    case 'error':
      return 'bad';
    default:
      return 'neutral';
  }
}

function engineLabel(state: AppStatus['engine']['state']): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'external':
      return 'External';
    case 'starting':
      return 'Starting…';
    case 'restarting':
      return 'Restarting…';
    case 'error':
      return 'Error';
    default:
      return 'Stopped';
  }
}

function labelForCapture(state: AppStatus['capture']['state']): { text: string; tone: Tone } {
  switch (state) {
    case 'running':
      return { text: 'Capturing', tone: 'good' };
    case 'starting':
      return { text: 'Starting…', tone: 'warn' };
    case 'paused':
      return { text: 'Paused', tone: 'warn' };
    case 'permission-denied':
      return { text: 'Permission needed', tone: 'bad' };
    case 'error':
      return { text: 'Error', tone: 'bad' };
    default:
      return { text: 'Stopped', tone: 'neutral' };
  }
}

function labelForConnection(state: AppStatus['connection']['state']): { text: string; tone: Tone } {
  switch (state) {
    case 'ready':
      return { text: 'Ready', tone: 'good' };
    case 'connecting':
      return { text: 'Connecting…', tone: 'warn' };
    case 'handshaking':
      return { text: 'Handshaking…', tone: 'warn' };
    case 'error':
      return { text: 'Error', tone: 'bad' };
    default:
      return { text: 'Disconnected', tone: 'neutral' };
  }
}

function setValue(element: HTMLElement, text: string, tone: Tone = 'neutral'): void {
  element.textContent = text;
  element.dataset.tone = tone;
}

function formatRelative(timestamp: number | null): string {
  if (timestamp === null) return '—';
  const delta = Date.now() - timestamp;
  if (delta < 1500) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return new Date(timestamp).toLocaleTimeString();
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function showToast(message: string, isError = false): void {
  refs.toast.textContent = message;
  refs.toast.classList.toggle('error', isError);
  refs.toast.classList.add('show');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = null;
    refs.toast.classList.remove('show');
  }, isError ? 5200 : 2600);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyStatus(status: AppStatus): void {
  currentStatus = status;
  const permission = status.permission;

  refs.updatedAt.textContent = `Updated ${new Date(status.updatedAt).toLocaleTimeString()}`;

  setValue(refs.engineState, engineLabel(status.engine.state), toneForEngine(status.engine.state));
  const engineParts: string[] = [];
  if (status.engine.version) engineParts.push(`v${status.engine.version}`);
  if (status.engine.detector) engineParts.push(`${status.engine.detector} detector`);
  if (status.engine.models.length) engineParts.push(`${status.engine.models.length} model(s)`);
  refs.engineDetail.textContent = engineParts.join(' · ') || 'No engine information yet';
  const engineMeta: string[] = [];
  if (status.engine.port) engineMeta.push(`127.0.0.1:${status.engine.port}`);
  if (status.engine.pid) engineMeta.push(`pid ${status.engine.pid}`);
  if (!status.engine.managed) engineMeta.push('external');
  if (status.engine.restartAttempts > 0) engineMeta.push(`${status.engine.restartAttempts} restart(s)`);
  refs.engineMeta.textContent = engineMeta.join(' · ');

  const connection = labelForConnection(status.connection.state);
  setValue(refs.connectionState, connection.text, connection.tone);
  const connectionDetail: string[] = [];
  if (status.connection.latencyMs !== null) connectionDetail.push(`${Math.round(status.connection.latencyMs)} ms RTT`);
  if (status.connection.reconnectAttempts > 0) connectionDetail.push(`reconnect ${status.connection.reconnectAttempts}`);
  if (status.connection.lastError) connectionDetail.push(status.connection.lastError);
  refs.connectionDetail.textContent = connectionDetail.join(' · ') || 'Loopback WebSocket idle';
  refs.connectionMeta.textContent =
    status.connection.lastResultAt !== null
      ? `last result ${formatRelative(status.connection.lastResultAt)} · seq ${status.connection.lastSentSeq}`
      : 'no frames sent yet';

  const capture = labelForCapture(status.capture.state);
  setValue(refs.captureState, capture.text, capture.tone);
  refs.captureDetail.textContent = status.capture.displayName
    ? `${status.capture.displayName}${status.capture.displayId ? ` · display ${status.capture.displayId}` : ''}`
    : 'No active capture source';
  refs.captureMeta.textContent =
    status.capture.error ??
    `${status.capture.framesCaptured} captured · ${status.capture.framesDropped} dropped`;

  const overlayVisible = status.monitoring.overlayVisible;
  setValue(
    refs.overlayState,
    overlayVisible ? 'Showing' : 'Hidden',
    overlayVisible ? 'warn' : 'neutral',
  );
  refs.overlayDetail.textContent =
    status.monitoring.overlayMode === 'gif' ? 'GIF / image overlay' : 'Frosted blur overlay';
  refs.overlayMeta.textContent =
    status.monitoring.lastScore !== null
      ? `last score ${Math.round(status.monitoring.lastScore * 100)}% · seq ${status.monitoring.lastSeq ?? '—'}`
      : 'no detection result yet';

  refs.metricLatency.textContent =
    status.connection.latencyMs !== null ? `${Math.round(status.connection.latencyMs)} ms` : '—';
  refs.metricFps.textContent =
    status.capture.state === 'running' ? status.capture.actualFps.toFixed(1) : '—';
  refs.metricSent.textContent = String(status.capture.framesSent);
  refs.metricDropped.textContent = String(status.capture.framesDropped);
  refs.metricScore.textContent =
    status.monitoring.lastScore !== null ? `${Math.round(status.monitoring.lastScore * 100)}%` : '—';
  refs.metricResult.textContent = formatRelative(status.monitoring.lastResultAt);

  const showPermission = status.permissionNeedsAction;
  refs.permissionBanner.hidden = !showPermission;
  if (showPermission) {
    if (permission === 'denied' || permission === 'restricted') {
      refs.permissionTitle.textContent = 'Screen Recording permission denied';
      refs.permissionText.textContent =
        'Enable ScreenBlur under System Settings → Privacy & Security → Screen Recording, then quit and reopen the app.';
    } else {
      refs.permissionTitle.textContent = 'Screen Recording permission needed';
      refs.permissionText.textContent =
        'macOS requires Screen Recording access before ScreenBlur can capture the screen. Grant it, then restart the app.';
    }
  }

  const errors = [status.capture.error, status.engine.lastError, status.connection.lastError].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  refs.errorLine.hidden = errors.length === 0;
  refs.errorLine.textContent = errors[0] ?? '';

  if (status.monitoring.paused) {
    refs.monitorStatus.textContent = 'Monitoring is paused. Capture and the overlay are stopped.';
    refs.btnToggle.textContent = 'Resume monitoring';
    refs.btnToggle.className = 'button primary';
    setStatusPill('Paused', 'warn');
  } else if (status.capture.state === 'permission-denied') {
    refs.monitorStatus.textContent = 'Capture is blocked until Screen Recording permission is granted.';
    refs.btnToggle.textContent = 'Pause monitoring';
    refs.btnToggle.className = 'button secondary';
    setStatusPill('Permission needed', 'bad');
  } else if (status.engine.state === 'error') {
    refs.monitorStatus.textContent = 'The local engine is not running. Restart it from the tray or this window.';
    refs.btnToggle.textContent = 'Pause monitoring';
    refs.btnToggle.className = 'button secondary';
    setStatusPill('Engine error', 'bad');
  } else if (status.connection.state === 'ready' && status.capture.state === 'running') {
    refs.monitorStatus.textContent = `Monitoring is active at ${status.capture.actualFps.toFixed(1)} FPS.`;
    refs.btnToggle.textContent = 'Pause monitoring';
    refs.btnToggle.className = 'button secondary';
    setStatusPill('Monitoring', 'good');
  } else {
    refs.monitorStatus.textContent = 'Waiting for the local engine and capture pipeline…';
    refs.btnToggle.textContent = 'Pause monitoring';
    refs.btnToggle.className = 'button secondary';
    setStatusPill('Connecting…', 'warn');
  }
}

function setStatusPill(text: string, tone: Tone): void {
  refs.statusPillText.textContent = text;
  refs.statusPill.dataset.tone = tone;
}

function setRange(input: HTMLInputElement, output: HTMLOutputElement, value: number, text: string): void {
  input.value = String(value);
  output.textContent = text;
}

function applyConfig(config: AppConfig): void {
  setRange(refs.sensitivity, refs.sensitivityValue, config.sensitivity, config.sensitivity.toFixed(2));
  setRange(refs.fps, refs.fpsValue, config.fps, `${config.fps} FPS`);
  setRange(refs.jpegQuality, refs.jpegQualityValue, config.jpegQuality, String(config.jpegQuality));
  setRange(refs.maxWidth, refs.maxWidthValue, config.maxWidth, `${config.maxWidth} px`);
  setRange(
    refs.hysteresisWindow,
    refs.hysteresisWindowValue,
    config.hysteresisWindow,
    String(config.hysteresisWindow),
  );
  setRange(refs.showThreshold, refs.showThresholdValue, config.showThreshold, String(config.showThreshold));
  setRange(refs.hideThreshold, refs.hideThresholdValue, config.hideThreshold, String(config.hideThreshold));

  refs.showThreshold.max = String(config.hysteresisWindow);
  refs.hideThreshold.max = String(config.showThreshold);

  refs.hysteresisSummary.textContent = `Shows after ${config.showThreshold} positive result(s) in the last ${config.hysteresisWindow}. Hides once positives fall below ${config.hideThreshold}.`;

  refs.gifRow.hidden = config.overlayMode !== 'gif';
  refs.gifPath.textContent = config.overlayGifPath ? baseName(config.overlayGifPath) : 'No image selected';
  refs.gifPath.title = config.overlayGifPath;
  refs.launchAtLogin.checked = config.launchAtLogin;
  refs.autoStart.checked = config.autoStart;
  refs.startPaused.checked = config.startPaused;

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="overlay-mode"]')) {
    radio.checked = radio.value === config.overlayMode;
  }
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="overlay-coverage"]')) {
    radio.checked = radio.value === config.overlayCoverage;
  }
}

function schedulePatch(patch: Partial<AppConfig>): void {
  pendingPatch = { ...pendingPatch, ...patch };
  if (patchTimer) window.clearTimeout(patchTimer);
  patchTimer = window.setTimeout(() => {
    patchTimer = null;
    void flushPatch();
  }, 220);
}

async function flushPatch(): Promise<void> {
  if (Object.keys(pendingPatch).length === 0) return;
  const patch = pendingPatch;
  pendingPatch = {};
  try {
    const next = await api.updateConfig(patch);
    applyConfig(next);
  } catch (error) {
    showToast(`Could not save settings: ${errorMessage(error)}`, true);
  }
}

function commit(patch: Partial<AppConfig>): void {
  if (patchTimer) {
    window.clearTimeout(patchTimer);
    patchTimer = null;
  }
  void (async () => {
    try {
      const next = await api.updateConfig(patch);
      applyConfig(next);
    } catch (error) {
      showToast(`Could not save settings: ${errorMessage(error)}`, true);
    }
  })();
}

function bindAction(button: HTMLButtonElement, action: () => Promise<void>): void {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    action()
      .catch((error: unknown) => {
        showToast(errorMessage(error), true);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

function bindRange(
  input: HTMLInputElement,
  output: HTMLOutputElement,
  format: (value: number) => string,
  patch: (value: number) => Partial<AppConfig>,
): void {
  input.addEventListener('input', () => {
    const value = Number(input.value);
    output.textContent = format(value);
    schedulePatch(patch(value));
  });
  input.addEventListener('change', () => {
    if (patchTimer) {
      window.clearTimeout(patchTimer);
      patchTimer = null;
    }
    void flushPatch();
  });
}

async function refreshLogs(): Promise<void> {
  if (logsInFlight) return;
  logsInFlight = true;
  try {
    const entries: LogEntry[] = await api.getLogs();
    if (entries.length === 0) {
      refs.logs.textContent = 'No log entries yet.';
      return;
    }
    refs.logs.textContent = entries
      .map((entry) => {
        const time = new Date(entry.ts).toLocaleTimeString(undefined, { hour12: false });
        const level = entry.level.toUpperCase().padEnd(5);
        const source = entry.source.padEnd(8);
        return `${time}  ${level} ${source} ${entry.message}`;
      })
      .join('\n');
    if (refs.autoScroll.checked) refs.logs.scrollTop = refs.logs.scrollHeight;
  } catch (error) {
    refs.logs.textContent = `Could not load logs: ${errorMessage(error)}`;
  } finally {
    logsInFlight = false;
  }
}

function wireControls(): void {
  bindRange(
    refs.sensitivity,
    refs.sensitivityValue,
    (value) => value.toFixed(2),
    (value) => ({ sensitivity: value }),
  );
  bindRange(
    refs.fps,
    refs.fpsValue,
    (value) => `${value} FPS`,
    (value) => ({ fps: value }),
  );
  bindRange(
    refs.jpegQuality,
    refs.jpegQualityValue,
    (value) => String(value),
    (value) => ({ jpegQuality: value }),
  );
  bindRange(
    refs.maxWidth,
    refs.maxWidthValue,
    (value) => `${value} px`,
    (value) => ({ maxWidth: value }),
  );
  bindRange(
    refs.hysteresisWindow,
    refs.hysteresisWindowValue,
    (value) => String(value),
    (value) => ({ hysteresisWindow: value }),
  );
  bindRange(
    refs.showThreshold,
    refs.showThresholdValue,
    (value) => String(value),
    (value) => ({ showThreshold: value }),
  );
  bindRange(
    refs.hideThreshold,
    refs.hideThresholdValue,
    (value) => String(value),
    (value) => ({ hideThreshold: value }),
  );

  refs.launchAtLogin.addEventListener('change', () => commit({ launchAtLogin: refs.launchAtLogin.checked }));
  refs.autoStart.addEventListener('change', () => commit({ autoStart: refs.autoStart.checked }));
  refs.startPaused.addEventListener('change', () => commit({ startPaused: refs.startPaused.checked }));

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="overlay-mode"]')) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const mode = radio.value as OverlayMode;
      commit({ overlayMode: mode });
      refs.gifRow.hidden = mode !== 'gif';
    });
  }

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="overlay-coverage"]')) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      commit({ overlayCoverage: radio.value as OverlayCoverage });
    });
  }

  bindAction(refs.btnPermission, async () => {
    await api.openPermissionSettings();
    showToast('Opening System Settings. Restart ScreenBlur after changing permission.');
  });

  bindAction(refs.btnToggle, async () => {
    if (currentStatus?.monitoring.paused) {
      await api.resume();
      showToast('Monitoring resumed');
    } else {
      await api.pause();
      showToast('Monitoring paused');
    }
  });

  bindAction(refs.btnTest, async () => {
    await api.testOverlay();
    showToast('Overlay shown for 3 seconds');
  });

  bindAction(refs.btnRestart, async () => {
    await api.restartEngine();
    showToast('Engine restart requested');
  });

  bindAction(refs.btnChooseGif, async () => {
    const path = await api.chooseGif();
    if (!path) return;
    await api.updateConfig({ overlayGifPath: path, overlayMode: 'gif' });
    showToast(`Overlay image set to ${baseName(path)}`);
  });

  bindAction(refs.btnClearGif, async () => {
    await api.updateConfig({ overlayGifPath: '' });
    showToast('Overlay image cleared');
  });

  refs.btnRefreshLogs.addEventListener('click', () => {
    void refreshLogs();
  });
}

async function main(): Promise<void> {
  wireControls();

  const unsubscribeStatus = api.onStatus((status) => applyStatus(status));
  const unsubscribeConfig = api.onConfig((config) => applyConfig(config));

  window.addEventListener('beforeunload', () => {
    unsubscribeStatus();
    unsubscribeConfig();
  });

  try {
    const [status, config] = await Promise.all([api.getStatus(), api.getConfig()]);
    applyConfig(config);
    applyStatus(status);
  } catch (error) {
    showToast(`Could not reach the main process: ${errorMessage(error)}`, true);
  }

  await refreshLogs();
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshLogs();
  }, 4000);
}

void main().catch((error: unknown) => {
  showToast(errorMessage(error), true);
  refs.logs.textContent = `Renderer failed to start: ${errorMessage(error)}`;
});
