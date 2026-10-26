/**
 * Model input size for a display: same aspect ratio as the screen, long side `longSide`,
 * both sides rounded up to a multiple of `stride` (the padding is filled black).
 */
function modelInputSize({ width, height }, { longSide, stride }) {
  const scale = longSide / Math.max(width, height);
  const roundUp = (value) => Math.ceil((value * scale) / stride) * stride;
  return { width: roundUp(width), height: roundUp(height) };
}

module.exports = { modelInputSize };
