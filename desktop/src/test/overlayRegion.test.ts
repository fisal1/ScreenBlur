import { describe, expect, it } from 'vitest';

import { regionForBoxes } from '../shared/overlayRegion';

describe('regionForBoxes', () => {
  it('returns null for missing or invalid boxes (full-screen fallback)', () => {
    expect(regionForBoxes([])).toBeNull();
    expect(regionForBoxes(null)).toBeNull();
    expect(regionForBoxes([[0.4, 0.4, 0.4, 0.4]])).toBeNull();
    expect(regionForBoxes([['bad', 0, 1, 1]])).toBeNull();
  });

  it('returns a padded normalized region around a box', () => {
    const region = regionForBoxes([[0.25, 0.2, 0.75, 0.8]], 0.02);
    expect(region).not.toBeNull();
    expect(region?.x).toBeCloseTo(0.23);
    expect(region?.y).toBeCloseTo(0.18);
    expect(region?.w).toBeCloseTo(0.54);
    expect(region?.h).toBeCloseTo(0.64);
  });

  it('unions multiple boxes and clamps at the screen edges', () => {
    const region = regionForBoxes(
      [
        [0.0, 0.1, 0.2, 0.4],
        [0.8, 0.6, 0.98, 1.0],
      ],
      0.05,
    );
    expect(region).not.toBeNull();
    expect(region?.x).toBe(0);
    expect(region?.y).toBeCloseTo(0.05);
    expect(region?.w).toBeCloseTo(1);
    expect(region?.h).toBeCloseTo(0.95);
  });

  it('falls back to full screen when the box nearly fills the display', () => {
    expect(regionForBoxes([[0.0, 0.0, 1.0, 1.0]])).toBeNull();
    expect(regionForBoxes([[0.005, 0.005, 0.995, 0.995]])).toBeNull();
  });
});
