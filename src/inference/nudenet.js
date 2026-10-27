// NudeNet v3 detector: input preprocessing and output decoding.
// Output tensor shape is [1, 4 + LABELS.length, anchors]: per anchor a box (cx, cy, w, h in
// input pixels) followed by one confidence per class.
const { iou } = require('../shared/geometry');

const LABELS = Object.freeze([
  'FEMALE_GENITALIA_COVERED', 'FACE_FEMALE', 'BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED', 'MALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'FEET_EXPOSED',
  'BELLY_COVERED', 'FEET_COVERED', 'ARMPITS_COVERED', 'ARMPITS_EXPOSED', 'FACE_MALE',
  'BELLY_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_COVERED', 'FEMALE_BREAST_COVERED',
  'BUTTOCKS_COVERED',
]);

const EXPLICIT_LABELS = Object.freeze([
  'BUTTOCKS_EXPOSED',
  'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED',
  'ANUS_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
]);

// Safe stand-ins used by the --detect-faces test mode.
const FACE_LABELS = Object.freeze(['FACE_FEMALE', 'FACE_MALE']);

const BOX_CHANNELS = 4;

const DEFAULT_DETECTION_OPTIONS = Object.freeze({
  minScore: 0.1, // candidates below this are dropped before NMS
  iouThreshold: 0.45, // NMS overlap above which the weaker box is dropped
  maxDetections: 20,
});

function classIdsFor(labels) {
  return labels.map((label) => {
    const id = LABELS.indexOf(label);
    if (id < 0) throw new Error(`Unknown NudeNet label ${label}`);
    return id;
  });
}

const EXPLICIT_CLASS_IDS = classIdsFor(EXPLICIT_LABELS);

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

function anchorCount(output) {
  const [, channels, anchors] = output.dims;
  if (channels !== BOX_CHANNELS + LABELS.length) {
    throw new Error(`Unexpected NudeNet output shape [${output.dims}]`);
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
function analyze(output, classIds, options = {}) {
  const { minScore, iouThreshold, maxDetections } = { ...DEFAULT_DETECTION_OPTIONS, ...options };
  const anchors = anchorCount(output);
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
      label = LABELS[bestClass];
    }
    if (bestScore >= minScore) {
      candidates.push({ score: bestScore, label: LABELS[bestClass], box: decodeBox(data, anchor, anchors) });
    }
  }

  return { score, label, detections: nonMaxSuppression(candidates, iouThreshold, maxDetections) };
}

/** Highest explicit-class confidence across all anchors. */
function scoreExplicit(output) {
  const { score, label } = analyze(output, EXPLICIT_CLASS_IDS, { minScore: Infinity });
  return { score, label };
}

/** Highest confidence per class, sorted descending (diagnostics). */
function classConfidences(output) {
  const anchors = anchorCount(output);
  return LABELS.map((label, classId) => {
    const offset = (BOX_CHANNELS + classId) * anchors;
    let max = 0;
    for (let anchor = 0; anchor < anchors; anchor++) max = Math.max(max, output.data[offset + anchor]);
    return { label, score: max };
  }).sort((a, b) => b.score - a.score);
}

module.exports = {
  LABELS,
  EXPLICIT_LABELS,
  FACE_LABELS,
  classIdsFor,
  rgbaToNchw,
  analyze,
  scoreExplicit,
  classConfidences,
};
