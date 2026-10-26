import { describe, expect, it } from 'vitest';

import { Hysteresis, isStaleSeq, StaleSeqFilter } from '../main/hysteresis';

function make(): Hysteresis {
  return new Hysteresis({ windowSize: 5, showThreshold: 3, hideThreshold: 2 });
}

describe('Hysteresis', () => {
  it('shows only after the show threshold is reached', () => {
    const hysteresis = make();
    expect(hysteresis.add(true)).toBe(false);
    expect(hysteresis.add(true)).toBe(false);
    expect(hysteresis.visible).toBe(false);
    expect(hysteresis.add(true)).toBe(true);
    expect(hysteresis.visible).toBe(true);
  });

  it('hides only when positives fall below the hide threshold', () => {
    const hysteresis = make();
    hysteresis.add(false);
    hysteresis.add(false);
    hysteresis.add(true);
    hysteresis.add(true);
    hysteresis.add(true);
    expect(hysteresis.visible).toBe(true);

    // Fill the window with negatives; the overlay stays visible while the
    // number of positives remains at or above hideThreshold=2.
    hysteresis.add(false);
    hysteresis.add(false);
    hysteresis.add(false);
    expect(hysteresis.positives).toBe(2);
    expect(hysteresis.visible).toBe(true);

    // 1 positive is below hideThreshold=2.
    expect(hysteresis.add(false)).toBe(false);
    expect(hysteresis.positives).toBe(1);
    expect(hysteresis.visible).toBe(false);
  });

  it('resizes its rolling window without losing the newest readings', () => {
    const hysteresis = make();
    hysteresis.add(true);
    hysteresis.add(true);
    hysteresis.add(true);
    expect(hysteresis.visible).toBe(true);

    hysteresis.updateOptions({ windowSize: 2, showThreshold: 1, hideThreshold: 1 });
    expect(hysteresis.size).toBe(2);
    expect(hysteresis.snapshot()).toEqual([true, true]);

    hysteresis.add(false);
    expect(hysteresis.visible).toBe(true);
    hysteresis.add(false);
    expect(hysteresis.visible).toBe(false);
  });

  it('clamps inconsistent thresholds and resets', () => {
    const hysteresis = new Hysteresis({ windowSize: 3, showThreshold: 99, hideThreshold: 99 });
    expect(hysteresis.optionsSnapshot).toEqual({ windowSize: 3, showThreshold: 3, hideThreshold: 3 });
    hysteresis.add(true);
    hysteresis.add(true);
    hysteresis.add(true);
    expect(hysteresis.visible).toBe(true);
    hysteresis.reset();
    expect(hysteresis.visible).toBe(false);
    expect(hysteresis.size).toBe(0);
  });

  it('applies a sensitivity to raw scores', () => {
    const hysteresis = make();
    expect(hysteresis.addScore(0.79, 0.8)).toBe(false);
    expect(hysteresis.addScore(0.81, 0.8)).toBe(false);
    expect(hysteresis.addScore(0.95, 0.8)).toBe(false);
    expect(hysteresis.addScore(0.95, 0.8)).toBe(true);
  });
});

describe('stale sequence filtering', () => {
  it('compares against the last applied sequence', () => {
    expect(isStaleSeq(3, 3)).toBe(true);
    expect(isStaleSeq(2, 3)).toBe(true);
    expect(isStaleSeq(4, 3)).toBe(false);
  });

  it('accepts strictly increasing results only', () => {
    const filter = new StaleSeqFilter();
    expect(filter.accept(1)).toBe(true);
    expect(filter.accept(1)).toBe(false);
    expect(filter.accept(0)).toBe(false);
    expect(filter.accept(2)).toBe(true);
    expect(filter.lastApplied).toBe(2);
    expect(filter.accept(Number.NaN)).toBe(false);
    filter.reset();
    expect(filter.accept(1)).toBe(true);
  });
});
