// Axis-aligned boxes: { x, y, width, height }.

function area(box) {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

/** Intersection over union, 0..1. */
function iou(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = area({ x: left, y: top, width: right - left, height: bottom - top });
  const union = area(a) + area(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Grows a box by `fraction` of its size on every side, then clamps it to `bounds`. */
function padBox(box, fraction, bounds) {
  const dx = box.width * fraction;
  const dy = box.height * fraction;
  return clampBox({ x: box.x - dx, y: box.y - dy, width: box.width + 2 * dx, height: box.height + 2 * dy }, bounds);
}

function clampBox(box, bounds) {
  const x = Math.max(bounds.x, box.x);
  const y = Math.max(bounds.y, box.y);
  const right = Math.min(bounds.x + bounds.width, box.x + box.width);
  const bottom = Math.min(bounds.y + bounds.height, box.y + box.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Smallest box containing both boxes. */
function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function center(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function translateBox(box, dx, dy) {
  return { ...box, x: box.x + dx, y: box.y + dy };
}

module.exports = { area, iou, padBox, clampBox, unionBox, center, translateBox };
