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

// ---- cover size: margin, merging, whole body ----
const { coverAreas, expandWithContext, mergeTouching } = require('../src/inference/regions');

const CONTENT = { x: 0, y: 0, width: 1000, height: 1000 };
const area = (x, y, width, height, score = 0.5, label = 'TEST') => ({ score, label, box: { x, y, width, height } });

test('normal cover: 20% margin, separate areas stay separate', () => {
  const covers = coverAreas([area(100, 100, 100, 100), area(230, 100, 100, 100)], [], CONTENT, { padding: 0.2 });
  assert.equal(covers.length, 2);
  assert.deepEqual(covers[0].box, { x: 80, y: 80, width: 140, height: 140 });
});

test('large cover: 50% margin and touching covers merge into one', () => {
  const covers = coverAreas([area(100, 100, 100, 100, 0.6, 'A'), area(230, 100, 100, 100, 0.3, 'B')], [], CONTENT, { padding: 0.5, merge: true });
  assert.equal(covers.length, 1);
  assert.deepEqual(covers[0].box, { x: 50, y: 50, width: 330, height: 200 });
  assert.equal(covers[0].score, 0.6);
  assert.equal(covers[0].label, 'A');
});

test('merging is transitive: a cover that grows can swallow an earlier one', () => {
  const merged = mergeTouching([area(0, 0, 10, 10), area(100, 0, 10, 10), area(5, 0, 100, 10)]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].box, { x: 0, y: 0, width: 110, height: 10 });
});

test('whole body: a cover grows over nearby body parts but not distant ones', () => {
  const chest = { x: 400, y: 300, width: 100, height: 80 };
  const belly = { box: { x: 380, y: 400, width: 140, height: 120 } }; // just below the chest
  const farAway = { box: { x: 900, y: 900, width: 50, height: 50 } };
  const grown = expandWithContext(chest, [belly, farAway], 0.6);
  assert.deepEqual(grown, { x: 380, y: 300, width: 140, height: 220 });
});

test('whole body is only used when enabled', () => {
  const chest = area(400, 300, 100, 80);
  const belly = { box: { x: 380, y: 400, width: 140, height: 120 } };
  const [without] = coverAreas([chest], [belly], CONTENT, { padding: 0, bodyContext: false });
  const [withBody] = coverAreas([chest], [belly], CONTENT, { padding: 0, bodyContext: true, contextReach: 0.6 });
  assert.deepEqual(without.box, chest.box);
  assert.deepEqual(withBody.box, { x: 380, y: 300, width: 140, height: 220 });
});

test('covers never extend past the screen', () => {
  const [cover] = coverAreas([area(950, 950, 100, 100)], [], CONTENT, { padding: 0.5 });
  assert.ok(cover.box.x + cover.box.width <= 1000 && cover.box.y + cover.box.height <= 1000);
});
