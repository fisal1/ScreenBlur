const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PatchStore, detectImageType, validateImage } = require('../src/main/patch-store');

// 1x1 transparent GIF and PNG.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function memorySettings() {
  const values = {};
  return { get: (key) => values[key], set: (key, value) => { values[key] = value; }, values };
}

function setup({ withDefault = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenblur-patch-'));
  const defaultImagePath = path.join(dir, 'default.gif');
  if (withDefault) fs.writeFileSync(defaultImagePath, GIF);
  const settings = memorySettings();
  const store = new PatchStore({ settings, customDir: path.join(dir, 'patches'), defaultImagePath });
  const write = (name, bytes) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
  return { store, settings, defaultImagePath, write };
}

test('detects image types from their first bytes', () => {
  assert.equal(detectImageType(GIF), 'gif');
  assert.equal(detectImageType(PNG), 'png');
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
  assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WEBP', 'latin1')), 'webp');
  assert.equal(detectImageType(Buffer.from('not an image')), null);
});

test('rejects files that are not images, whatever their name', () => {
  const { write } = setup();
  assert.throws(() => validateImage(write('fake.gif', Buffer.from('hello world, not a gif'))), /not a GIF, PNG, JPG or WebP/);
});

test('uses the bundled GIF by default and a blur when it is missing', () => {
  const { store, defaultImagePath } = setup();
  assert.equal(store.imagePath(), defaultImagePath);
  assert.equal(setup({ withDefault: false }).store.imagePath(), null);
});

test('importing an image copies it and makes it the cover', () => {
  const { store, settings, write } = setup();
  const source = write('My Cat.png', PNG);
  const copy = store.importImage(source);
  assert.notEqual(copy, source);
  assert.ok(copy.endsWith('.png'));
  assert.deepEqual(fs.readFileSync(copy), PNG);
  assert.equal(store.style, 'custom');
  assert.equal(store.imagePath(), copy);
  assert.equal(settings.values.patchCustomName, 'My Cat.png');
  fs.rmSync(source);
  assert.equal(store.imagePath(), copy, 'still works after the original is deleted');
});

test('importing a new image replaces the previous copy', async () => {
  const { store, write } = setup();
  const first = store.importImage(write('a.gif', GIF));
  await new Promise((resolve) => setTimeout(resolve, 5)); // distinct timestamp-based name
  const second = store.importImage(write('b.png', PNG));
  assert.equal(fs.existsSync(first), false);
  assert.equal(store.imagePath(), second);
});

test('custom style cannot be chosen before an image is imported', () => {
  const { store, defaultImagePath } = setup();
  assert.equal(store.setStyle('custom'), false);
  assert.equal(store.style, 'default');
  assert.equal(store.imagePath(), defaultImagePath);
});

test('blur style draws no image; switching back keeps the imported image', () => {
  const { store, write } = setup();
  const copy = store.importImage(write('a.gif', GIF));
  assert.equal(store.setStyle('blur'), true);
  assert.equal(store.imagePath(), null);
  assert.equal(store.setStyle('custom'), true);
  assert.equal(store.imagePath(), copy);
});

test('a missing custom copy falls back to the default GIF', () => {
  const { store, write, defaultImagePath } = setup();
  fs.rmSync(store.importImage(write('a.gif', GIF)));
  assert.equal(store.imagePath(), defaultImagePath);
  assert.equal(store.describe().customName, null);
});

test('unknown styles are rejected', () => {
  assert.throws(() => setup().store.setStyle('sparkles'), /Unknown cover style/);
});
