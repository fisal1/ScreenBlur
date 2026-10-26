const { nativeImage } = require('electron');

const ICON_SIZE = 16;

const IconColor = Object.freeze({
  WATCHING: [46, 204, 113],
  HIDING: [231, 76, 60],
  INACTIVE: [149, 165, 166],
});

/** Builds an anti-aliased colored dot icon without needing an image file. */
function createDotIcon([red, green, blue]) {
  const buffer = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  const center = (ICON_SIZE - 1) / 2;
  const radius = ICON_SIZE / 2 - 1;

  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const distance = Math.hypot(x - center, y - center);
      const alpha = Math.max(0, Math.min(1, radius - distance + 0.5));
      const offset = (y * ICON_SIZE + x) * 4;
      // BGRA, premultiplied alpha
      buffer[offset] = blue * alpha;
      buffer[offset + 1] = green * alpha;
      buffer[offset + 2] = red * alpha;
      buffer[offset + 3] = alpha * 255;
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: ICON_SIZE, height: ICON_SIZE });
}

module.exports = { createDotIcon, IconColor };
