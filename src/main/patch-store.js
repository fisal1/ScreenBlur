const fs = require('node:fs');
const path = require('node:path');

// What covers detected areas: the bundled GIF, the user's own image, or a blur.

const PATCH_STYLES = Object.freeze({
  default: Object.freeze({ id: 'default', name: 'Default GIF' }),
  custom: Object.freeze({ id: 'custom', name: 'My GIF / image' }),
  blur: Object.freeze({ id: 'blur', name: 'Blur' }),
});

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_FILE_EXTENSIONS = Object.freeze(['gif', 'png', 'jpg', 'jpeg', 'webp']);

/** Image type from the file's first bytes, or null. Extensions alone can't be trusted. */
function detectImageType(bytes) {
  const ascii = (start, end) => bytes.subarray(start, end).toString('latin1');
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Throws an error with a message fit for the user if `filePath` isn't a usable image. */
function validateImage(filePath) {
  const { size } = fs.statSync(filePath);
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`The image is ${(size / 1048576).toFixed(0)} MB; please choose one under ${MAX_IMAGE_BYTES / 1048576} MB.`);
  }
  const header = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const type = detectImageType(header);
  if (!type) throw new Error('That file is not a GIF, PNG, JPG or WebP image.');
  return type;
}

/**
 * Persists the cover style in the settings and keeps a private copy of the user's image in
 * `customDir`, so moving or deleting the original doesn't break ScreenBlur.
 */
class PatchStore {
  /** @param settings SettingsStore; keys: patchStyle, patchCustomFile, patchCustomName */
  constructor({ settings, customDir, defaultImagePath }) {
    this.settings = settings;
    this.customDir = customDir;
    this.defaultImagePath = defaultImagePath;
  }

  get style() {
    const style = this.settings.get('patchStyle');
    return PATCH_STYLES[style] ? style : PATCH_STYLES.default.id;
  }

  get customPath() {
    const file = this.settings.get('patchCustomFile');
    return file ? path.join(this.customDir, file) : null;
  }

  hasCustomImage() {
    return Boolean(this.customPath) && fs.existsSync(this.customPath);
  }

  /** Absolute path of the image that covers areas, or null to draw a blur. */
  imagePath() {
    if (this.style === PATCH_STYLES.blur.id) return null;
    if (this.style === PATCH_STYLES.custom.id && this.hasCustomImage()) return this.customPath;
    return fs.existsSync(this.defaultImagePath) ? this.defaultImagePath : null;
  }

  /** @returns false when "custom" is chosen but no image has been imported yet */
  setStyle(style) {
    if (!PATCH_STYLES[style]) throw new Error(`Unknown cover style ${style}`);
    if (style === PATCH_STYLES.custom.id && !this.hasCustomImage()) return false;
    this.settings.set('patchStyle', style);
    return true;
  }

  /** Validates and copies the image, then makes it the active cover. */
  importImage(sourcePath) {
    const type = validateImage(sourcePath);
    fs.mkdirSync(this.customDir, { recursive: true });
    // A new name each time, so windows that cached the previous image show the new one.
    const fileName = `custom-${Date.now()}.${type}`;
    fs.copyFileSync(sourcePath, path.join(this.customDir, fileName));
    const previous = this.customPath;
    this.settings.set('patchCustomFile', fileName);
    this.settings.set('patchCustomName', path.basename(sourcePath));
    this.settings.set('patchStyle', PATCH_STYLES.custom.id);
    if (previous && previous !== this.customPath) fs.rmSync(previous, { force: true });
    return this.customPath;
  }

  describe() {
    return {
      style: this.style,
      styles: Object.values(PATCH_STYLES),
      imagePath: this.imagePath(),
      customName: this.hasCustomImage() ? this.settings.get('patchCustomName') : null,
    };
  }
}

module.exports = { PatchStore, PATCH_STYLES, IMAGE_FILE_EXTENSIONS, MAX_IMAGE_BYTES, detectImageType, validateImage };
