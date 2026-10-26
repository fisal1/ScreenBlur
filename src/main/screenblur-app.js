const { EventEmitter } = require('node:events');
const path = require('node:path');
const { app, screen, powerMonitor } = require('electron');
const {
  DecisionEngine,
  SENSITIVITY_PRESETS,
  THRESHOLD_PERCENT_RANGE,
  clampThresholdPercent,
  thresholdsFromPercent,
} = require('./decision-engine');
const { InferenceHost } = require('./inference-host');
const { CaptureHost } = require('./capture-host');
const { OverlayManager } = require('./overlay');
const { modelInputSize } = require('./model-input');
const { TrayController } = require('./tray');
const { SettingsStore } = require('./settings-store');
const { SettingsWindow } = require('./settings-window');
const { registerHotkeys, unregisterHotkeys } = require('./hotkeys');

const MINUTE_MS = 60_000;

/**
 * Orchestrates capture -> inference -> decision -> overlay, plus user controls.
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
    });
    const thresholdPercent = clampThresholdPercent(this.settings.get('thresholdPercent'));

    this.engine = new DecisionEngine(thresholdsFromPercent(thresholdPercent));
    this.inference = new InferenceHost(config);
    this.capture = new CaptureHost(config);
    this.overlay = new OverlayManager(config);
    this.tray = null;
    this.settingsWindow = null;
    this.display = null;
    this.timers = { snooze: null, trayRefresh: null };

    this.state = {
      enabled: true,
      thresholdPercent,
      snoozedUntil: 0,
      locked: false,
      ready: false,
      testOverlay: false,
      lastResult: null,
      error: null,
    };
  }

  async start() {
    this.display = screen.getPrimaryDisplay();
    const inputSize = modelInputSize(this.display.size, this.config.modelInput);
    await this.overlay.create(this.display);
    await this.capture.create();
    this.wireCapture();
    this.wireInference();
    this.inference.start(inputSize);
    await this.capture.open(this.display, inputSize);

    if (this.showTray) {
      this.createTray();
      this.createSettingsWindow();
    }
    this.registerHotkeys();
    this.watchSystemEvents();
    this.refresh();
  }

  stop() {
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
    this.engine.configure(thresholdsFromPercent(thresholdPercent));
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
    this.engine.dismiss(Date.now());
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
    this.inference.on('ready', ({ modelId, inputSize }) => {
      console.log(`[inference] ready (${modelId}, input ${inputSize.width}x${inputSize.height})`);
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
      console.error(`[inference] exited with code ${code}, restarting`);
      this.state.ready = false;
      this.refresh();
    });
  }

  handleResult(result) {
    this.state.lastResult = result;
    this.emit('result', result);
    this.updateSettingsWindow();
    if (!this.running) return;

    const decision = this.engine.update(result, Date.now());
    if (decision.stale) return;
    if (this.config.flags.verbose) {
      console.log(`[result] seq=${result.seq} score=${result.score.toFixed(3)} ${result.label ?? '-'} infer=${result.latencyMs.toFixed(0)}ms e2e=${Date.now() - result.ts}ms shown=${decision.shown}`);
    }
    if (decision.changed) this.updateOverlay();
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
    if (this.running) {
      this.capture.resume();
    } else {
      this.capture.pause();
      this.engine.reset();
    }
    this.updateOverlay();
  }

  updateOverlay() {
    const detected = this.overlayEnabled && this.running && this.engine.shown;
    this.overlay.setVisible(this.state.testOverlay || detected);
    this.updateTray();
  }

  updateTray() {
    this.tray?.update({
      ...this.state,
      running: this.running,
      overlayVisible: this.overlay.visible,
      presets: SENSITIVITY_PRESETS,
    });
    this.updateSettingsWindow();
  }

  updateSettingsWindow() {
    this.settingsWindow?.update(this.settingsViewState());
  }

  settingsViewState() {
    const { lastResult, thresholdPercent } = this.state;
    return {
      thresholdPercent,
      presets: SENSITIVITY_PRESETS,
      range: THRESHOLD_PERCENT_RANGE,
      scorePercent: lastResult ? lastResult.score * 100 : null,
      overlayVisible: this.overlay.visible,
      running: this.running,
    };
  }
}

module.exports = { ScreenBlurApp };
