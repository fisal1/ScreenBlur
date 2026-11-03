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
  const inv255 = 1 / 255;
  const gOffset = pixels;
  const bOffset = pixels * 2;
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    out[i] = rgba[p] * inv255;
    out[gOffset + i] = rgba[p + 1] * inv255;
    out[bOffset + i] = rgba[p + 2] * inv255;
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
 * One pass over the anchors for the given classes: the highest confidence anywhere and every
 * anchor at or above minScore (best class per anchor, box decoded).
 */
function scanAnchors(data, anchors, labels, classIds, minScore) {
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
  return { score, label, candidates };
}

/**
 * Decodes the model output for the given target classes.
 * Returns the frame score (highest target confidence anywhere) and de-duplicated
 * detections with boxes in model input pixels.
 * If contextClassIds are given, surrounding body parts are also returned as `context`, but only
 * when a target was detected: most frames contain nothing explicit, and skipping the context
 * scan then halves the decoding time (measured 0.44 ms vs 0.86 ms at 960x544).
 */
function analyze(output, labels, classIds, options = {}, contextClassIds = []) {
  const { minScore, iouThreshold, maxDetections, contextMinScore } = { ...DEFAULT_DETECTION_OPTIONS, ...options };
  const anchors = anchorCount(output, labels);
  const { data } = output;

  const { score, label, candidates } = scanAnchors(data, anchors, labels, classIds, minScore);
  const detections = nonMaxSuppression(candidates, iouThreshold, maxDetections);

  let context = [];
  if (contextClassIds.length > 0 && detections.length > 0) {
    const scan = scanAnchors(data, anchors, labels, contextClassIds, contextMinScore ?? minScore);
    context = nonMaxSuppression(scan.candidates, iouThreshold, maxDetections);
  }
  return { score, label, detections, context };
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
