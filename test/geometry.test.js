const test = require('node:test');
const assert = require('node:assert/strict');
const { iou, padBox, clampBox } = require('../src/shared/geometry');

test('iou of identical, disjoint and half-overlapping boxes', () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(iou(box, box), 1);
  assert.equal(iou(box, { x: 20, y: 0, width: 10, height: 10 }), 0);
  assert.equal(iou(box, { x: 5, y: 0, width: 10, height: 10 }), 50 / 150);
});

test('padBox grows on every side and clamps to bounds', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(padBox({ x: 40, y: 40, width: 20, height: 10 }, 0.5, bounds), { x: 30, y: 35, width: 40, height: 20 });
  assert.deepEqual(padBox({ x: 0, y: 90, width: 20, height: 10 }, 0.5, bounds), { x: 0, y: 85, width: 30, height: 15 });
});

test('clampBox returns an empty box when fully outside', () => {
  const clamped = clampBox({ x: 200, y: 200, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(clamped.width, 0);
  assert.equal(clamped.height, 0);
});
