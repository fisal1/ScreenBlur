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

/** Reads pixels from the screen <video> at the sizes the pipeline needs. */
class FrameSampler {
  constructor(video, { inputSize, thumbnailSize }) {
    this.video = video;
    this.inputSize = inputSize;
    this.thumbnailSize = thumbnailSize;
    this.frameContext = createContext(inputSize.width, inputSize.height);
    this.thumbnailContext = createContext(thumbnailSize, thumbnailSize);
    this.probeContext = createContext(PROBE_WIDTH, PROBE_HEIGHT);
  }

  get ready() {
    return this.video.readyState >= HAVE_CURRENT_DATA && this.video.videoWidth > 0;
  }

  /** Tiny grayscale image used to detect scene changes cheaply. */
  thumbnail() {
    const size = this.thumbnailSize;
    this.thumbnailContext.drawImage(this.video, 0, 0, size, size);
    const rgba = this.thumbnailContext.getImageData(0, 0, size, size).data;
    const gray = new Uint8Array(size * size);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }
    return gray;
  }

  /** Model input: frame scaled to fit, anchored top-left, remaining area padded black (matches NudeNet). */
  letterboxedFrame() {
    const { width, height } = this.inputSize;
    const { videoWidth, videoHeight } = this.video;
    const scale = Math.min(width / videoWidth, height / videoHeight);
    const context = this.frameContext;
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    context.drawImage(this.video, 0, 0, videoWidth * scale, videoHeight * scale);
    return context.getImageData(0, 0, width, height);
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

function meanAbsoluteDifference(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}
