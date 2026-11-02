const { EventEmitter } = require('node:events');
const { utilityProcess, MessageChannelMain } = require('electron');
const { WorkerMessage } = require('../shared/messages');

function sameBackend(a, b) {
  return Boolean(a && b) && a.name === b.name && (a.deviceId ?? null) === (b.deviceId ?? null);
}

/**
 * Owns the inference utility process: starts it, restarts it after crashes,
 * and hands the renderer-side end of its frame port to whoever listens for "port".
 *
 * Backend memory: every GPU/CPU backend the worker loads keeps some driver memory even after
 * it is released (~90 MB when all are measured). So the fastest backend is measured once,
 * remembered via `backendMemory`, and the worker is restarted to load only that one.
 * Later starts load only the remembered backend (falling back down the list if it fails).
 *
 * Events: port(MessagePortMain), ready(msg), result(msg), error(msg), exit(code)
 */
class InferenceHost extends EventEmitter {
  /** @param backendMemory { load(): backend | null, save(backend), clear() } */
  constructor(config, backendMemory) {
    super();
    this.config = config;
    this.backendMemory = backendMemory;
    this.child = null;
    this.inputSize = null;
    this.selection = null;
    this.stopping = false;
    this.reloading = false;
    this.restartTimer = null;
  }

  /** @param inputSize { width, height } of the frames the capture renderer will send */
  start(inputSize = this.inputSize) {
    this.inputSize = inputSize;
    this.stopping = false;
    this.reloading = false;
    const { port1: rendererPort, port2: workerPort } = new MessageChannelMain();
    const { backends, selection } = this.backendPlan();
    this.selection = selection;

    this.child = utilityProcess.fork(this.config.paths.inferenceWorker, [], {
      serviceName: 'ScreenBlur Inference',
      stdio: 'inherit',
    });
    this.child.on('message', (message) => this.handleMessage(message));
    this.child.on('exit', (code) => this.handleExit(code));

    this.child.postMessage(
      {
        type: WorkerMessage.INIT,
        modelPath: this.config.paths.model,
        inputSize: this.inputSize,
        backends,
        selection,
        benchmarkRuns: this.config.inference.benchmarkRuns,
        detection: { ...this.config.detection, includeFaces: this.config.flags.detectFaces },
      },
      [workerPort],
    );
    this.emit('port', rendererPort);
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.child?.kill();
    this.child = null;
  }

  /** Remembered backend first (load only it), otherwise measure them all. */
  backendPlan() {
    const all = this.config.inference.backends;
    const remembered = this.backendMemory.load();
    if (!remembered || !all.some((backend) => sameBackend(backend, remembered))) {
      return { backends: all, selection: 'fastest' };
    }
    return { backends: [remembered, ...all.filter((backend) => !sameBackend(backend, remembered))], selection: 'first-working' };
  }

  handleMessage(message) {
    if (message.type === WorkerMessage.READY && this.handleReady(message)) return;
    this.emit(message.type, message);
  }

  /** @returns true when the worker is being reloaded and "ready" should not be reported yet */
  handleReady({ backend }) {
    const chosen = { name: backend.name, deviceId: backend.deviceId };
    if (this.selection === 'fastest') {
      this.backendMemory.save(chosen);
      this.reload();
      return true;
    }
    if (!sameBackend(chosen, this.backendMemory.load())) this.backendMemory.clear(); // fell back; re-measure next time
    return false;
  }

  /** Restarts the worker so it starts clean with only the remembered backend. */
  reload() {
    this.reloading = true;
    this.child?.kill();
  }

  handleExit(code) {
    this.child = null;
    if (this.reloading) {
      this.start();
      return;
    }
    this.emit('exit', code);
    if (this.stopping) return;
    this.restartTimer = setTimeout(() => this.start(), this.config.inference.restartDelayMs);
  }
}

module.exports = { InferenceHost, sameBackend };
