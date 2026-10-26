const fs = require('node:fs');
const path = require('node:path');

/**
 * Small JSON settings file. Reads once on creation; writes are debounced so dragging
 * a slider doesn't hit the disk on every step.
 */
class SettingsStore {
  constructor(filePath, defaults, { saveDelayMs = 300 } = {}) {
    this.filePath = filePath;
    this.saveDelayMs = saveDelayMs;
    this.saveTimer = null;
    this.values = { ...defaults, ...this.read() };
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
  }

  /** Writes pending changes now (call before quitting). */
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.values, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {}; // missing or corrupt file: fall back to defaults
    }
  }
}

module.exports = { SettingsStore };
