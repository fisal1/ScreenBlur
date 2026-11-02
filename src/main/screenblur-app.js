const { EventEmitter } = require('node:events');
const path = require('node:path');
const { app, screen, powerMonitor } = require('electron');
const {
  SENSITIVITY_PRESETS,
  THRESHOLD_PERCENT_RANGE,
  clampThresholdPercent,
  thresholdsFromPercent,
} = require('./sensitivity');
const { RegionTracker } = require('./region-tracker');
const { resolveEngine, PERFORMANCE_MODES } = require('./engine-profile');
const { MODELS, DEFAULT_MODEL_ID } = require('../inference/models');
const { InferenceHost } = require('./inference-host');
const { CaptureHost } = require('./capture-host');
const { OverlayManager } = require('./overlay');
const { modelInputSize } = require('./model-input');
const { TrayController } = require('./tray');
const { SettingsStore } = require('./settings-store');
const { SettingsWindow } = require('./settings-window');
const { registerHotkeys, unregisterHotkeys } = require('./hotkeys');
const { hasScreenRecordingPermission, explainScreenRecordingPermission } = require('./permissions');

const MINUTE_MS = 60_000;

/**
 * Orchestrates capture -> inference -> region tracking -> overlay, plus user controls.
 *
 * Events: result(msg) for every inference result (used by the self-test).
 */
class ScreenBlurApp extends EventEmitter {
  constructor(config, { showTray = true, overlayEnabled = true } = {}) {
    super();
    this.config = config;
    this.showTray = showTray;
    this.overlayEnabled = overlayEnabled;

    this.settings = new SettingsStore(path.join(app.getPath('userData'), config.settingsFileName), {
      thresholdPercent: SENSITIVITY_PRESETS.balanced,
      modelId: DEFAULT_MODEL_ID,
      performanceMode: PERFORMANCE_MODES.best.id,
    });
    const thresholdPercent = clampThresholdPercent(this.settings.get('thresholdPercent'));
    this.engine = resolveEngine(config, {
      modelId: this.settings.get('modelId'),
      performanceMode: this.settings.get('performanceMode'),
    });

    this.regions = new RegionTracker({ ...config.regionTracking, ...thresholdsFromPercent(thresholdPercent) });
    this.inference = new InferenceHost(config, this.engine, this.createBackendMemory(this.engine.model.id));
    this.capture = new CaptureHost(config);
    this.overlay = new OverlayManager(config);
    this.tray = null;
    this.settingsWindow = null;
    this.display = null;
    this.timers = { snooze: null, trayRefresh: null };
    this.lastMaskKey = null;
    this.stopped = false;

    this.state = {
      enabled: true,
      thresholdPercent,
      snoozedUntil: 0,
      locked: false,
      ready: false,
      testOverlay: false,
      lastResult: null,
      backend: null,
      error: null,
    };
  }

  async start() {
    this.display = screen.getPrimaryDisplay();
    const inputSize = modelInputSize(this.display.size, this.engine.modelInput);
    await this.overlay.create(this.display);
    await this.capture.create();
    this.wireCapture();
    this.wireInference();
    this.inference.start(inputSize);
    await this.capture.open(this.display, { ...this.engine.capture, inputSize });

    if (this.showTray) {
      this.createTray();
      this.createSettingsWindow();
    }
    this.registerHotkeys();
    this.watchSystemEvents();
    this.refresh();
    this.checkScreenRecordingPermission();
  }

  /** macOS: capture silently returns empty frames without the Screen Recording permission. */
  checkScreenRecordingPermission() {
    if (!this.config.platform.needsScreenRecordingPermission || hasScreenRecordingPermission()) return;
    this.setError('Screen Recording permission needed');
    explainScreenRecordingPermission().catch((err) => console.error('[permissions]', err));
  }

  /**
   * Shuts down in dependency order: stop the inference worker (and stop listening to it) before
   * destroying the windows its results would update. Safe to call more than once.
   */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timers.snooze);
    clearInterval(this.timers.trayRefresh);
    unregisterHotkeys();
    this.settings.flush();
    this.inference.stop();
    this.capture.destroy();
    this.overlay.destroy();
    this.settingsWindow?.destroy();
    this.tray?.destroy();
  }

  /**
   * Remembers the fastest inference backend in the settings file, per model and app version
   * (either may change what's fastest), so later starts load only that one (see inference-host.js).
   */
  createBackendMemory(modelId) {
    const appVersion = app.getVersion();
    const all = () => this.settings.get('inferenceBackends') ?? {};
    const write = (entry) => this.settings.set('inferenceBackends', { ...all(), [modelId]: entry });
    return {
      load: () => {
        const saved = all()[modelId];
        return saved?.appVersion === appVersion ? { name: saved.name, deviceId: saved.deviceId } : null;
      },
      save: (backend) => write({ ...backend, appVersion }),
      clear: () => write(null),
    };
  }

  /** Model and performance mode change the whole pipeline, so they apply after a restart. */
  setEngineSetting(key, value) {
    if (this.settings.get(key) === value) return;
    this.settings.set(key, value);
    this.stop(); // also saves the settings
    app.relaunch();
    app.exit(0);
  }

  setModel(modelId) {
    if (MODELS[modelId]) this.setEngineSetting('modelId', modelId);
  }

  setPerformanceMode(mode) {
    if (PERFORMANCE_MODES[mode]) this.setEngineSetting('performanceMode', mode);
  }

  get running() {
    const { enabled, snoozedUntil, locked, ready } = this.state;
    return enabled && ready && !locked && snoozedUntil <= Date.now();
  }

  // ---- user actions ----

  toggleEnabled() {
    this.state.enabled = !this.state.enabled;
    this.refresh();
  }

  setThresholdPercent(percent) {
    const thresholdPercent = clampThresholdPercent(percent);
    if (thresholdPercent === this.state.thresholdPercent) return;
    this.state.thresholdPercent = thresholdPercent;
    this.regions.configure(thresholdsFromPercent(thresholdPercent));
    this.settings.set('thresholdPercent', thresholdPercent);
    this.updateTray();
    this.updateSettingsWindow();
  }

  openSettings() {
    this.settingsWindow?.open();
  }

  snooze(minutes) {
    clearTimeout(this.timers.snooze);
    this.state.snoozedUntil = Date.now() + minutes * MINUTE_MS;
    this.timers.snooze = setTimeout(() => this.endSnooze(), minutes * MINUTE_MS);
    this.refresh();
  }

  endSnooze() {
    clearTimeout(this.timers.snooze);
    this.state.snoozedUntil = 0;
    this.refresh();
  }

  dismiss() {
    this.state.testOverlay = false;
    this.regions.dismiss(Date.now());
    this.updateOverlay();
  }

  toggleTestOverlay() {
    this.state.testOverlay = !this.state.testOverlay;
    this.updateOverlay();
  }

  // ---- wiring ----

  wireCapture() {
    this.capture.on('status', ({ level, message }) => {
      console[level === 'error' ? 'error' : 'log'](`[capture] ${message}`);
      if (level === 'error') this.setError(message);
    });
  }

  wireInference() {
    this.inference.on('port', (port) => this.capture.attachInferencePort(port));
    this.inference.on('ready', ({ modelId, inputSize, backend }) => {
      const tried = backend.attempts.map((a) => `${a.label}: ${a.error ? 'unavailable' : `${a.medianMs.toFixed(0)} ms`}`).join(', ');
      console.log(`[inference] ready (${modelId}, input ${inputSize.width}x${inputSize.height}, using ${backend.label}; tried ${tried})`);
      this.state.backend = backend.label;
      this.state.ready = true;
      this.state.error = null;
      this.refresh();
    });
    this.inference.on('result', (result) => this.handleResult(result));
    this.inference.on('error', ({ code, message }) => {
      console.error(`[inference] ${code}: ${message}`);
      if (code === 'MODEL_NOT_LOADED') this.setError('model failed to load');
    });
    this.inference.on('exit', (code) => {
      if (this.stopped) return;
      console.error(`[inference] exited with code ${code}, restarting`);
      this.state.ready = false;
      this.refresh();
    });
  }

  handleResult(result) {
    if (this.stopped) return;
    this.state.lastResult = result;
    this.emit('result', result);
    this.updateSettingsWindow();
    if (!this.running) return;

    const now = Date.now();
    const update = this.regions.update(result, now);
    if (update.stale) return;
    if (this.config.flags.verbose) this.logResult(result, this.regions.motionStates(), now);
    // Moving areas need a fresh predicted position on every result, not just when areas change.
    if (update.changed || this.regions.active) this.updateOverlay();
  }

  /** One line per result; each area as [x%,y% w x h% score v=vx,vy screens/s at=capture time]. */
  logResult(result, regions, now) {
    const percent = (value) => (value * 100).toFixed(1);
    const boxes = regions
      .map(({ box, score, velocity, capturedAt }) =>
        `[${percent(box.x)}%,${percent(box.y)}% ${percent(box.width)}x${percent(box.height)}% ${(score * 100).toFixed(0)}% ` +
        `v=${(velocity.x * 1000).toFixed(3)},${(velocity.y * 1000).toFixed(3)} at=${Math.round(capturedAt)}]`)
      .join(' ');
    console.log(
      `[result] t=${now} seq=${result.seq} age=${Math.round(now - result.ts)}ms score=${percent(result.score)}% ${result.label ?? '-'} ` +
        `infer=${result.latencyMs.toFixed(0)}ms detections=${result.regions.length} blurred=${regions.length} ${boxes}`,
    );
  }

  createTray() {
    this.tray = new TrayController(this.config, {
      toggleEnabled: () => this.toggleEnabled(),
      setThresholdPercent: (percent) => this.setThresholdPercent(percent),
      openSettings: () => this.openSettings(),
      snooze: (minutes) => this.snooze(minutes),
      endSnooze: () => this.endSnooze(),
      dismiss: () => this.dismiss(),
      toggleTestOverlay: () => this.toggleTestOverlay(),
      quit: () => app.quit(),
    });
    this.timers.trayRefresh = setInterval(() => this.updateTray(), this.config.trayRefreshMs);
  }

  createSettingsWindow() {
    this.settingsWindow = new SettingsWindow(this.config, {
      getState: () => this.settingsViewState(),
      setThresholdPercent: (percent) => this.setThresholdPercent(percent),
      setModel: (modelId) => this.setModel(modelId),
      setPerformanceMode: (mode) => this.setPerformanceMode(mode),
    });
  }

  registerHotkeys() {
    const { hotkeys } = this.config;
    const failed = registerHotkeys({
      [hotkeys.toggle]: () => this.toggleEnabled(),
      [hotkeys.dismiss]: () => this.dismiss(),
      [hotkeys.testOverlay]: () => this.toggleTestOverlay(),
    });
    if (failed.length) console.warn(`[hotkeys] could not register: ${failed.join(', ')}`);
  }

  watchSystemEvents() {
    powerMonitor.on('lock-screen', () => this.setLocked(true));
    powerMonitor.on('unlock-screen', () => this.setLocked(false));
    screen.on('display-metrics-changed', (_event, display) => {
      if (display.id === this.display.id) this.overlay.setBounds(display);
    });
  }

  // ---- state ----

  setLocked(locked) {
    this.state.locked = locked;
    this.refresh();
  }

  setError(message) {
    this.state.error = message;
    this.updateTray();
  }

  /** Applies the running state to capture and the overlay after any state change. */
  refresh() {
    if (this.stopped) return;
    if (this.running) {
      this.capture.resume();
    } else {
      this.capture.pause();
      this.regions.reset();
    }
    this.updateOverlay();
  }

  updateOverlay() {
    if (this.stopped) return;
    if (this.state.testOverlay) {
      this.overlay.renderTestRegion();
    } else {
      this.overlay.render(this.overlayEnabled && this.running ? this.regions.motionStates() : []);
    }
    this.updateCaptureMask();
    this.updateTray();
  }

  /** Where our overlay shows up in the capture, tell change detection to ignore it. */
  updateCaptureMask() {
    if (this.config.platform.overlayHiddenFromCapture) return;
    const boxes = this.overlay.visible ? this.regions.displayRegions(Date.now()).map(({ box }) => box) : [];
    const key = JSON.stringify(boxes);
    if (key === this.lastMaskKey) return;
    this.lastMaskKey = key;
    this.capture.setMask(boxes);
  }

  updateTray() {
    if (this.stopped) return;
    this.tray?.update({
      ...this.state,
      running: this.running,
      overlayVisible: this.overlay.visible,
      blurredAreas: this.overlayEnabled && this.running ? this.regions.regions.length : 0,
      presets: SENSITIVITY_PRESETS,
      modelName: this.engine.model.name,
    });
    this.updateSettingsWindow();
  }

  updateSettingsWindow() {
    this.settingsWindow?.update(this.settingsViewState());
  }

  settingsViewState() {
    const { lastResult, thresholdPercent, backend } = this.state;
    return {
      thresholdPercent,
      presets: SENSITIVITY_PRESETS,
      range: THRESHOLD_PERCENT_RANGE,
      scorePercent: lastResult ? lastResult.score * 100 : null,
      overlayVisible: this.overlay.visible,
      running: this.running,
      engine: {
        modelId: this.engine.model.id,
        models: Object.values(MODELS).map(({ id, name, description }) => ({ id, name, description })),
        performanceMode: this.engine.mode.id,
        performanceModes: Object.values(PERFORMANCE_MODES),
        backend,
        msPerFrame: lastResult ? Math.round(lastResult.latencyMs) : null,
      },
    };
  }
}

module.exports = { ScreenBlurApp };
