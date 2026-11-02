// How much area a cover takes around what the model detected (see inference/regions.js).

const COVER_SIZES = Object.freeze({
  // Detected part plus a 20% margin per side.
  normal: Object.freeze({ id: 'normal', name: 'Normal', padding: 0.2, merge: false, bodyContext: false }),
  // 50% margin; covers that touch merge into one, so no content shows between them.
  large: Object.freeze({ id: 'large', name: 'Large', padding: 0.5, merge: true, bodyContext: false }),
  // "Large", plus each cover grows over the body parts detected around it (NudeNet's belly,
  // armpits, covered chest/hips...). Never smaller than "large"; models without such classes
  // behave exactly like it.
  body: Object.freeze({ id: 'body', name: 'Whole body', padding: 0.5, merge: true, bodyContext: true }),
});

const DEFAULT_COVER_SIZE = 'large';

const CONTEXT = Object.freeze({
  minScore: 0.25, // body-part detections used for "Whole body" must be at least this confident
  reach: 0.6, // how far (fraction of the cover's size) to look for surrounding body parts
});

function getCoverSize(id) {
  return COVER_SIZES[id] ?? COVER_SIZES[DEFAULT_COVER_SIZE];
}

/** Options for the inference worker (merged into config.detection). */
function coverageOptions(id) {
  const { padding, merge, bodyContext } = getCoverSize(id);
  return { padding, merge, bodyContext, contextReach: CONTEXT.reach, contextMinScore: CONTEXT.minScore };
}

module.exports = { COVER_SIZES, DEFAULT_COVER_SIZE, getCoverSize, coverageOptions };
