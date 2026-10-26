// NudeNet v3 detector: input preprocessing and explicit-content scoring.
// Output tensor shape is [1, 4 + LABELS.length, anchors] (box + per-class confidence).

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

const EXPLICIT_CLASS_IDS = EXPLICIT_LABELS.map((label) => LABELS.indexOf(label));
const BOX_CHANNELS = 4;

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

function maxConfidence(output, classId, anchors) {
  const offset = (BOX_CHANNELS + classId) * anchors;
  let max = 0;
  for (let anchor = 0; anchor < anchors; anchor++) {
    max = Math.max(max, output.data[offset + anchor]);
  }
  return max;
}

/** Highest confidence per class, sorted descending (diagnostics). */
function classConfidences(output) {
  const anchors = anchorCount(output);
  return LABELS.map((label, classId) => ({ label, score: maxConfidence(output, classId, anchors) }))
    .sort((a, b) => b.score - a.score);
}

/** Returns the highest explicit-class confidence across all anchors. */
function scoreExplicit(output) {
  const anchors = anchorCount(output);
  let score = 0;
  let label = null;
  for (const classId of EXPLICIT_CLASS_IDS) {
    const confidence = maxConfidence(output, classId, anchors);
    if (confidence > score) {
      score = confidence;
      label = LABELS[classId];
    }
  }
  return { score, label };
}

module.exports = { LABELS, EXPLICIT_LABELS, rgbaToNchw, scoreExplicit, classConfidences };
