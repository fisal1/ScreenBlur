// Inference utility process entry point (RFC 4, 5).
// Receives frames from the capture renderer on a MessagePort, replies "done" on that port
// so the renderer can send the next frame, and reports results to main via parentPort.
const ort = require('onnxruntime-node');
const { WorkerMessage } = require('../shared/messages');
const { rgbaToNchw, scoreExplicit } = require('./nudenet');

const MODEL_ID = 'nudenet-320n';
const MODEL_STRIDE = 32;
const parentPort = process.parentPort;

class Detector {
  static async load(modelPath, warmupSize) {
    const session = await ort.InferenceSession.create(modelPath, {
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      intraOpNumThreads: 2,
    });
    const detector = new Detector(session);
    const { width, height } = warmupSize;
    await detector.detect(new Uint8Array(width * height * 4), width, height);
    return detector;
  }

  constructor(session) {
    this.session = session;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
    this.input = new Float32Array(0);
  }

  /** Accepts any frame size that is a multiple of the model stride. */
  async detect(rgba, width, height) {
    const length = 3 * width * height;
    if (this.input.length !== length) this.input = new Float32Array(length);
    rgbaToNchw(rgba, width, height, this.input);
    const tensor = new ort.Tensor('float32', this.input, [1, 3, height, width]);
    const outputs = await this.session.run({ [this.inputName]: tensor });
    return scoreExplicit(outputs[this.outputName]);
  }
}

function toBytes(data) {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer);
}

function validateFrame({ width, height }, bytes) {
  const validSize = width > 0 && height > 0 && width % MODEL_STRIDE === 0 && height % MODEL_STRIDE === 0;
  if (!validSize || bytes.length !== width * height * 4) {
    throw new Error(`Invalid frame ${width}x${height} (${bytes.length} bytes); sides must be multiples of ${MODEL_STRIDE}`);
  }
}

function reportError(code, err) {
  parentPort.postMessage({ type: WorkerMessage.ERROR, code, message: String(err?.message ?? err) });
}

async function handleFrame(detector, frame) {
  const started = performance.now();
  const bytes = toBytes(frame.data);
  validateFrame(frame, bytes);
  const { score, label } = await detector.detect(bytes, frame.width, frame.height);
  parentPort.postMessage({
    type: WorkerMessage.RESULT,
    seq: frame.seq,
    ts: frame.ts,
    score,
    label,
    latencyMs: performance.now() - started,
  });
}

function listenForFrames(detector, port) {
  port.on('message', async ({ data: frame }) => {
    if (frame.type !== WorkerMessage.FRAME) return;
    try {
      await handleFrame(detector, frame);
    } catch (err) {
      reportError('INFERENCE_FAILED', err);
    } finally {
      port.postMessage({ type: WorkerMessage.DONE, seq: frame.seq });
    }
  });
  port.start();
}

parentPort.on('message', async ({ data: message, ports }) => {
  if (message.type !== WorkerMessage.INIT) return;

  let detector;
  try {
    detector = await Detector.load(message.modelPath, message.inputSize);
  } catch (err) {
    reportError('MODEL_NOT_LOADED', err);
    return;
  }

  listenForFrames(detector, ports[0]);
  parentPort.postMessage({ type: WorkerMessage.READY, modelId: MODEL_ID, inputSize: message.inputSize });
});
