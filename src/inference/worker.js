// Inference utility process entry point (RFC 4, 5).
// Receives frames from the capture renderer on a MessagePort, replies "done" on that port
// so the renderer can send the next frame, and reports results to main via parentPort.
const ort = require('onnxruntime-node');
const { WorkerMessage } = require('../shared/messages');
const { EXPLICIT_LABELS, FACE_LABELS, classIdsFor, rgbaToNchw, analyze } = require('./nudenet');
const { toScreenRegions } = require('./regions');
const { createFastestSession } = require('./backend-selector');

const MODEL_ID = 'nudenet-320n';
const MODEL_STRIDE = 32;
const parentPort = process.parentPort;

ort.env.logLevel = 'error';

class Detector {
  static async load({ modelPath, inputSize, backends, benchmarkRuns }, classIds) {
    const selection = await createFastestSession(ort, modelPath, inputSize, backends, benchmarkRuns);
    return new Detector(selection, classIds);
  }

  constructor({ session, label, medianMs, attempts }, classIds) {
    this.session = session;
    this.backend = { label, medianMs, attempts };
    this.classIds = classIds;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
    this.input = new Float32Array(0);
  }

  /** Accepts any frame size that is a multiple of the model stride. */
  async detect(rgba, width, height, options) {
    const length = 3 * width * height;
    if (this.input.length !== length) this.input = new Float32Array(length);
    rgbaToNchw(rgba, width, height, this.input);
    const tensor = new ort.Tensor('float32', this.input, [1, 3, height, width]);
    const outputs = await this.session.run({ [this.inputName]: tensor });
    return analyze(outputs[this.outputName], this.classIds, options);
  }
}

function toBytes(data) {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer);
}

function validateFrame({ width, height, contentWidth, contentHeight }, bytes) {
  const validSize = width > 0 && height > 0 && width % MODEL_STRIDE === 0 && height % MODEL_STRIDE === 0;
  const validContent = contentWidth > 0 && contentHeight > 0 && contentWidth <= width && contentHeight <= height;
  if (!validSize || !validContent || bytes.length !== width * height * 4) {
    throw new Error(`Invalid frame ${width}x${height} (content ${contentWidth}x${contentHeight}, ${bytes.length} bytes)`);
  }
}

function reportError(code, err) {
  parentPort.postMessage({ type: WorkerMessage.ERROR, code, message: String(err?.message ?? err) });
}

async function handleFrame(detector, frame, detection) {
  const started = performance.now();
  const rgba = toBytes(frame.data);
  validateFrame(frame, rgba);
  const { score, label, detections } = await detector.detect(rgba, frame.width, frame.height, detection);
  const regions = toScreenRegions(detections, { ...frame, rgba }, detection);
  parentPort.postMessage({
    type: WorkerMessage.RESULT,
    seq: frame.seq,
    ts: frame.ts,
    sceneChange: frame.sceneChange,
    score,
    label,
    regions,
    latencyMs: performance.now() - started,
  });
}

/**
 * Runs one frame at a time. While a frame is running, the newest arriving frame waits;
 * an older waiting frame is dropped (latest-only). Every frame gets a "done" reply so the
 * capture renderer can track how many frames are in flight.
 */
class FrameQueue {
  constructor(process, onDone) {
    this.process = process;
    this.onDone = onDone;
    this.waiting = null;
    this.running = false;
  }

  push(frame) {
    if (this.waiting) this.onDone(this.waiting); // superseded before it started
    this.waiting = frame;
    if (!this.running) this.drain();
  }

  async drain() {
    this.running = true;
    while (this.waiting) {
      const frame = this.waiting;
      this.waiting = null;
      try {
        await this.process(frame);
      } catch (err) {
        reportError('INFERENCE_FAILED', err);
      } finally {
        this.onDone(frame);
      }
    }
    this.running = false;
  }
}

function listenForFrames(detector, port, detection) {
  const queue = new FrameQueue(
    (frame) => handleFrame(detector, frame, detection),
    (frame) => port.postMessage({ type: WorkerMessage.DONE, seq: frame.seq }),
  );
  port.on('message', ({ data: frame }) => {
    if (frame.type === WorkerMessage.FRAME) queue.push(frame);
  });
  port.start();
}

parentPort.on('message', async ({ data: message, ports }) => {
  if (message.type !== WorkerMessage.INIT) return;

  const { detection } = message;
  const labels = detection.includeFaces ? [...EXPLICIT_LABELS, ...FACE_LABELS] : EXPLICIT_LABELS;

  let detector;
  try {
    detector = await Detector.load(message, classIdsFor(labels));
  } catch (err) {
    reportError('MODEL_NOT_LOADED', err);
    return;
  }

  listenForFrames(detector, ports[0], detection);
  parentPort.postMessage({
    type: WorkerMessage.READY,
    modelId: MODEL_ID,
    inputSize: message.inputSize,
    labels,
    backend: detector.backend,
  });
});
