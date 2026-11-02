const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// inference-host.js imports electron; plain Node has no Electron APIs, and backendPlan() and
// handleReady() don't need them, so provide empty stand-ins.
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return { utilityProcess: {}, MessageChannelMain: class {} };
  return originalLoad.call(this, request, ...rest);
};
const { InferenceHost, sameBackend } = require('../src/main/inference-host');
Module._load = originalLoad;

const BACKENDS = [{ name: 'dml', deviceId: 0 }, { name: 'dml', deviceId: 1 }, { name: 'cpu' }];
const config = { inference: { backends: BACKENDS } };

function memory(initial = null) {
  let value = initial;
  return { load: () => value, save: (backend) => { value = backend; }, clear: () => { value = null; } };
}

test('sameBackend compares name and device', () => {
  assert.equal(sameBackend({ name: 'dml', deviceId: 1 }, { name: 'dml', deviceId: 1 }), true);
  assert.equal(sameBackend({ name: 'dml', deviceId: 1 }, { name: 'dml', deviceId: 0 }), false);
  assert.equal(sameBackend({ name: 'cpu' }, { name: 'cpu', deviceId: undefined }), true);
  assert.equal(sameBackend(null, { name: 'cpu' }), false);
});

test('without a remembered backend all backends are measured', () => {
  const host = new InferenceHost(config, memory());
  assert.deepEqual(host.backendPlan(), { backends: BACKENDS, selection: 'fastest' });
});

test('a remembered backend is tried first and alone unless it fails', () => {
  const host = new InferenceHost(config, memory({ name: 'dml', deviceId: 1 }));
  const plan = host.backendPlan();
  assert.equal(plan.selection, 'first-working');
  assert.deepEqual(plan.backends, [{ name: 'dml', deviceId: 1 }, { name: 'dml', deviceId: 0 }, { name: 'cpu' }]);
});

test('a remembered backend that is no longer offered is ignored', () => {
  const host = new InferenceHost(config, memory({ name: 'coreml' }));
  assert.equal(host.backendPlan().selection, 'fastest');
});

test('after measuring, the winner is remembered and the worker reloaded', () => {
  const remembered = memory();
  const host = new InferenceHost(config, remembered);
  let reloaded = false;
  host.reload = () => { reloaded = true; };
  host.selection = 'fastest';
  assert.equal(host.handleReady({ backend: { name: 'dml', deviceId: 1, label: 'GPU 1' } }), true);
  assert.equal(reloaded, true);
  assert.deepEqual(remembered.load(), { name: 'dml', deviceId: 1 });
});

test('falling back from the remembered backend forgets it so the next start re-measures', () => {
  const remembered = memory({ name: 'dml', deviceId: 1 });
  const host = new InferenceHost(config, remembered);
  host.selection = 'first-working';
  assert.equal(host.handleReady({ backend: { name: 'cpu' } }), false);
  assert.equal(remembered.load(), null);
});

test('loading the remembered backend keeps it', () => {
  const remembered = memory({ name: 'dml', deviceId: 1 });
  const host = new InferenceHost(config, remembered);
  host.selection = 'first-working';
  assert.equal(host.handleReady({ backend: { name: 'dml', deviceId: 1 } }), false);
  assert.deepEqual(remembered.load(), { name: 'dml', deviceId: 1 });
});
