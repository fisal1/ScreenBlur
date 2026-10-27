const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LABELS, EXPLICIT_LABELS, classIdsFor, rgbaToNchw, scoreExplicit, analyze } = require('../src/inference/nudenet');

const MODEL_PATH = path.join(__dirname, '..', 'models', '320n.onnx');

function fakeOutput(anchors, confidences) {
  const channels = 4 + LABELS.length;
  const data = new Float32Array(channels * anchors);
  for (const [label, anchor, value] of confidences) {
    data[(4 + LABELS.indexOf(label)) * anchors + anchor] = value;
  }
  return { dims: [1, channels, anchors], data };
}

test('rgbaToNchw splits channels into planes and normalizes', () => {
  const rgba = new Uint8Array([255, 0, 51, 255, 0, 255, 102, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  const out = rgbaToNchw(rgba, 2, 2);
  assert.deepEqual(Array.from(out.slice(0, 4)), [1, 0, 0, 1]);
  assert.deepEqual(Array.from(out.slice(4, 8)), [0, 1, 0, 1]);
  assert.deepEqual(Array.from(out.slice(8, 12)).map((v) => Number(v.toFixed(2))), [0.2, 0.4, 0, 1]);
});

test('scoreExplicit returns the highest explicit confidence', () => {
  const output = fakeOutput(10, [
    ['FEMALE_BREAST_EXPOSED', 3, 0.42],
    ['MALE_GENITALIA_EXPOSED', 7, 0.61],
  ]);
  assert.deepEqual(scoreExplicit(output), { score: output.data[(4 + 14) * 10 + 7], label: 'MALE_GENITALIA_EXPOSED' });
});

test('scoreExplicit ignores non-explicit classes', () => {
  const output = fakeOutput(10, [
    ['FACE_FEMALE', 0, 0.99],
    ['FEMALE_BREAST_COVERED', 1, 0.95],
  ]);
  assert.deepEqual(scoreExplicit(output), { score: 0, label: null });
});

function setBox(output, anchor, [cx, cy, w, h]) {
  const anchors = output.dims[2];
  output.data[anchor] = cx;
  output.data[anchors + anchor] = cy;
  output.data[2 * anchors + anchor] = w;
  output.data[3 * anchors + anchor] = h;
}

test('analyze decodes boxes and merges overlapping detections', () => {
  const output = fakeOutput(10, [
    ['FEMALE_BREAST_EXPOSED', 0, 0.8],
    ['FEMALE_BREAST_EXPOSED', 1, 0.6], // overlaps anchor 0 -> suppressed
    ['BUTTOCKS_EXPOSED', 2, 0.5], // separate area
    ['FACE_FEMALE', 3, 0.9], // not a target class
  ]);
  setBox(output, 0, [50, 50, 20, 20]);
  setBox(output, 1, [52, 51, 20, 20]);
  setBox(output, 2, [150, 80, 30, 40]);
  setBox(output, 3, [10, 10, 10, 10]);

  const { score, label, detections } = analyze(output, classIdsFor(EXPLICIT_LABELS));
  assert.equal(Number(score.toFixed(2)), 0.8);
  assert.equal(label, 'FEMALE_BREAST_EXPOSED');
  assert.equal(detections.length, 2);
  assert.deepEqual(detections[0].box, { x: 40, y: 40, width: 20, height: 20 });
  assert.deepEqual(detections[1].box, { x: 135, y: 60, width: 30, height: 40 });
});

test('analyze drops candidates below minScore', () => {
  const output = fakeOutput(10, [['ANUS_EXPOSED', 0, 0.05]]);
  setBox(output, 0, [50, 50, 20, 20]);
  const { score, detections } = analyze(output, classIdsFor(EXPLICIT_LABELS), { minScore: 0.1 });
  assert.ok(score > 0.04);
  assert.equal(detections.length, 0);
});

test('classIdsFor rejects unknown labels', () => {
  assert.throws(() => classIdsFor(['NOT_A_LABEL']), /Unknown NudeNet label/);
});

test('scoreExplicit rejects unexpected output shapes', () => {
  assert.throws(() => scoreExplicit({ dims: [1, 10, 5], data: new Float32Array(50) }), /Unexpected NudeNet output shape/);
});

test('real model scores a blank widescreen frame as safe', { skip: !fs.existsSync(MODEL_PATH) && 'model not downloaded' }, async () => {
  const ort = require('onnxruntime-node');
  const [width, height] = [960, 544];
  const session = await ort.InferenceSession.create(MODEL_PATH);
  const input = rgbaToNchw(new Uint8Array(width * height * 4).fill(128), width, height);
  const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width]) });
  const { score } = scoreExplicit(outputs[session.outputNames[0]]);
  assert.ok(score < 0.2, `expected low score, got ${score}`);
});
