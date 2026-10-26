const test = require('node:test');
const assert = require('node:assert/strict');
const { modelInputSize } = require('../src/main/model-input');

const options = { longSide: 960, stride: 32 };

test('keeps a 16:9 screen widescreen, rounded up to the stride', () => {
  assert.deepEqual(modelInputSize({ width: 1920, height: 1080 }, options), { width: 960, height: 544 });
});

test('handles portrait screens', () => {
  assert.deepEqual(modelInputSize({ width: 1080, height: 1920 }, options), { width: 544, height: 960 });
});

test('handles ultrawide screens', () => {
  assert.deepEqual(modelInputSize({ width: 3440, height: 1440 }, options), { width: 960, height: 416 });
});

test('both sides are multiples of the stride', () => {
  for (const [width, height] of [[1366, 768], [1536, 864], [2560, 1600], [1280, 1024]]) {
    const size = modelInputSize({ width, height }, options);
    assert.equal(size.width % 32, 0);
    assert.equal(size.height % 32, 0);
  }
});
