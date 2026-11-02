const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rgbaToNchw, analyze, classConfidences } = require('../src/inference/yolo');
const { MODELS, getModel, targetClassIds, contextClassIds } = require('../src/inference/models');

const MODELS_DIR = path.join(__dirname, '..', 'models');
const nudenet = MODELS['nudenet-320n'];

function fakeOutput(labels, anchors, confidences) {
  const channels = 4 + labels.length;
  const data = new Float32Array(channels * anchors);
  for (const [label, anchor, value] of confidences) data[(4 + labels.indexOf(label)) * anchors + anchor] = value;
  return { dims: [1, channels, anchors], data };
}

function setBox(output, anchor, [cx, cy, w, h]) {
  const anchors = output.dims[2];
  output.data[anchor] = cx;
  output.data[anchors + anchor] = cy;
  output.data[2 * anchors + anchor] = w;
  output.data[3 * anchors + anchor] = h;
}

test('rgbaToNchw splits channels into planes and normalizes', () => {
  const rgba = new Uint8Array([255, 0, 51, 255, 0, 255, 102, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  const out = rgbaToNchw(rgba, 2, 2);
  assert.deepEqual(Array.from(out.slice(0, 4)), [1, 0, 0, 1]);
  assert.deepEqual(Array.from(out.slice(4, 8)), [0, 1, 0, 1]);
  assert.deepEqual(Array.from(out.slice(8, 12)).map((v) => Number(v.toFixed(2))), [0.2, 0.4, 0, 1]);
});

test('analyze returns the highest target confidence and ignores other classes', () => {
  const output = fakeOutput(nudenet.labels, 10, [
    ['FEMALE_BREAST_EXPOSED', 3, 0.42],
    ['MALE_GENITALIA_EXPOSED', 7, 0.61],
    ['FACE_FEMALE', 0, 0.99], // not a target
  ]);
  const { score, label } = analyze(output, nudenet.labels, targetClassIds(nudenet), { minScore: Infinity });
  assert.equal(Number(score.toFixed(2)), 0.61);
  assert.equal(label, 'MALE_GENITALIA_EXPOSED');
});

test('analyze decodes boxes and merges overlapping detections', () => {
  const output = fakeOutput(nudenet.labels, 10, [
    ['FEMALE_BREAST_EXPOSED', 0, 0.8],
    ['FEMALE_BREAST_EXPOSED', 1, 0.6], // overlaps anchor 0 -> suppressed
    ['BUTTOCKS_EXPOSED', 2, 0.5], // separate area
  ]);
  setBox(output, 0, [50, 50, 20, 20]);
  setBox(output, 1, [52, 51, 20, 20]);
  setBox(output, 2, [150, 80, 30, 40]);

  const { detections } = analyze(output, nudenet.labels, targetClassIds(nudenet));
  assert.equal(detections.length, 2);
  assert.deepEqual(detections[0].box, { x: 40, y: 40, width: 20, height: 20 });
  assert.deepEqual(detections[1].box, { x: 135, y: 60, width: 30, height: 40 });
});

test('analyze works with the 5-class EraX layout', () => {
  const erax = MODELS['erax-yolo11n'];
  const output = fakeOutput(erax.labels, 6, [['make_love', 4, 0.7], ['nipple', 1, 0.3]]);
  setBox(output, 4, [100, 100, 200, 150]);
  const { score, label, detections } = analyze(output, erax.labels, targetClassIds(erax), { minScore: 0.5 });
  assert.equal(Number(score.toFixed(2)), 0.7);
  assert.equal(label, 'make_love');
  assert.deepEqual(detections.map((d) => d.label), ['make_love']);
});

test('analyze drops candidates below minScore', () => {
  const output = fakeOutput(nudenet.labels, 10, [['ANUS_EXPOSED', 0, 0.05]]);
  const { score, detections } = analyze(output, nudenet.labels, targetClassIds(nudenet), { minScore: 0.1 });
  assert.ok(score > 0.04);
  assert.equal(detections.length, 0);
});

test('analyze rejects an output that does not match the labels', () => {
  assert.throws(() => analyze({ dims: [1, 10, 5], data: new Float32Array(50) }, nudenet.labels, [0]), /Unexpected model output shape/);
});

test('classConfidences lists every class, highest first', () => {
  const output = fakeOutput(nudenet.labels, 4, [['FACE_MALE', 2, 0.9], ['FEET_EXPOSED', 1, 0.4]]);
  const [first, second] = classConfidences(output, nudenet.labels);
  assert.equal(first.label, 'FACE_MALE');
  assert.equal(second.label, 'FEET_EXPOSED');
});

for (const model of Object.values(MODELS)) {
  const file = path.join(MODELS_DIR, model.file);
  test(`${model.name}: real model has the expected output and scores a blank frame as safe`, { skip: !fs.existsSync(file) && 'model not downloaded' }, async () => {
    const ort = require('onnxruntime-node');
    const [width, height] = [640, 352];
    const session = await ort.InferenceSession.create(file);
    const input = rgbaToNchw(new Uint8Array(width * height * 4).fill(128), width, height);
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width]) });
    const { score } = analyze(outputs[session.outputNames[0]], model.labels, targetClassIds(model));
    assert.ok(score < 0.2, `expected low score, got ${score}`);
    await session.release();
  });
}

test('every model lists its targets and body-part context among its labels', () => {
  for (const model of Object.values(MODELS)) {
    assert.doesNotThrow(() => targetClassIds(model, { includeTestTargets: true }), model.id);
    assert.doesNotThrow(() => contextClassIds(model), model.id);
    assert.ok(model.context.every((label) => !model.targets.includes(label)), `${model.id}: context must not repeat targets`);
  }
});

test('unknown model ids fall back to the default model', () => {
  assert.equal(getModel('does-not-exist').id, 'nudenet-320n');
});
