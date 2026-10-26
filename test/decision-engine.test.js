const test = require('node:test');
const assert = require('node:assert/strict');
const { DecisionEngine, clampThresholdPercent, thresholdsFromPercent } = require('../src/main/decision-engine');

const opts = { thresholdHigh: 0.8, thresholdLow: 0.5, clearFramesToHide: 4, minShowMs: 1500, dismissMs: 10000 };

function run(engine, frames) {
  return frames.map(([seq, score, t]) => engine.update({ seq, score }, t).shown);
}

test('shows on a single high frame', () => {
  const e = new DecisionEngine(opts);
  assert.deepEqual(run(e, [[1, 0.2, 0], [2, 0.85, 200]]), [false, true]);
});

test('scores between thresholds do not change state', () => {
  const e = new DecisionEngine(opts);
  assert.deepEqual(run(e, [[1, 0.7, 0], [2, 0.6, 200]]), [false, false]);
  e.update({ seq: 3, score: 0.9 }, 400);
  assert.deepEqual(run(e, [[4, 0.7, 2000], [5, 0.6, 2200], [6, 0.79, 2400]]), [true, true, true]);
});

test('hides only after 4 consecutive clear frames and min show time', () => {
  const e = new DecisionEngine(opts);
  e.update({ seq: 1, score: 0.9 }, 0);
  // 4 clear frames, but only 800 ms since the positive frame
  assert.deepEqual(run(e, [[2, 0.1, 200], [3, 0.1, 400], [4, 0.1, 600], [5, 0.1, 800]]), [true, true, true, true]);
  // keeps counting; hides once 1500 ms have passed
  assert.deepEqual(run(e, [[6, 0.1, 1400], [7, 0.1, 1600]]), [true, false]);
});

test('a mid-range frame breaks the clear streak', () => {
  const e = new DecisionEngine(opts);
  e.update({ seq: 1, score: 0.9 }, 0);
  run(e, [[2, 0.1, 2000], [3, 0.1, 2200], [4, 0.1, 2400]]);
  assert.equal(e.update({ seq: 5, score: 0.6 }, 2600).shown, true);
  assert.deepEqual(run(e, [[6, 0.1, 2800], [7, 0.1, 3000], [8, 0.1, 3200], [9, 0.1, 3400]]), [true, true, true, false]);
});

test('a new positive frame resets the min show timer', () => {
  const e = new DecisionEngine(opts);
  e.update({ seq: 1, score: 0.9 }, 0);
  e.update({ seq: 2, score: 0.9 }, 1000);
  assert.deepEqual(run(e, [[3, 0.1, 1200], [4, 0.1, 1400], [5, 0.1, 1600], [6, 0.1, 1800]]), [true, true, true, true]);
  assert.equal(e.update({ seq: 7, score: 0.1 }, 2600).shown, false);
});

test('ignores stale and duplicate results', () => {
  const e = new DecisionEngine(opts);
  e.update({ seq: 5, score: 0.1 }, 0);
  assert.equal(e.update({ seq: 3, score: 0.99 }, 100).stale, true);
  assert.equal(e.update({ seq: 5, score: 0.99 }, 100).stale, true);
  assert.equal(e.shown, false);
});

test('dismiss hides immediately and suppresses re-show', () => {
  const e = new DecisionEngine(opts);
  e.update({ seq: 1, score: 0.9 }, 0);
  e.dismiss(100);
  assert.equal(e.shown, false);
  assert.equal(e.update({ seq: 2, score: 0.95 }, 5000).shown, false);
  assert.equal(e.update({ seq: 3, score: 0.95 }, 10200).shown, true);
});

test('reports state changes', () => {
  const e = new DecisionEngine(opts);
  assert.equal(e.update({ seq: 1, score: 0.9 }, 0).changed, true);
  assert.equal(e.update({ seq: 2, score: 0.9 }, 200).changed, false);
});

test('percent maps to show threshold and half-way hide threshold', () => {
  assert.deepEqual(thresholdsFromPercent(30), { thresholdHigh: 0.3, thresholdLow: 0.15 });
});

test('threshold percent is clamped, rounded and defaults when invalid', () => {
  assert.equal(clampThresholdPercent(1), 5);
  assert.equal(clampThresholdPercent(120), 95);
  assert.equal(clampThresholdPercent(33.6), 34);
  assert.equal(clampThresholdPercent('abc'), 30);
});

test('configure applies a new threshold to later frames', () => {
  const e = new DecisionEngine(thresholdsFromPercent(50));
  assert.equal(e.update({ seq: 1, score: 0.35 }, 0).shown, false);
  e.configure(thresholdsFromPercent(30));
  assert.equal(e.update({ seq: 2, score: 0.35 }, 200).shown, true);
});
