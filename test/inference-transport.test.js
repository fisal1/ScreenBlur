const test = require('node:test');
const assert = require('node:assert/strict');
const { MessagePortInferenceTransport } = require('../src/renderer/capture/inference-transport');

test('message-port adapter preserves the local worker frame protocol', () => {
  const sent = [];
  let closed = false;
  const port = {
    onmessage: null,
    postMessage: (message) => sent.push(message),
    close: () => { closed = true; },
  };
  let completed;
  const transport = new MessagePortInferenceTransport(port, { FRAME: 'frame', DONE: 'done' }, {
    maxInFlight: 2,
    onFrameDone: (message) => { completed = message.seq; },
  });
  const frame = {
    seq: 4,
    ts: 123,
    sceneChange: 0.2,
    width: 32,
    height: 32,
    contentWidth: 32,
    contentHeight: 32,
    data: new ArrayBuffer(32 * 32 * 4),
  };

  assert.equal(transport.format, 'rgba');
  assert.equal(transport.maxInFlight, 2);
  assert.equal(transport.ready, true);
  assert.equal(transport.sendFrame(frame), true);
  assert.deepEqual(sent[0], { type: 'frame', ...frame });

  port.onmessage({ data: { type: 'done', seq: 4 } });
  assert.equal(completed, 4);
  transport.close();
  assert.equal(transport.ready, false);
  assert.equal(port.onmessage, null);
  assert.equal(closed, true);
});
