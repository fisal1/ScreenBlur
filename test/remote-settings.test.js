const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRemoteEndpoint } = require('../src/main/remote-settings');

test('allows authenticated local WebSocket endpoints', () => {
  assert.equal(
    validateRemoteEndpoint('ws://127.0.0.1:8000/v1/inference/stream'),
    'ws://127.0.0.1:8000/v1/inference/stream',
  );
  assert.equal(
    validateRemoteEndpoint('ws://localhost:8000/v1/inference/stream'),
    'ws://localhost:8000/v1/inference/stream',
  );
});

test('requires TLS for non-loopback remote endpoints', () => {
  assert.equal(
    validateRemoteEndpoint('wss://inference.example/v1/inference/stream'),
    'wss://inference.example/v1/inference/stream',
  );
  assert.throws(
    () => validateRemoteEndpoint('ws://inference.example/v1/inference/stream'),
    /must use wss/,
  );
});

test('rejects credentials, query strings, unsupported paths and malformed URLs', () => {
  for (const endpoint of [
    'ws://user:password@localhost:8000/v1/inference/stream',
    'ws://localhost:8000/v1/inference/stream?token=secret',
    'ws://localhost:8000/other',
    'https://localhost:8000/v1/inference/stream',
    'not a URL',
  ]) {
    assert.throws(() => validateRemoteEndpoint(endpoint));
  }
});
