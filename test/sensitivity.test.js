const test = require('node:test');
const assert = require('node:assert/strict');
const { clampThresholdPercent, thresholdsFromPercent } = require('../src/main/sensitivity');

test('percent maps to show threshold and half-way hide threshold', () => {
  assert.deepEqual(thresholdsFromPercent(30), { thresholdHigh: 0.3, thresholdLow: 0.15 });
});

test('threshold percent is clamped, rounded and defaults when invalid', () => {
  assert.equal(clampThresholdPercent(1), 5);
  assert.equal(clampThresholdPercent(120), 95);
  assert.equal(clampThresholdPercent(33.6), 34);
  assert.equal(clampThresholdPercent('abc'), 30);
});
