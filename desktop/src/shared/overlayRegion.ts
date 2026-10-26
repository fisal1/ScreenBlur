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
const MERGE_GAP = 0.015;
const MIN_REGION_SIZE = 0.025;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function safePadding(padding: number): number {
  return Math.min(0.2, Math.max(0, Number.isFinite(padding) ? padding : DEFAULT_PADDING));
}

function rectangleForBox(
  box: readonly number[],
  padding: number,
  minimumSize = 0,
): NormalizedRect | null {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const a = typeof box[0] === 'number' ? box[0] : Number.NaN;
  const b = typeof box[1] === 'number' ? box[1] : Number.NaN;
  const c = typeof box[2] === 'number' ? box[2] : Number.NaN;
  const d = typeof box[3] === 'number' ? box[3] : Number.NaN;
  if (![a, b, c, d].every(Number.isFinite)) return null;

  const x1 = clamp01(Math.min(a, c));
  const y1 = clamp01(Math.min(b, d));
  const x2 = clamp01(Math.max(a, c));
  const y2 = clamp01(Math.max(b, d));
  if (x2 <= x1 || y2 <= y1) return null;

  let x = clamp01(x1 - padding);
  let y = clamp01(y1 - padding);
  let w = clamp01(x2 + padding) - x;
  let h = clamp01(y2 + padding) - y;
  if (w <= 0 || h <= 0) return null;

  if (minimumSize > 0) {
    const target = Math.min(1, minimumSize);
    const targetWidth = Math.max(w, target);
    const targetHeight = Math.max(h, target);
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    x = clamp01(centerX - targetWidth / 2);
    y = clamp01(centerY - targetHeight / 2);
    w = Math.min(targetWidth, 1 - x);
    h = Math.min(targetHeight, 1 - y);
  }

  return { x, y, w, h };
}

function intersects(first: NormalizedRect, second: NormalizedRect): boolean {
  return (
    first.x < second.x + second.w + MERGE_GAP &&
    first.x + first.w + MERGE_GAP > second.x &&
    first.y < second.y + second.h + MERGE_GAP &&
    first.y + first.h + MERGE_GAP > second.y
  );
}

function union(first: NormalizedRect, second: NormalizedRect): NormalizedRect {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.w, second.x + second.w);
  const bottom = Math.max(first.y + first.h, second.y + second.h);
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Merge only boxes that overlap or nearly touch. Unlike a global union, this
 * keeps separate people/regions separate while grouping adjacent body parts
 * belonging to the same person.
 */
function mergeOverlapping(rects: NormalizedRect[]): NormalizedRect[] {
  const pending = rects.slice();
  const merged: NormalizedRect[] = [];

  while (pending.length > 0) {
    let current = pending.shift() as NormalizedRect;
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < pending.length; index += 1) {
        const candidate = pending[index];
        if (!candidate || !intersects(current, candidate)) continue;
        current = union(current, candidate);
        pending.splice(index, 1);
        changed = true;
        break;
      }
    }
    merged.push(current);
  }

  return merged;
}

function validRectangles(
  boxes: readonly (readonly number[])[] | null | undefined,
  padding: number,
  minimumSize = 0,
): NormalizedRect[] {
  if (!Array.isArray(boxes) || boxes.length === 0) return [];
  const safe = safePadding(padding);
  const rects: NormalizedRect[] = [];
  for (const box of boxes) {
    const rectangle = rectangleForBox(box, safe, minimumSize);
    if (rectangle) rects.push(rectangle);
  }
  return rects;
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
  const rects = validRectangles(boxes, padding);
  if (rects.length === 0) return null;

  let left = 1;
  let top = 1;
  let right = 0;
  let bottom = 0;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.w);
    bottom = Math.max(bottom, rect.y + rect.h);
  }

  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null;

  // A nearly-full detector box is effectively a full-screen cover. Returning
  // null avoids a visible rounded-card edge around the whole display.
  if (w >= FULL_SCREEN_THRESHOLD && h >= FULL_SCREEN_THRESHOLD) return null;

  return { x: left, y: top, w, h };
}

/**
 * Return one padded rectangle per detected person/region. Overlapping or
 * near-touching boxes are merged, but disjoint regions remain independent so
 * the overlay does not blur the whole screen for two separate detections.
 *
 * An empty result means the caller should use the full-screen fallback.
 */
export function regionsForBoxes(
  boxes: readonly (readonly number[])[] | null | undefined,
  padding = DEFAULT_PADDING,
): NormalizedRect[] {
  const rects = validRectangles(boxes, padding, MIN_REGION_SIZE);
  if (rects.length === 0) return [];

  const merged = mergeOverlapping(rects);
  if (merged.some((rect) => rect.w >= FULL_SCREEN_THRESHOLD && rect.h >= FULL_SCREEN_THRESHOLD)) {
    return [];
  }
  return merged;
}
