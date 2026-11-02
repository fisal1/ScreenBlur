const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEngine } = require('../src/main/engine-profile');

const config = {
  modelInput: { longSide: 960, stride: 32 },
  capture: { fps: 30, idleFps: 2, maxInFlight: 2 },
  inference: { backends: [{ name: 'dml', deviceId: 0 }, { name: 'cpu' }] },
};

test('best mode uses the platform backends and full settings', () => {
  const engine = resolveEngine(config, { modelId: 'erax-yolo11s', performanceMode: 'best' });
  assert.equal(engine.model.id, 'erax-yolo11s');
  assert.equal(engine.mode.id, 'best');
  assert.deepEqual(engine.backends, config.inference.backends);
  assert.equal(engine.modelInput.longSide, 960);
  assert.equal(engine.capture.fps, 30);
});

test('light mode uses the CPU, a smaller input and a lower frame rate', () => {
  const engine = resolveEngine(config, { modelId: 'nudenet-320n', performanceMode: 'light' });
  assert.deepEqual(engine.backends, [{ name: 'cpu' }]);
  assert.equal(engine.modelInput.longSide, 640);
  assert.equal(engine.modelInput.stride, 32);
  assert.equal(engine.capture.fps, 15);
  assert.equal(engine.capture.maxInFlight, 1);
  assert.equal(engine.capture.idleFps, 2); // untouched settings are kept
});

test('unknown settings fall back to the defaults', () => {
  const engine = resolveEngine(config, { modelId: 'nope', performanceMode: 'turbo' });
  assert.equal(engine.model.id, 'nudenet-320n');
  assert.equal(engine.mode.id, 'best');
});
