const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketTransport } = require('../src/renderer/capture/websocket-transport');
const { InferenceTransport } = require('../src/renderer/capture/inference-transport');

class FakeTransport extends InferenceTransport {
  constructor(options) {
    super({ ...options, format: 'jpeg', maxInFlight: 1 });
    this.profile = options.profile;
    this.connected = false;
    this.frames = [];
  }

  get ready() {
    return this.connected;
  }

  connect() {
    this.connected = true;
    this.onState('connected');
  }

  sendFrame(frame, bytes) {
    this.frames.push({ frame, bytes });
    return true;
  }

  close() {
    this.connected = false;
  }
}

global.WebSocketTransport = FakeTransport;
global.countChangedPixels = (a, b, delta, ignore = null) =>
  a.reduce((count, value, index) => count + (!ignore?.[index] && Math.abs(value - b[index]) > delta ? 1 : 0), 0);
global.maskFromBoxes = () => new Uint8Array();
const { CapturePipeline } = require('../src/renderer/capture/capture-pipeline');

function createPipeline({ onResult = () => {} } = {}) {
  const sampler = {
    ready: true,
    frameNumber: 1,
    frameCapturedAt: Date.now(),
    frameCapturedAtMonotonic: performance.now(),
    thumbnailSize: { width: 2, height: 2 },
    onFrame() {},
    thumbnail: () => new Uint8Array([0, 0, 0, 0]),
    jpegFrame: async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      width: 32,
      height: 32,
      contentWidth: 32,
      contentHeight: 32,
    }),
  };
  const settings = {
    fps: 30,
    idleFps: 2,
    busyTimeoutMs: 3000,
    maxInFlight: 2,
    staticPixelDelta: 10,
    staticMaxChangedPixels: 2,
    maxFrameAgeMs: 1500,
    jpegQuality: 0.82,
  };
  const pipeline = new CapturePipeline(sampler, settings, {
    WorkerMessage: { FRAME: 'frame', DONE: 'done' },
    onError: (error) => { throw error; },
    onResult,
  });
  return { pipeline, sampler };
}

test('remote pipeline sends JPEG and accepts a matching fresh result', async (t) => {
  let pipeline;
  t.after(() => {
    pipeline?.pause();
    pipeline?.setRemote(null);
  });
  let result;
  ({ pipeline } = createPipeline({ onResult: (value) => { result = value; } }));
  pipeline.setRemote({ enabled: true, endpoint: 'ws://localhost:8000/v1/inference/stream', token: 'test', profile: 'mid' });
  pipeline.resume();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pipeline.inFlight.size, 1);
  const sent = pipeline.transport.frames[0];
  assert.deepEqual(Array.from(sent.bytes), [1, 2, 3]);
  assert.equal(sent.frame.width, 32);

  const { frame } = sent;
  pipeline.handleRemoteResult({
    seq: frame.seq,
    correlationId: frame.correlationId,
    captureTimestampMs: frame.ts,
    score: 0.2,
    label: 'FEMALE_BREAST_EXPOSED',
    inferenceMs: 12,
    modelVersion: 'nudenet-320n',
    regions: [{
      score: 0.2,
      label: 'FEMALE_BREAST_EXPOSED',
      box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      mosaic: { cols: 1, rows: 1, data: [1, 2, 3, 255] },
    }],
  });
  assert.equal(result.seq, frame.seq);
  assert.equal(result.regions.length, 1);
  assert.equal(pipeline.inFlight.size, 0);
});

test('remote pipeline rejects a late result without changing overlay state', (t) => {
  let results = 0;
  const { pipeline } = createPipeline({ onResult: () => { results++; } });
  t.after(() => pipeline.pause());
  pipeline.transport = { ready: true, format: 'jpeg', profile: 'mid', maxInFlight: 1 };
  const seq = 2;
  const capturedAt = Date.now() - 2000;
  pipeline.inFlight.set(seq, {
    sentAt: performance.now(),
    capturedAt,
    capturedAtMonotonic: performance.now() - 2000,
    sceneChange: 1,
  });
  pipeline.handleRemoteResult({
    seq,
    correlationId: `frame-${seq}-${capturedAt}`,
    captureTimestampMs: capturedAt,
    score: 0,
    label: null,
    inferenceMs: 10,
    modelVersion: 'nudenet-320n',
    regions: [],
  });
  assert.equal(results, 0);
  assert.equal(pipeline.inFlight.size, 0);
  pipeline.pause();
});

test('remote freshness uses the monotonic capture clock, not the echoed wall-clock timestamp', (t) => {
  let results = 0;
  const { pipeline } = createPipeline({ onResult: () => { results++; } });
  t.after(() => pipeline.pause());
  pipeline.transport = { ready: true, format: 'jpeg', profile: 'mid', maxInFlight: 1 };
  const seq = 3;
  const capturedAt = Date.now() - 78_777;
  pipeline.inFlight.set(seq, {
    sentAt: performance.now(),
    capturedAt,
    capturedAtMonotonic: performance.now(),
    sceneChange: 1,
  });
  pipeline.handleRemoteResult({
    seq,
    correlationId: `frame-${seq}-${capturedAt}`,
    captureTimestampMs: capturedAt,
    score: 0,
    label: null,
    inferenceMs: 10,
    modelVersion: 'nudenet-320n',
    regions: [],
  });
  assert.equal(results, 1);
  assert.equal(pipeline.inFlight.size, 0);
});

test('remote request timeout releases the single in-flight slot', (t) => {
  const { pipeline } = createPipeline();
  t.after(() => pipeline.pause());
  pipeline.transport = { ready: true, format: 'jpeg', profile: 'mid', maxInFlight: 1 };
  pipeline.inFlight.set(1, {
    sentAt: performance.now() - pipeline.settings.busyTimeoutMs - 1,
    capturedAt: Date.now(),
    sceneChange: 1,
  });
  assert.equal(pipeline.isBusy(), false);
  assert.equal(pipeline.inFlight.size, 0);
});

test('real transport never places bearer tokens in its endpoint URL', () => {
  const previousWebSocket = global.WebSocket;
  let socketUrl;
  global.WebSocket = class {
    static OPEN = 1;
    constructor(url) {
      socketUrl = url;
      this.readyState = 0;
    }

    addEventListener() {}
    close() {}
  };
  const transport = new WebSocketTransport({
    endpoint: 'wss://inference.example/v1/inference/stream',
    token: 'secret-token',
    onResult() {},
    onFrameError() {},
    onState() {},
  });
  transport.connect();
  assert.equal(socketUrl, 'wss://inference.example/v1/inference/stream');
  assert.equal(socketUrl.includes('secret-token'), false);
  transport.close();
  if (previousWebSocket) global.WebSocket = previousWebSocket;
  else delete global.WebSocket;
});
