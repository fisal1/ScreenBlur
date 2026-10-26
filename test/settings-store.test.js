const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore } = require('../src/main/settings-store');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenblur-settings-'));
  return path.join(dir, 'settings.json');
}

test('uses defaults when the file does not exist', () => {
  const store = new SettingsStore(tempFile(), { thresholdPercent: 30 });
  assert.equal(store.get('thresholdPercent'), 30);
});

test('persists values across instances', () => {
  const file = tempFile();
  const store = new SettingsStore(file, { thresholdPercent: 30 });
  store.set('thresholdPercent', 42);
  store.flush();
  assert.equal(new SettingsStore(file, { thresholdPercent: 30 }).get('thresholdPercent'), 42);
});

test('falls back to defaults when the file is corrupt', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ not json');
  assert.equal(new SettingsStore(file, { thresholdPercent: 30 }).get('thresholdPercent'), 30);
});

test('debounces writes until the delay passes', async () => {
  const file = tempFile();
  const store = new SettingsStore(file, { thresholdPercent: 30 }, { saveDelayMs: 20 });
  store.set('thresholdPercent', 25);
  assert.equal(fs.existsSync(file), false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).thresholdPercent, 25);
});
