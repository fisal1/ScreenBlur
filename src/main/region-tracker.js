const { iou, center } = require('../shared/geometry');
const { predictBox, sweptBox } = require('../shared/motion');

// Per-area hysteresis (RFC 6.2, 6.3 applied to each detected area):
// - Results older than the last applied one (by seq) are ignored.
// - A new area appears when a detection scores >= thresholdHigh.
// - A tracked area follows any overlapping detection scoring >= thresholdLow.
// - An area disappears once it hasn't been confirmed for `holdMs`.
// - dismiss() ("this was wrong") clears all areas and blocks new ones for `dismissMs`.
//
// Motion compensation: each area's velocity is estimated from successive detections. When
// drawn, an area covers both where the content was when captured and where it is predicted
// to be now, so moving content stays covered whether it keeps moving or stops.
//
// Covered-area hold: when the overlay appears in our own capture (overlayHiddenFromCapture =
// false), the detector sees the patch instead of the content, so a covered area can't be
// re-confirmed. Such areas are kept until the scene changes (`sceneChange`, the share of
// changed pixels, reaches sceneCutFraction) or for at most coveredMaxHoldMs since the content
// was last actually detected. Without this the patch would disappear, the content would show,
// get re-detected, and the patch would blink.

const DEFAULTS = Object.freeze({
  thresholdHigh: 0.3,
  thresholdLow: 0.15,
  holdMs: 1500,
  matchIou: 0.1,
  dismissMs: 10000,
  velocitySmoothing: 0.5, // weight of the newest velocity measurement (0..1)
  maxSpeed: 4, // screens per second; faster estimates are treated as detection noise
  renderDelayMs: 20, // time from receiving a result until the patch is on screen
  maxLeadMs: 200, // never predict further ahead than this
  overlayHiddenFromCapture: true,
  sceneCutFraction: 0.35,
  coveredMaxHoldMs: 8000,
});

class RegionTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.lastAppliedSeq = -1;
    this.nextId = 1;
    this.reset();
  }

  configure(options) {
    this.options = { ...this.options, ...options };
  }

  reset() {
    this.regions = [];
    this.suppressUntil = 0;
  }

  get active() {
    return this.regions.length > 0;
  }

  /**
   * @param result { seq, ts, sceneChange, regions: [{ box, score, label, mosaic }] } with boxes
   *        normalized to the screen, `ts` the capture time of the frame and `sceneChange` the
   *        share (0..1) of screen pixels that changed since the previous frame
   * @returns { stale, changed }
   */
  update({ seq, ts, sceneChange = 0, regions: detections = [] }, now) {
    if (seq <= this.lastAppliedSeq) return { stale: true, changed: false };
    this.lastAppliedSeq = seq;

    const before = this.ids();
    if (now < this.suppressUntil) {
      this.regions = [];
    } else {
      this.applyDetections(detections, ts ?? now, now, sceneChange);
    }
    return { stale: false, changed: this.ids() !== before };
  }

  dismiss(now) {
    this.regions = [];
    this.suppressUntil = now + this.options.dismissMs;
  }

  /** Areas to draw at time `now`, with boxes extended along their predicted motion. */
  displayRegions(now) {
    return this.regions.map((region) => ({ ...this.motionState(region), box: sweptBox(region, now, this.options) }));
  }

  /**
   * Areas with their motion, for a renderer that keeps moving them between results
   * (see shared/motion.js sweptBox).
   */
  motionStates() {
    return this.regions.map((region) => this.motionState(region));
  }

  motionState({ id, box, velocity, capturedAt, mosaic, score, label }) {
    return { id, box, velocity, capturedAt, mosaic, score, label };
  }

  applyDetections(detections, capturedAt, now, sceneChange) {
    const { thresholdHigh, thresholdLow, holdMs, matchIou } = this.options;
    const candidates = detections.filter((detection) => detection.score >= thresholdLow);
    const used = new Set();
    const unmatched = [];

    for (const region of this.regions) {
      const match = this.bestMatch(this.predictBox(region, capturedAt), candidates, used);
      if (!match) {
        unmatched.push(region);
        continue;
      }
      used.add(match);
      this.follow(region, match, capturedAt, now);
    }

    for (const detection of candidates) {
      if (used.has(detection) || detection.score < thresholdHigh) continue;
      if (this.regions.some((region) => iou(region.box, detection.box) >= matchIou)) continue;
      this.regions.push({ id: this.nextId++, ...detection, velocity: { x: 0, y: 0 }, capturedAt, confirmedAt: now, detectedAt: now });
    }

    if (!this.options.overlayHiddenFromCapture) this.holdCovered(unmatched, now, sceneChange);
    this.regions = this.regions.filter((region) => now - region.confirmedAt <= holdMs);
  }

  /**
   * Keeps covered areas alive while the scene stays the same (see "Covered-area hold").
   * A scene cut ends an area's hold until the content is actually detected again.
   */
  holdCovered(regions, now, sceneChange) {
    const { sceneCutFraction, coveredMaxHoldMs } = this.options;
    const sceneCut = sceneChange >= sceneCutFraction;
    for (const region of regions) {
      if (sceneCut) region.holdReleased = true;
      if (region.holdReleased || now - region.detectedAt > coveredMaxHoldMs) continue;
      region.confirmedAt = now;
    }
  }

  follow(region, detection, capturedAt, now) {
    const elapsedMs = capturedAt - region.capturedAt;
    if (elapsedMs > 0) {
      const from = center(region.box);
      const to = center(detection.box);
      region.velocity = this.smoothVelocity(region.velocity, {
        x: (to.x - from.x) / elapsedMs,
        y: (to.y - from.y) / elapsedMs,
      });
    }
    Object.assign(region, {
      box: detection.box,
      score: detection.score,
      label: detection.label,
      mosaic: detection.mosaic,
      capturedAt,
      confirmedAt: now,
      detectedAt: now,
      holdReleased: false,
    });
  }

  smoothVelocity(previous, measured) {
    const { velocitySmoothing: weight, maxSpeed } = this.options;
    const limit = maxSpeed / 1000; // per ms
    const clamp = (value) => Math.max(-limit, Math.min(limit, value));
    return {
      x: clamp(weight * measured.x + (1 - weight) * previous.x),
      y: clamp(weight * measured.y + (1 - weight) * previous.y),
    };
  }

  /** Where the area is expected to be at `time`, given its velocity. */
  predictBox({ box, velocity, capturedAt }, time) {
    return predictBox(box, velocity, time - capturedAt, this.options.maxLeadMs);
  }

  bestMatch(expectedBox, candidates, used) {
    let best = null;
    let bestOverlap = this.options.matchIou;
    for (const candidate of candidates) {
      if (used.has(candidate)) continue;
      const overlap = iou(expectedBox, candidate.box);
      if (overlap >= bestOverlap) {
        best = candidate;
        bestOverlap = overlap;
      }
    }
    return best;
  }

  ids() {
    return this.regions.map(({ id }) => id).join(',');
  }
}

module.exports = { RegionTracker, DEFAULTS };
