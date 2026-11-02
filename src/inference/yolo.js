// YOLO detector input preprocessing and output decoding (NudeNet and EraX share the format).
// Output tensor shape is [1, 4 + labels.length, anchors]: per anchor a box (cx, cy, w, h in
// input pixels) followed by one confidence per class.
const { iou } = require('../shared/geometry');

const BOX_CHANNELS = 4;

const DEFAULT_DETECTION_OPTIONS = Object.freeze({
  minScore: 0.1, // candidates below this are dropped before NMS
  iouThreshold: 0.45, // NMS overlap above which the weaker box is dropped
  maxDetections: 20,
});

/** Converts RGBA pixels into a normalized NCHW float tensor buffer. */
function rgbaToNchw(rgba, width, height, out = new Float32Array(3 * width * height)) {
  const pixels = width * height;
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    out[i] = rgba[p] / 255;
    out[pixels + i] = rgba[p + 1] / 255;
    out[2 * pixels + i] = rgba[p + 2] / 255;
  }
  return out;
}

function anchorCount(output, labels) {
  const [, channels, anchors] = output.dims;
  if (channels !== BOX_CHANNELS + labels.length) {
    throw new Error(`Unexpected model output shape [${output.dims}] for ${labels.length} classes`);
  }
  return anchors;
}

function decodeBox(data, anchor, anchors) {
  const cx = data[anchor];
  const cy = data[anchors + anchor];
  const width = data[2 * anchors + anchor];
  const height = data[3 * anchors + anchor];
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** Greedy class-agnostic non-maximum suppression: we only care where content is, not which part. */
function nonMaxSuppression(candidates, iouThreshold, maxDetections) {
  const kept = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (kept.length >= maxDetections) break;
    if (kept.every((other) => iou(candidate.box, other.box) < iouThreshold)) kept.push(candidate);
  }
  return kept;
}

/**
 * Decodes the model output for the given target classes.
 * Returns the frame score (highest target confidence anywhere) and de-duplicated
 * detections with boxes in model input pixels.
 */
function analyze(output, labels, classIds, options = {}) {
  const { minScore, iouThreshold, maxDetections } = { ...DEFAULT_DETECTION_OPTIONS, ...options };
  const anchors = anchorCount(output, labels);
  const { data } = output;

  let score = 0;
  let label = null;
  const candidates = [];
  for (let anchor = 0; anchor < anchors; anchor++) {
    let bestScore = 0;
    let bestClass = -1;
    for (const classId of classIds) {
      const confidence = data[(BOX_CHANNELS + classId) * anchors + anchor];
      if (confidence > bestScore) {
        bestScore = confidence;
        bestClass = classId;
      }
    }
    if (bestScore > score) {
      score = bestScore;
      label = labels[bestClass];
    }
    if (bestScore >= minScore) {
      candidates.push({ score: bestScore, label: labels[bestClass], box: decodeBox(data, anchor, anchors) });
    }
  }

  return { score, label, detections: nonMaxSuppression(candidates, iouThreshold, maxDetections) };
}

/** Highest confidence per class, sorted descending (diagnostics). */
function classConfidences(output, labels) {
  const anchors = anchorCount(output, labels);
  return labels.map((label, classId) => {
    const offset = (BOX_CHANNELS + classId) * anchors;
    let max = 0;
    for (let anchor = 0; anchor < anchors; anchor++) max = Math.max(max, output.data[offset + anchor]);
    return { label, score: max };
  }).sort((a, b) => b.score - a.score);
}

module.exports = { rgbaToNchw, analyze, classConfidences };
