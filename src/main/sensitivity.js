// Sensitivity is a user-facing percentage: an area is blurred when its score reaches it and
// stays blurred while the score stays above half of it. Tuned for the NudeNet detector, whose
// confidences run lower than a classifier's probabilities. Observed so far: safe screens ~0-2%,
// explicit content on a 1920x1080 screen ~35%.

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

module.exports = { THRESHOLD_PERCENT_RANGE, SENSITIVITY_PRESETS, clampThresholdPercent, thresholdsFromPercent };
