import { describe, expect, it } from 'vitest';

import { regionForBoxes, regionsForBoxes } from '../shared/overlayRegion';

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

describe('regionsForBoxes', () => {
  it('keeps disjoint detections as separate regions', () => {
    const regions = regionsForBoxes(
      [
        [0.05, 0.1, 0.25, 0.5],
        [0.7, 0.2, 0.9, 0.7],
      ],
      0.01,
    );
    expect(regions).toHaveLength(2);
    expect(regions[0].w).toBeLessThan(0.4);
    expect(regions[1].x).toBeGreaterThan(0.6);
  });

  it('merges near-touching boxes into one person-sized region', () => {
    const regions = regionsForBoxes(
      [
        [0.2, 0.2, 0.4, 0.4],
        [0.41, 0.2, 0.6, 0.4],
      ],
      0.01,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].x).toBeCloseTo(0.19);
    expect(regions[0].w).toBeCloseTo(0.42);
  });

  it('returns an empty list for the full-screen fallback', () => {
    expect(regionsForBoxes([])).toEqual([]);
    expect(regionsForBoxes([[0.0, 0.0, 1.0, 1.0]])).toEqual([]);
  });
});
