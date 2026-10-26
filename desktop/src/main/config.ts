import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AppConfig, OverlayCoverage, OverlayMode } from '../shared/types';

export const DEFAULT_CONFIG: Readonly<AppConfig> = Object.freeze({
  sensitivity: 0.8,
  fps: 2,
  jpegQuality: 75,
  maxWidth: 1280,
  hysteresisWindow: 5,
  showThreshold: 3,
  hideThreshold: 2,
  overlayMode: 'blur' as OverlayMode,
  overlayCoverage: 'detected' as OverlayCoverage,
  overlayGifPath: '',
  startPaused: false,
  launchAtLogin: false,
  autoStart: true,
  displayId: null,
});

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.trunc(clampNumber(value, min, max, fallback));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickMode(value: unknown, fallback: OverlayMode): OverlayMode {
  return value === 'gif' || value === 'blur' ? value : fallback;
}

function pickCoverage(value: unknown, fallback: OverlayCoverage): OverlayCoverage {
  return value === 'detected' || value === 'full' ? value : fallback;
}

/**
 * Validate an arbitrary value into a complete AppConfig, clamped to safe
 * ranges. Unknown keys are dropped.
 */
export function sanitizeConfig(input: unknown, base: Readonly<AppConfig> = DEFAULT_CONFIG): AppConfig {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};

  const windowSize = clampInt(record.hysteresisWindow, 3, 9, base.hysteresisWindow);
  const showThreshold = clampInt(record.showThreshold, 1, windowSize, base.showThreshold);
  const hideThreshold = clampInt(record.hideThreshold, 1, showThreshold, base.hideThreshold);

  const rawPath = typeof record.overlayGifPath === 'string' ? record.overlayGifPath.trim() : base.overlayGifPath;
  const overlayGifPath = rawPath.slice(0, 4096);

  const rawDisplay = record.displayId;
  let displayId: number | null = base.displayId;
  if (rawDisplay === null) {
    displayId = null;
  } else if (typeof rawDisplay === 'number' && Number.isInteger(rawDisplay) && rawDisplay > 0) {
    displayId = rawDisplay;
  }

  return {
    sensitivity: clampNumber(record.sensitivity, 0.5, 0.95, base.sensitivity),
    fps: clampInt(record.fps, 1, 5, base.fps),
    jpegQuality: clampInt(record.jpegQuality, 50, 95, base.jpegQuality),
    maxWidth: clampInt(record.maxWidth, 320, 3840, base.maxWidth),
    hysteresisWindow: windowSize,
    showThreshold,
    hideThreshold,
    overlayMode: pickMode(record.overlayMode, base.overlayMode),
    overlayCoverage: pickCoverage(record.overlayCoverage, base.overlayCoverage),
    overlayGifPath,
    startPaused: bool(record.startPaused, base.startPaused),
    launchAtLogin: bool(record.launchAtLogin, base.launchAtLogin),
    autoStart: bool(record.autoStart, base.autoStart),
    displayId,
  };
}

/** Merge a patch into a config, keeping unspecified fields unchanged. */
export function mergeConfig(base: AppConfig, patch: unknown): AppConfig {
  if (typeof patch !== 'object' || patch === null) return { ...base };
  return sanitizeConfig({ ...base, ...(patch as Record<string, unknown>) }, base);
}

export class ConfigStore {
  readonly filePath: string;
  private config: AppConfig;
  private loaded = false;
  private createdOnLoad = false;
  private listeners = new Set<(config: AppConfig) => void>();

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(app.getPath('userData'), 'config.json');
    this.config = { ...DEFAULT_CONFIG };
  }

  /** True when the config file did not exist at load time (first run). */
  get isFirstRun(): boolean {
    return this.createdOnLoad;
  }

  get(): AppConfig {
    return { ...this.config };
  }

  load(): AppConfig {
    if (this.loaded) return this.get();
    this.loaded = true;

    if (!existsSync(this.filePath)) {
      this.createdOnLoad = true;
      this.config = { ...DEFAULT_CONFIG };
      this.persist();
      return this.get();
    }

    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.config = sanitizeConfig(parsed);
    } catch {
      // Preserve a corrupt file for debugging and fall back to defaults.
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // Ignore backup failures; defaults still apply.
      }
      this.config = { ...DEFAULT_CONFIG };
      this.persist();
    }
    return this.get();
  }

  update(patch: unknown): AppConfig {
    this.config = mergeConfig(this.config, patch);
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener(this.get());
      } catch {
        // Ignore listener failures.
      }
    }
    return this.get();
  }

  subscribe(listener: (config: AppConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // Ignore cleanup failures.
      }
      throw error;
    }
  }
}
