const test = require('node:test');
const assert = require('node:assert/strict');
const { COVER_SIZES, DEFAULT_COVER_SIZE, getCoverSize, coverageOptions } = require('../src/main/cover-size');

test('cover sizes grow from normal to large to whole body', () => {
  assert.ok(COVER_SIZES.large.padding > COVER_SIZES.normal.padding);
  assert.ok(COVER_SIZES.body.padding >= COVER_SIZES.large.padding, 'whole body is never smaller than large');
  assert.equal(COVER_SIZES.body.bodyContext, true);
  assert.equal(COVER_SIZES.large.bodyContext, false);
});

test('large is the default and unknown sizes fall back to it', () => {
  assert.equal(DEFAULT_COVER_SIZE, 'large');
  assert.equal(getCoverSize('huge').id, 'large');
});

test('coverage options carry everything the worker needs', () => {
  const options = coverageOptions('body');
  assert.deepEqual(Object.keys(options).sort(), ['bodyContext', 'contextMinScore', 'contextReach', 'merge', 'padding']);
});
