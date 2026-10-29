const test = require('node:test');
const assert = require('node:assert/strict');
const { RegionTracker } = require('../src/main/region-tracker');

const options = {
  thresholdHigh: 0.3,
  thresholdLow: 0.15,
  holdMs: 1500,
  matchIou: 0.1,
  dismissMs: 10000,
  velocitySmoothing: 1, // use the latest measurement as-is to keep expectations exact
  maxSpeed: 4,
  renderDelayMs: 0,
  maxLeadMs: 200,
};

function detection(score, x = 0.4, y = 0.4, size = 0.2) {
  return { score, label: 'TEST', box: { x, y, width: size, height: size }, mosaic: null };
}

// Capture time equals arrival time unless given, so motion tests can control both.
function update(tracker, seq, now, detections = [], ts = now) {
  return tracker.update({ seq, ts, regions: detections }, now);
}

function approxBox(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} != ${expected[key]}`);
  }
}

test('a detection at or above the high threshold creates an area', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.29)]);
  assert.equal(tracker.regions.length, 0);
  const result = update(tracker, 2, 200, [detection(0.3)]);
  assert.equal(tracker.regions.length, 1);
  assert.equal(result.changed, true);
});

test('separate detections create separate areas', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5, 0.1, 0.1), detection(0.4, 0.7, 0.6)]);
  assert.equal(tracker.regions.length, 2);
  assert.notEqual(tracker.regions[0].id, tracker.regions[1].id);
});

test('an area follows an overlapping detection above the low threshold', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5, 0.4, 0.4)]);
  update(tracker, 2, 200, [detection(0.2, 0.45, 0.42)]);
  assert.equal(tracker.regions.length, 1);
  approxBox(tracker.regions[0].box, { x: 0.45, y: 0.42, width: 0.2, height: 0.2 });
  assert.equal(tracker.regions[0].confirmedAt, 200);
});

test('a weak non-overlapping detection does not create an area', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5, 0.1, 0.1)]);
  update(tracker, 2, 200, [detection(0.2, 0.7, 0.7)]);
  assert.equal(tracker.regions.length, 1);
});

test('an area is kept for holdMs after it was last confirmed, then removed', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5)]);
  update(tracker, 2, 1500);
  assert.equal(tracker.regions.length, 1);
  const result = update(tracker, 3, 1600);
  assert.equal(tracker.regions.length, 0);
  assert.equal(result.changed, true);
});

test('detections below the low threshold do not keep an area alive', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5)]);
  update(tracker, 2, 1000, [detection(0.1)]);
  update(tracker, 3, 1600, [detection(0.1)]);
  assert.equal(tracker.regions.length, 0);
});

test('stale results are ignored', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 5, 0);
  assert.equal(update(tracker, 4, 100, [detection(0.9)]).stale, true);
  assert.equal(tracker.regions.length, 0);
});

test('dismiss clears areas and blocks new ones for dismissMs', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5)]);
  tracker.dismiss(100);
  assert.equal(tracker.active, false);
  update(tracker, 2, 5000, [detection(0.9)]);
  assert.equal(tracker.regions.length, 0);
  update(tracker, 3, 10200, [detection(0.9)]);
  assert.equal(tracker.regions.length, 1);
});

test('configure changes thresholds for later results', () => {
  const tracker = new RegionTracker({ ...options, thresholdHigh: 0.5, thresholdLow: 0.25 });
  update(tracker, 1, 0, [detection(0.35)]);
  assert.equal(tracker.regions.length, 0);
  tracker.configure({ thresholdHigh: 0.3, thresholdLow: 0.15 });
  update(tracker, 2, 200, [detection(0.35)]);
  assert.equal(tracker.regions.length, 1);
});

test('re-detecting the same area is not reported as a change', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5)]);
  assert.equal(update(tracker, 2, 200, [detection(0.5, 0.42)]).changed, false);
});

// ---- motion ----

test('a still area is drawn exactly where it was detected', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5, 0.4, 0.4)]);
  update(tracker, 2, 40, [detection(0.5, 0.4, 0.4)]);
  approxBox(tracker.displayRegions(80)[0].box, { x: 0.4, y: 0.4, width: 0.2, height: 0.2 });
});

test('a moving area is extended along its motion to cover the predicted position', () => {
  const tracker = new RegionTracker(options);
  // Moves right 0.02 of the screen every 40 ms = 0.0005 per ms.
  update(tracker, 1, 0, [detection(0.5, 0.40, 0.4)]);
  update(tracker, 2, 40, [detection(0.5, 0.42, 0.4)]);
  // 60 ms after capture the content should be 0.03 further right; the patch covers both.
  approxBox(tracker.displayRegions(100)[0].box, { x: 0.42, y: 0.4, width: 0.23, height: 0.2 });
});

test('prediction uses the capture time, not the arrival time', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 30, [detection(0.5, 0.40, 0.4)], 0);
  update(tracker, 2, 70, [detection(0.5, 0.42, 0.4)], 40); // arrives 30 ms after capture
  approxBox(tracker.displayRegions(70)[0].box, { x: 0.42, y: 0.4, width: 0.215, height: 0.2 });
});

test('prediction never reaches further ahead than maxLeadMs', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5, 0.40, 0.4)]);
  update(tracker, 2, 40, [detection(0.5, 0.42, 0.4)]);
  // 1 s later only 200 ms of motion (0.1) is applied.
  approxBox(tracker.displayRegions(1040)[0].box, { x: 0.42, y: 0.4, width: 0.3, height: 0.2 });
});

test('fast motion is still matched to the same area using the predicted position', () => {
  const tracker = new RegionTracker(options);
  // Box 0.1 wide moving 0.08 per 40 ms: consecutive boxes barely overlap.
  update(tracker, 1, 0, [detection(0.5, 0.10, 0.4, 0.1)]);
  update(tracker, 2, 40, [detection(0.5, 0.18, 0.4, 0.1)]);
  const id = tracker.regions[0].id;
  update(tracker, 3, 80, [detection(0.5, 0.26, 0.4, 0.1)]);
  update(tracker, 4, 120, [detection(0.5, 0.34, 0.4, 0.1)]);
  assert.equal(tracker.regions.length, 1);
  assert.equal(tracker.regions[0].id, id);
});

test('implausibly fast jumps are clamped to maxSpeed', () => {
  const tracker = new RegionTracker({ ...options, matchIou: 0 });
  update(tracker, 1, 0, [detection(0.5, 0.0, 0.4)]);
  update(tracker, 2, 10, [detection(0.5, 0.1, 0.4)]); // 10 screens per second
  assert.ok(Math.abs(tracker.regions[0].velocity.x - 0.004) < 1e-12);
});

test('drawn boxes stay on screen', () => {
  const tracker = new RegionTracker(options);
  update(tracker, 1, 0, [detection(0.5, 0.76, 0.4)]);
  update(tracker, 2, 40, [detection(0.5, 0.78, 0.4)]);
  const { box } = tracker.displayRegions(240)[0];
  assert.ok(box.x + box.width <= 1 + 1e-9);
});

// ---- covered-area hold (overlay visible to our own capture) ----

const covered = { ...options, overlayHiddenFromCapture: false, sceneCutFraction: 0.35, coveredMaxHoldMs: 8000 };

function coveredUpdate(tracker, seq, now, detections = [], sceneChange = 0) {
  return tracker.update({ seq, ts: now, sceneChange, regions: detections }, now);
}

test('a covered area is held while the scene stays the same', () => {
  const tracker = new RegionTracker(covered);
  coveredUpdate(tracker, 1, 0, [detection(0.5)]);
  // Our patch now hides the content, so nothing is detected; the scene barely changes.
  for (let i = 2; i <= 20; i++) coveredUpdate(tracker, i, i * 300, [], 0.02);
  assert.equal(tracker.regions.length, 1);
});

test('a covered area is released when the scene changes', () => {
  const tracker = new RegionTracker(covered);
  coveredUpdate(tracker, 1, 0, [detection(0.5)]);
  coveredUpdate(tracker, 2, 300, [], 0.02);
  coveredUpdate(tracker, 3, 600, [], 0.6); // scene cut: hold stops
  coveredUpdate(tracker, 4, 2200, [], 0.02);
  assert.equal(tracker.regions.length, 0);
});

test('a covered area is re-checked after coveredMaxHoldMs', () => {
  const tracker = new RegionTracker(covered);
  coveredUpdate(tracker, 1, 0, [detection(0.5)]);
  coveredUpdate(tracker, 2, 7900, [], 0.01);
  assert.equal(tracker.regions.length, 1);
  coveredUpdate(tracker, 3, 8100, [], 0.01); // past the max hold: no longer refreshed
  coveredUpdate(tracker, 4, 9700, [], 0.01); // and expires after holdMs
  assert.equal(tracker.regions.length, 0);
});

test('a real detection restarts the covered hold', () => {
  const tracker = new RegionTracker(covered);
  coveredUpdate(tracker, 1, 0, [detection(0.5)]);
  coveredUpdate(tracker, 2, 7000, [detection(0.5)]); // content seen again (e.g. moved partly out)
  coveredUpdate(tracker, 3, 14000, [], 0.01);
  assert.equal(tracker.regions.length, 1);
});

test('areas are not held when the overlay is hidden from capture', () => {
  const tracker = new RegionTracker({ ...covered, overlayHiddenFromCapture: true });
  coveredUpdate(tracker, 1, 0, [detection(0.5)]);
  coveredUpdate(tracker, 2, 1000, [], 0.01);
  coveredUpdate(tracker, 3, 1600, [], 0.01);
  assert.equal(tracker.regions.length, 0);
});
