// Motion prediction for blurred areas, shared by the region tracker (main) and the overlay page.
const { clampBox, unionBox, translateBox } = require('./geometry');

const SCREEN = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

/** Where a box moving at `velocity` (per ms) is expected `elapsedMs` later, capped at `maxLeadMs`. */
function predictBox(box, velocity, elapsedMs, maxLeadMs) {
  const leadMs = Math.min(maxLeadMs, Math.max(0, elapsedMs));
  return translateBox(box, velocity.x * leadMs, velocity.y * leadMs);
}

/**
 * Box to draw at time `now`: covers both where the content was when captured and where it is
 * predicted to be once the patch is on screen, so it stays covered whether it keeps moving or stops.
 */
function sweptBox({ box, velocity, capturedAt }, now, { renderDelayMs, maxLeadMs }) {
  const predicted = predictBox(box, velocity, now + renderDelayMs - capturedAt, maxLeadMs);
  return clampBox(unionBox(box, predicted), SCREEN);
}

module.exports = { predictBox, sweptBox };
