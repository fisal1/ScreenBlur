const { EventEmitter } = require('node:events');
const { utilityProcess, MessageChannelMain } = require('electron');
const { WorkerMessage } = require('../shared/messages');

/**
 * Owns the inference utility process: starts it, restarts it after crashes,
 * and hands the renderer-side end of its frame port to whoever listens for "port".
 *
 * Events: port(MessagePortMain), ready(msg), result(msg), error(msg), exit(code)
 */
class InferenceHost extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.child = null;
    this.inputSize = null;
    this.stopping = false;
    this.restartTimer = null;
  }

  /** @param inputSize { width, height } of the frames the capture renderer will send */
  start(inputSize = this.inputSize) {
    this.inputSize = inputSize;
    this.stopping = false;
    const { port1: rendererPort, port2: workerPort } = new MessageChannelMain();

    this.child = utilityProcess.fork(this.config.paths.inferenceWorker, [], {
      serviceName: 'ScreenBlur Inference',
      stdio: 'inherit',
    });
    this.child.on('message', (message) => this.emit(message.type, message));
    this.child.on('exit', (code) => this.handleExit(code));

    this.child.postMessage(
      {
        type: WorkerMessage.INIT,
        modelPath: this.config.paths.model,
        inputSize: this.inputSize,
        backends: this.config.inference.backends,
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

  handleExit(code) {
    this.child = null;
    this.emit('exit', code);
    if (this.stopping) return;
    this.restartTimer = setTimeout(() => this.start(), this.config.inference.restartDelayMs);
  }
}

module.exports = { InferenceHost };
