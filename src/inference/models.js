// Detection models ScreenBlur can use. All are YOLO detectors with output
// [1, 4 + labels.length, anchors] and accept any input size that is a multiple of 32.

const NUDENET_LABELS = Object.freeze([
  'FEMALE_GENITALIA_COVERED', 'FACE_FEMALE', 'BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED', 'MALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'FEET_EXPOSED',
  'BELLY_COVERED', 'FEET_COVERED', 'ARMPITS_COVERED', 'ARMPITS_EXPOSED', 'FACE_MALE',
  'BELLY_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_COVERED', 'FEMALE_BREAST_COVERED',
  'BUTTOCKS_COVERED',
]);

const ERAX_LABELS = Object.freeze(['anus', 'make_love', 'nipple', 'penis', 'vagina']);

const MODELS = Object.freeze({
  'nudenet-320n': Object.freeze({
    id: 'nudenet-320n',
    name: 'NudeNet 320n',
    description: 'Exposed body parts (18 classes, 5 blurred). Tested the most.',
    file: '320n.onnx',
    labels: NUDENET_LABELS,
    targets: Object.freeze(['BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'ANUS_EXPOSED', 'MALE_GENITALIA_EXPOSED']),
    testTargets: Object.freeze(['FACE_FEMALE', 'FACE_MALE']), // --detect-faces
    // Body parts around explicit areas, used by the "Whole body" cover size. Faces and feet are
    // left out: covering faces isn't wanted, and feet are too far from the explicit areas.
    context: Object.freeze([
      'FEMALE_BREAST_COVERED', 'FEMALE_GENITALIA_COVERED', 'BUTTOCKS_COVERED', 'ANUS_COVERED',
      'MALE_BREAST_EXPOSED', 'BELLY_EXPOSED', 'BELLY_COVERED', 'ARMPITS_EXPOSED', 'ARMPITS_COVERED',
    ]),
    license: 'AGPL-3.0',
  }),
  'erax-yolo11n': Object.freeze({
    id: 'erax-yolo11n',
    name: 'EraX nano',
    description: 'YOLO11, also detects sexual activity as a whole. Fastest.',
    file: 'erax-yolo11n.onnx',
    labels: ERAX_LABELS,
    targets: ERAX_LABELS,
    testTargets: Object.freeze([]),
    context: Object.freeze([]), // no body-part classes; "Whole body" acts like "Large"
    license: 'Apache-2.0 (EraX), trained with Ultralytics (AGPL-3.0)',
  }),
  'erax-yolo11s': Object.freeze({
    id: 'erax-yolo11s',
    name: 'EraX small',
    description: 'YOLO11, also detects sexual activity as a whole. More accurate, needs a GPU for full speed.',
    file: 'erax-yolo11s.onnx',
    labels: ERAX_LABELS,
    targets: ERAX_LABELS,
    testTargets: Object.freeze([]),
    context: Object.freeze([]), // no body-part classes; "Whole body" acts like "Large"
    license: 'Apache-2.0 (EraX), trained with Ultralytics (AGPL-3.0)',
  }),
});

const DEFAULT_MODEL_ID = 'nudenet-320n';

function getModel(id) {
  return MODELS[id] ?? MODELS[DEFAULT_MODEL_ID];
}

function classIds(model, labels) {
  return labels.map((label) => {
    const id = model.labels.indexOf(label);
    if (id < 0) throw new Error(`${model.id} has no class ${label}`);
    return id;
  });
}

/** Indices of the classes to blur; test targets are added for --detect-faces. */
function targetClassIds(model, { includeTestTargets = false } = {}) {
  return classIds(model, includeTestTargets ? [...model.targets, ...model.testTargets] : model.targets);
}

/** Indices of the surrounding body-part classes used by the "Whole body" cover size. */
function contextClassIds(model) {
  return classIds(model, model.context);
}

module.exports = { MODELS, DEFAULT_MODEL_ID, getModel, targetClassIds, contextClassIds };
