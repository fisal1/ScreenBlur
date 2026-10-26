// DecisionEngine: turns per-frame scores into show/hide decisions (RFC 6.2, 6.3).
//
// - Stale results (seq <= last applied) are ignored.
// - Show on a single frame with score >= thresholdHigh.
// - Hide only after `clearFramesToHide` consecutive frames below thresholdLow
//   AND at least `minShowMs` since the last positive frame.
// - Scores between the two thresholds keep the current state and break a clear streak.
// - dismiss() ("this was wrong") hides immediately and suppresses re-showing for `dismissMs`.

// Sensitivity is a user-facing percentage: blur when the score reaches it, and hide again
// once the score drops below half of it. Tuned for the NudeNet detector, whose confidences run
// lower than a classifier's probabilities. Observed so far: safe screens ~0-2%, explicit
// content on a 1920x1080 screen ~35%.
const THRESHOLD_PERCENT_RANGE = Object.freeze({ min: 5, max: 95 });

const SENSITIVITY_PRESETS = Object.freeze({
  strict: 20,
  balanced: 30,
  relaxed: 45,
});

function clampThresholdPercent(percent) {
  const { min, max } = THRESHOLD_PERCENT_RANGE;
  const value = Math.round(Number(percent));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : SENSITIVITY_PRESETS.balanced;
}

function thresholdsFromPercent(percent) {
  const thresholdHigh = clampThresholdPercent(percent) / 100;
  return { thresholdHigh, thresholdLow: thresholdHigh / 2 };
}

const DEFAULTS = {
  ...thresholdsFromPercent(SENSITIVITY_PRESETS.balanced),
  clearFramesToHide: 4,
  minShowMs: 1500,
  dismissMs: 10000,
};

class DecisionEngine {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.lastAppliedSeq = -1;
    this.reset();
  }

  configure(options) {
    this.options = { ...this.options, ...options };
  }

  reset() {
    this.shown = false;
    this.clearCount = 0;
    this.lastPositiveAt = 0;
    this.suppressUntil = 0;
  }

  // Returns { stale: true } for out-of-order results, otherwise { shown, changed }.
  update({ seq, score }, now) {
    if (seq <= this.lastAppliedSeq) return { stale: true, shown: this.shown, changed: false };
    this.lastAppliedSeq = seq;

    const before = this.shown;
    const { thresholdHigh, thresholdLow, clearFramesToHide, minShowMs } = this.options;

    if (now < this.suppressUntil) {
      this.shown = false;
    } else if (score >= thresholdHigh) {
      this.shown = true;
      this.clearCount = 0;
      this.lastPositiveAt = now;
    } else if (this.shown) {
      this.clearCount = score < thresholdLow ? this.clearCount + 1 : 0;
      if (this.clearCount >= clearFramesToHide && now - this.lastPositiveAt >= minShowMs) {
        this.shown = false;
        this.clearCount = 0;
      }
    }

    return { stale: false, shown: this.shown, changed: before !== this.shown };
  }

  dismiss(now) {
    this.shown = false;
    this.clearCount = 0;
    this.suppressUntil = now + this.options.dismissMs;
  }
}

module.exports = {
  DecisionEngine,
  DEFAULTS,
  SENSITIVITY_PRESETS,
  THRESHOLD_PERCENT_RANGE,
  clampThresholdPercent,
  thresholdsFromPercent,
};
