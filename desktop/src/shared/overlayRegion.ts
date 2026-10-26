/**
 * Geometry helpers for the detected-area overlay.
 *
 * Detector boxes use normalized coordinates in the range 0..1:
 * `[x1, y1, x2, y2]`, with the origin at the top-left of the captured frame.
 * The overlay window spans the whole display, so the same normalized values
 * can be used directly as CSS percentages.
 */

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_PADDING = 0.02;
const FULL_SCREEN_THRESHOLD = 0.98;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Return the union of valid boxes, expanded by a small padding. Invalid boxes
 * are ignored. Returns null when there is nothing usable, which tells the
 * overlay renderer to fall back to a full-screen cover.
 */
export function regionForBoxes(
  boxes: readonly (readonly number[])[] | null | undefined,
  padding = DEFAULT_PADDING,
): NormalizedRect | null {
  if (!Array.isArray(boxes) || boxes.length === 0) return null;

  let left = 1;
  let top = 1;
  let right = 0;
  let bottom = 0;
  let found = false;

  for (const box of boxes) {
    if (!Array.isArray(box) || box.length !== 4) continue;
    const a = typeof box[0] === 'number' ? box[0] : Number.NaN;
    const b = typeof box[1] === 'number' ? box[1] : Number.NaN;
    const c = typeof box[2] === 'number' ? box[2] : Number.NaN;
    const d = typeof box[3] === 'number' ? box[3] : Number.NaN;
    if (![a, b, c, d].every(Number.isFinite)) continue;

    const x1 = clamp01(Math.min(a, c));
    const y1 = clamp01(Math.min(b, d));
    const x2 = clamp01(Math.max(a, c));
    const y2 = clamp01(Math.max(b, d));
    if (x2 <= x1 || y2 <= y1) continue;

    left = Math.min(left, x1);
    top = Math.min(top, y1);
    right = Math.max(right, x2);
    bottom = Math.max(bottom, y2);
    found = true;
  }

  if (!found) return null;

  const safePadding = Math.min(0.2, Math.max(0, Number.isFinite(padding) ? padding : DEFAULT_PADDING));
  const x = clamp01(left - safePadding);
  const y = clamp01(top - safePadding);
  const w = clamp01(right + safePadding) - x;
  const h = clamp01(bottom + safePadding) - y;
  if (w <= 0 || h <= 0) return null;

  // A nearly-full detector box is effectively a full-screen cover. Returning
  // null avoids a visible rounded-card edge around the whole display.
  if (w >= FULL_SCREEN_THRESHOLD && h >= FULL_SCREEN_THRESHOLD) return null;

  return { x, y, w, h };
}
