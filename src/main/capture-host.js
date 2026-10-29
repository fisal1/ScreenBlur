const { EventEmitter } = require('node:events');
const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const { CaptureCommand, IpcChannel } = require('../shared/messages');

const PROBE_TIMEOUT_MS = 3000;

async function findScreenSourceId(display) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const match = sources.find((source) => source.display_id === String(display.id)) ?? sources[0];
  if (!match) throw new Error('No screen capture source available');
  return match.id;
}

/**
 * Owns the hidden capture renderer, which grabs screen frames and streams them
 * straight to the inference worker over a MessagePort.
 *
 * Events: status({ level, message })
 */
class CaptureHost extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.window = null;
    this.pendingProbes = new Map();
    this.nextProbeId = 1;
    this.onStatus = (event, status) => this.isFromWindow(event) && this.emit('status', status);
    this.onProbeResult = (event, result) => this.isFromWindow(event) && this.resolveProbe(result);
  }

  async create() {
    this.window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: this.config.paths.capturePreload,
        contextIsolation: true,
        sandbox: false, // preload needs require() for shared message constants
        backgroundThrottling: false, // keep timers and video running while hidden
      },
    });
    ipcMain.on(IpcChannel.CAPTURE_STATUS, this.onStatus);
    ipcMain.on(IpcChannel.PROBE_RESULT, this.onProbeResult);
    await this.window.loadFile(this.config.paths.capturePage);
  }

  attachInferencePort(port) {
    this.window.webContents.postMessage(IpcChannel.INFERENCE_PORT, null, [port]);
  }

  async open(display, inputSize) {
    const sourceId = await findScreenSourceId(display);
    this.sendCommand({ type: CaptureCommand.OPEN, sourceId, settings: { ...this.config.capture, inputSize } });
  }

  pause() {
    this.sendCommand({ type: CaptureCommand.PAUSE });
  }

  resume() {
    this.sendCommand({ type: CaptureCommand.RESUME });
  }

  /**
   * Screen areas (normalized boxes) covered by our overlay. Where the overlay shows up in the
   * capture, change detection ignores them so the animated patch isn't mistaken for content.
   */
  setMask(boxes) {
    this.sendCommand({ type: CaptureCommand.SET_MASK, boxes });
  }

  /** Fraction of pixels in the live capture stream that are pure magenta (self-test). */
  probeMagentaFraction() {
    const id = this.nextProbeId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingProbes.delete(id);
        reject(new Error('Capture probe timed out'));
      }, PROBE_TIMEOUT_MS);
      this.pendingProbes.set(id, { resolve, timer });
      this.sendCommand({ type: CaptureCommand.PROBE, id });
    });
  }

  destroy() {
    ipcMain.off(IpcChannel.CAPTURE_STATUS, this.onStatus);
    ipcMain.off(IpcChannel.PROBE_RESULT, this.onProbeResult);
    this.window?.destroy();
    this.window = null;
  }

  sendCommand(command) {
    this.window?.webContents.send(IpcChannel.CAPTURE_COMMAND, command);
  }

  isFromWindow(event) {
    return this.window && event.sender === this.window.webContents;
  }

  resolveProbe({ id, fraction }) {
    const probe = this.pendingProbes.get(id);
    if (!probe) return;
    clearTimeout(probe.timer);
    this.pendingProbes.delete(id);
    probe.resolve(fraction);
  }
}

module.exports = { CaptureHost };
