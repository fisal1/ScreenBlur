const test = require('node:test');
const assert = require('node:assert/strict');
const { mosaic, toScreenRegions } = require('../src/inference/regions');

/** width x height RGBA frame: left half red, right half blue. */
function splitFrame(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      rgba.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], p);
    }
  }
  return rgba;
}

test('mosaic averages each cell and keeps the box aspect ratio', () => {
  const rgba = splitFrame(64, 32);
  const grid = mosaic(rgba, 64, { x: 0, y: 0, width: 64, height: 32 }, 4);
  assert.equal(grid.cols, 4);
  assert.equal(grid.rows, 2);
  assert.deepEqual(grid.data.slice(0, 4), [255, 0, 0, 255]); // top-left cell is red
  assert.deepEqual(grid.data.slice(12, 16), [0, 0, 255, 255]); // top-right cell is blue
});

test('regions are padded, clamped and normalized to the screen content area', () => {
  const frame = { rgba: splitFrame(96, 64), width: 96, contentWidth: 96, contentHeight: 54 };
  const [region] = toScreenRegions(
    [{ score: 0.5, label: 'TEST', box: { x: 48, y: 27, width: 24, height: 10 } }],
    frame,
    { padding: 0.5, mosaicCells: 4 },
  );
  assert.equal(region.score, 0.5);
  assert.deepEqual(region.box, { x: 36 / 96, y: 22 / 54, width: 48 / 96, height: 20 / 54 });
  assert.ok(region.mosaic.cols >= 1 && region.mosaic.rows >= 1);
});

test('detections inside the black padding are dropped', () => {
  const frame = { rgba: splitFrame(96, 64), width: 96, contentWidth: 96, contentHeight: 54 };
  const regions = toScreenRegions(
    [{ score: 0.5, label: 'TEST', box: { x: 10, y: 58, width: 10, height: 4 } }],
    frame,
    { padding: 0, mosaicCells: 4 },
  );
  assert.equal(regions.length, 0);
});
