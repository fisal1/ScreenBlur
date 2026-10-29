'use strict';

const HAVE_CURRENT_DATA = 2;
const PROBE_WIDTH = 160;
const PROBE_HEIGHT = 90;

function createContext(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingQuality = 'high';
  return context;
}

/**
 * Reads pixels from the screen <video> at the sizes the pipeline needs, and reports each
 * new frame the capture stream delivers together with the time it was captured.
 */
class FrameSampler {
  constructor(video, { inputSize, thumbnailWidth }) {
    this.video = video;
    this.inputSize = inputSize;
    // Same aspect ratio as the model input (and the screen).
    this.thumbnailSize = {
      width: thumbnailWidth,
      height: Math.max(1, Math.round((thumbnailWidth * inputSize.height) / inputSize.width)),
    };
    this.frameContext = createContext(inputSize.width, inputSize.height);
    this.thumbnailContext = createContext(this.thumbnailSize.width, this.thumbnailSize.height);
    this.probeContext = createContext(PROBE_WIDTH, PROBE_HEIGHT);
    this.frameNumber = 0;
    this.frameCapturedAt = Date.now();
    this.frameListener = null;
    this.watchFrames();
  }

  get ready() {
    return this.video.readyState >= HAVE_CURRENT_DATA && this.video.videoWidth > 0;
  }

  /** Calls `listener` whenever the capture stream delivers a new frame. */
  onFrame(listener) {
    this.frameListener = listener;
  }

  watchFrames() {
    const onVideoFrame = (_now, metadata) => {
      this.frameNumber += 1;
      // captureTime is when the screen was captured (performance.now() timebase).
      const capturedAt = metadata.captureTime ?? metadata.presentationTime;
      this.frameCapturedAt = performance.timeOrigin + capturedAt;
      this.frameListener?.();
      this.video.requestVideoFrameCallback(onVideoFrame);
    };
    this.video.requestVideoFrameCallback(onVideoFrame);
  }

  /** Small grayscale image used to detect whether the screen changed. */
  thumbnail() {
    const { width, height } = this.thumbnailSize;
    this.thumbnailContext.drawImage(this.video, 0, 0, width, height);
    const rgba = this.thumbnailContext.getImageData(0, 0, width, height).data;
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }
    return gray;
  }

  /**
   * Model input: screen scaled to fit, anchored top-left, remaining area padded black (matches NudeNet).
   * Returns the pixels plus the size of the screen content inside the padded frame.
   */
  letterboxedFrame() {
    const { width, height } = this.inputSize;
    const { videoWidth, videoHeight } = this.video;
    const scale = Math.min(width / videoWidth, height / videoHeight);
    const contentWidth = Math.round(videoWidth * scale);
    const contentHeight = Math.round(videoHeight * scale);
    const context = this.frameContext;
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    context.drawImage(this.video, 0, 0, contentWidth, contentHeight);
    return { image: context.getImageData(0, 0, width, height), contentWidth, contentHeight };
  }

  /** Fraction of pure magenta pixels; used by the self-test to detect the test window. */
  magentaFraction() {
    if (!this.ready) return 0;
    this.probeContext.drawImage(this.video, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
    const rgba = this.probeContext.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data;
    let magenta = 0;
    for (let p = 0; p < rgba.length; p += 4) {
      if (rgba[p] > 200 && rgba[p + 2] > 200 && rgba[p + 1] < 60) magenta++;
    }
    return magenta / (rgba.length / 4);
  }
}

/**
 * Number of pixels whose brightness differs by more than `delta` (0-255).
 * Pixels where `ignore[i]` is set are skipped.
 */
function countChangedPixels(a, b, delta, ignore = null) {
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (ignore?.[i]) continue;
    if (Math.abs(a[i] - b[i]) > delta) changed++;
  }
  return changed;
}

/** Thumbnail-sized mask with 1 for every pixel inside one of the normalized boxes. */
function maskFromBoxes(boxes, { width, height }) {
  const mask = new Uint8Array(width * height);
  for (const { x, y, width: w, height: h } of boxes) {
    const left = Math.max(0, Math.floor(x * width));
    const top = Math.max(0, Math.floor(y * height));
    const right = Math.min(width, Math.ceil((x + w) * width));
    const bottom = Math.min(height, Math.ceil((y + h) * height));
    for (let row = top; row < bottom; row++) mask.fill(1, row * width + left, row * width + right);
  }
  return mask;
}
