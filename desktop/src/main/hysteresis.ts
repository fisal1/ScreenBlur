/**
 * Temporal hysteresis for overlay show/hide decisions.
 *
 * A frame result is recorded as a positive (`show: true`) or negative. The
 * overlay becomes visible once at least `showThreshold` positives are present
 * in the rolling window, and only hides when the number of positives drops
 * *below* `hideThreshold`. The gap between the thresholds is the hysteresis
 * band that prevents flicker.
 *
 * Pure module (no Electron imports) so it is easy to unit test.
 */

export interface HysteresisOptions {
  windowSize: number;
  showThreshold: number;
  hideThreshold: number;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalize(options: HysteresisOptions): HysteresisOptions {
  const windowSize = clampInt(options.windowSize, 1, 1000, 5);
  const showThreshold = clampInt(options.showThreshold, 1, windowSize, 3);
  const hideThreshold = clampInt(options.hideThreshold, 1, showThreshold, 2);
  return { windowSize, showThreshold, hideThreshold };
}

export class Hysteresis {
  private options: HysteresisOptions;
  private readings: boolean[] = [];
  private _visible = false;

  constructor(options: HysteresisOptions) {
    this.options = normalize(options);
  }

  get visible(): boolean {
    return this._visible;
  }

  get optionsSnapshot(): HysteresisOptions {
    return { ...this.options };
  }

  get size(): number {
    return this.readings.length;
  }

  get positives(): number {
    return this.readings.reduce((count, value) => count + (value ? 1 : 0), 0);
  }

  /** Recent readings, oldest first. */
  snapshot(): readonly boolean[] {
    return [...this.readings];
  }

  updateOptions(patch: Partial<HysteresisOptions>): void {
    this.options = normalize({ ...this.options, ...patch });
    this.trim();
  }

  /** Record a result decision and return the new visibility. */
  add(show: boolean): boolean {
    this.readings.push(show);
    this.trim();

    if (!this._visible && this.positives >= this.options.showThreshold) {
      this._visible = true;
    } else if (this._visible && this.positives < this.options.hideThreshold) {
      this._visible = false;
    }
    return this._visible;
  }

  /** Convenience: apply the configured sensitivity to a raw score. */
  addScore(score: number, sensitivity: number): boolean {
    return this.add(score >= sensitivity);
  }

  reset(): void {
    this.readings = [];
    this._visible = false;
  }

  private trim(): void {
    const overflow = this.readings.length - this.options.windowSize;
    if (overflow > 0) this.readings.splice(0, overflow);
  }
}

/**
 * Result sequence numbers increase monotonically. Any result at or below the
 * last applied sequence is stale and must not change the overlay.
 */
export function isStaleSeq(seq: number, lastAppliedSeq: number): boolean {
  return seq <= lastAppliedSeq;
}

export class StaleSeqFilter {
  private _lastApplied = -1;

  get lastApplied(): number {
    return this._lastApplied;
  }

  /** Returns true when the sequence is fresh and records it. */
  accept(seq: number): boolean {
    if (!Number.isInteger(seq) || seq < 0) return false;
    if (isStaleSeq(seq, this._lastApplied)) return false;
    this._lastApplied = seq;
    return true;
  }

  reset(): void {
    this._lastApplied = -1;
  }
}
