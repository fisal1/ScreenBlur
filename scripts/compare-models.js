// Compares the detection models on your own images. Everything stays on this computer.
//
// Usage:
//   electron scripts/compare-models.js <image-or-folder> [options]
//
// Options:
//   --out <folder>      save a side-by-side picture per image (each model's boxes) and summary.csv
//   --threshold <pct>   score at which an image counts as "would blur" (default: 30)
//   --screen <WxH>      simulated screen size (default: 1920x1080)
//   --alone             score each image filling the model input instead of shown on a screen
//   --models <ids>      comma-separated model ids (default: all; see src/inference/models.js)
//   --cover <size>      cover size to draw: normal, large (default) or body (see src/main/cover-size.js)
//
// "Shown on a screen" is what the app sees: the image at its natural size (shrunk to fit) in the
// middle of the screen, the whole screen scaled to the model input. The shaded rectangles in the
// pictures are what the app would cover, computed the same way as in the app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const ort = require('onnxruntime-node');
const config = require('../src/main/config');
const { modelInputSize } = require('../src/main/model-input');
const { MODELS, targetClassIds, contextClassIds } = require('../src/inference/models');
const { rgbaToNchw, analyze } = require('../src/inference/yolo');
const { coverAreas } = require('../src/inference/regions');
const { createFastestSession } = require('../src/inference/backend-selector');
const { COVER_SIZES, coverageOptions } = require('../src/main/cover-size');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const PANEL_HEIGHT = 480;

function parseArgs(argv) {
  const args = argv.slice(2); // [electron, script, ...args]
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const optionValues = new Set(['--out', '--threshold', '--screen', '--models', '--cover'].map(option));
  const input = args.find((arg) => !arg.startsWith('--') && !optionValues.has(arg));
  if (!input) throw new Error('Usage: electron scripts/compare-models.js <image-or-folder> [--out folder] [--threshold 30] [--screen 1920x1080] [--alone] [--models ids] [--cover large]');
  const cover = option('--cover', 'large');
  if (!COVER_SIZES[cover]) throw new Error(`Unknown cover size ${cover}. Known: ${Object.keys(COVER_SIZES).join(', ')}`);
  const [width, height] = option('--screen', '1920x1080').split('x').map(Number);
  const modelIds = option('--models', Object.keys(MODELS).join(',')).split(',');
  const unknown = modelIds.filter((id) => !MODELS[id]);
  if (unknown.length) throw new Error(`Unknown model ids: ${unknown.join(', ')}. Known: ${Object.keys(MODELS).join(', ')}`);
  return {
    input: path.resolve(input),
    out: option('--out') ? path.resolve(option('--out')) : null,
    threshold: Number(option('--threshold', '30')) / 100,
    screen: { width, height },
    alone: args.includes('--alone'),
    models: modelIds.map((id) => MODELS[id]),
    cover,
  };
}

function listImages(input) {
  if (!fs.existsSync(input)) throw new Error(`Not found: ${input}`);
  if (fs.statSync(input).isFile()) return [input];
  return fs.readdirSync(input)
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(input, name));
}

// Pixel work happens in a hidden page so every image format the browser understands works.
const PAGE_HELPERS = `
  window.loadImage = async (url) => { const img = new Image(); img.src = url; await img.decode(); return img; };

  // Returns model input pixels and where the image sits inside them (model pixels).
  window.prepare = async (url, { alone, screen, inputSize }) => {
    const img = await loadImage(url);
    const { width: iw, height: ih } = inputSize;
    let rect;
    if (alone) {
      const s = Math.min(iw / img.naturalWidth, ih / img.naturalHeight);
      rect = { x: 0, y: 0, width: img.naturalWidth * s, height: img.naturalHeight * s };
    } else {
      const fit = Math.min(1, screen.width / img.naturalWidth, screen.height / img.naturalHeight);
      const shown = { width: img.naturalWidth * fit, height: img.naturalHeight * fit };
      const s = Math.min(iw / screen.width, ih / screen.height); // screen -> model input
      rect = { x: ((screen.width - shown.width) / 2) * s, y: ((screen.height - shown.height) / 2) * s, width: shown.width * s, height: shown.height * s };
    }
    const canvas = document.createElement('canvas');
    canvas.width = iw; canvas.height = ih;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, iw, ih);
    ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height);
    // executeJavaScript can't return typed arrays, so pixels travel as base64.
    const bytes = ctx.getImageData(0, 0, iw, ih).data;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { rgbaBase64: btoa(binary), rect, imageSize: { width: img.naturalWidth, height: img.naturalHeight } };
  };

  // Side-by-side panels of the image, one per model, with that model's boxes drawn on top.
  window.annotate = async (url, panels, panelHeight) => {
    const img = await loadImage(url);
    const scale = panelHeight / img.naturalHeight;
    const pw = Math.round(img.naturalWidth * scale), header = 34;
    const canvas = document.createElement('canvas');
    canvas.width = pw * panels.length; canvas.height = panelHeight + header;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#14202e'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    panels.forEach((panel, i) => {
      const x0 = i * pw;
      ctx.drawImage(img, x0, header, pw, panelHeight);
      for (const cover of panel.covers) { // what the app would cover
        const cx = x0 + cover.x * scale, cy = header + cover.y * scale, cw = cover.width * scale, ch = cover.height * scale;
        ctx.fillStyle = 'rgba(79, 195, 247, 0.55)';
        ctx.fillRect(cx, cy, cw, ch);
        ctx.setLineDash([8, 5]); ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2;
        ctx.strokeRect(cx, cy, cw, ch);
        ctx.setLineDash([]);
      }
      ctx.fillStyle = panel.wouldBlur ? '#e74c3c' : '#2ecc71';
      ctx.font = 'bold 15px Segoe UI, sans-serif';
      ctx.fillText(panel.title, x0 + 8, 22);
      for (const box of panel.boxes) {
        const bx = x0 + box.x * scale, by = header + box.y * scale, bw = box.width * scale, bh = box.height * scale;
        ctx.strokeStyle = box.counts ? '#ff3b6b' : '#f5c542';
        ctx.lineWidth = 3;
        ctx.strokeRect(bx, by, bw, bh);
        const text = box.label + ' ' + Math.round(box.score * 100) + '%';
        ctx.font = '12px Segoe UI, sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(bx, Math.max(header, by - 16), ctx.measureText(text).width + 8, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, bx + 4, Math.max(header, by - 16) + 12);
      }
      ctx.fillStyle = '#2f4560'; ctx.fillRect(x0 + pw - 1, 0, 1, canvas.height);
    });
    return canvas.toDataURL('image/png').split(',')[1];
  };
`;

async function loadModel(model) {
  const file = path.join(config.paths.modelsDir, model.file);
  if (!fs.existsSync(file)) throw new Error(`${model.name}: ${file} is missing; run "node scripts/fetch-model.js"`);
  const probeSize = { width: 960, height: 544 };
  const { session, label } = await createFastestSession(ort, file, probeSize, config.inference.backends, 3);
  return { model, session, backend: label, classIds: targetClassIds(model), contextIds: contextClassIds(model) };
}

/**
 * What the app would cover in this frame: nothing unless some detection reaches the threshold;
 * then every detection above half of it ("cover nearby parts"), sized by the cover size.
 */
function coversFor(detections, context, bounds, threshold, coverage) {
  if (!detections.some((d) => d.score >= threshold)) return [];
  return coverAreas(detections.filter((d) => d.score >= threshold / 2), context, bounds, coverage);
}

async function runModel({ model, session, classIds, contextIds }, prepared, inputSize, { threshold, cover }) {
  const { width, height } = inputSize;
  const tensor = new ort.Tensor('float32', rgbaToNchw(prepared.rgba, width, height), [1, 3, height, width]);
  const started = performance.now();
  const outputs = await session.run({ [session.inputNames[0]]: tensor });
  const ms = performance.now() - started;
  const output = outputs[session.outputNames[0]];
  const coverage = coverageOptions(cover);
  const { score, label, detections } = analyze(output, model.labels, classIds, config.detection);
  const context = coverage.bodyContext && contextIds.length
    ? analyze(output, model.labels, contextIds, { ...config.detection, minScore: coverage.contextMinScore }).detections
    : [];

  // Model pixels -> image pixels; keep only boxes that overlap the image.
  const { rect, imageSize } = prepared;
  const sx = imageSize.width / rect.width;
  const sy = imageSize.height / rect.height;
  const toImage = (box) => ({ x: (box.x - rect.x) * sx, y: (box.y - rect.y) * sy, width: box.width * sx, height: box.height * sy });
  const onImage = (b) => b.x < imageSize.width && b.y < imageSize.height && b.x + b.width > 0 && b.y + b.height > 0;
  const boxes = detections.map((d) => ({ label: d.label, score: d.score, ...toImage(d.box) })).filter(onImage);
  const covers = coversFor(detections, context, rect, threshold, coverage).map((c) => toImage(c.box)).filter(onImage);
  return { score, label, boxes, covers, ms };
}

function percent(value) {
  return `${Math.round(value * 100)}%`.padStart(4);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function csvRow(values) {
  return values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
}

async function main() {
  const options = parseArgs(process.argv);
  const images = listImages(options.input);
  if (!images.length) throw new Error(`No images found in ${options.input}`);
  if (options.out) fs.mkdirSync(options.out, { recursive: true });

  console.log(`Loading ${options.models.length} models...`);
  const loaded = [];
  for (const model of options.models) {
    const entry = await loadModel(model);
    console.log(`  ${model.name} on ${entry.backend}`);
    loaded.push(entry);
  }

  // A file:// page, because about:blank may not load local images.
  const pagePath = path.join(app.getPath('userData'), 'compare.html');
  fs.writeFileSync(pagePath, '<!doctype html><meta charset="utf-8"><title>compare</title>');
  const page = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await page.loadFile(pagePath);
  await page.webContents.executeJavaScript(`${PAGE_HELPERS}; true`); // the last value is returned; functions can't be

  const mode = options.alone ? 'image alone' : `shown on a ${options.screen.width}x${options.screen.height} screen`;
  console.log(`\nScoring ${images.length} image(s), ${mode}; "would blur" at ${percent(options.threshold).trim()}; cover size ${COVER_SIZES[options.cover].name}\n`);
  const stats = new Map(loaded.map(({ model }) => [model.id, { blurred: 0, scores: [], ms: [] }]));
  const csv = [csvRow(['image', ...loaded.flatMap(({ model }) => [`${model.id} score`, `${model.id} areas`, `${model.id} ms`])])];

  for (const imagePath of images) {
    const url = pathToFileURL(imagePath).href;
    const probe = await page.webContents.executeJavaScript(`loadImage(${JSON.stringify(url)}).then((i) => ({ width: i.naturalWidth, height: i.naturalHeight }))`);
    const inputSize = modelInputSize(options.alone ? probe : options.screen, config.modelInput);
    const { rgbaBase64, ...placement } = await page.webContents.executeJavaScript(`prepare(${JSON.stringify(url)}, ${JSON.stringify({ alone: options.alone, screen: options.screen, inputSize })})`);
    const prepared = { ...placement, rgba: new Uint8Array(Buffer.from(rgbaBase64, 'base64')) };

    console.log(path.basename(imagePath));
    const panels = [];
    const row = [path.basename(imagePath)];
    for (const entry of loaded) {
      const result = await runModel(entry, prepared, inputSize, options);
      const wouldBlur = result.score >= options.threshold;
      const counted = result.boxes.filter((b) => b.score >= options.threshold);
      const stat = stats.get(entry.model.id);
      stat.scores.push(result.score);
      stat.ms.push(result.ms);
      if (wouldBlur) stat.blurred++;
      console.log(`  ${entry.model.name.padEnd(13)} ${percent(result.score)} ${wouldBlur ? 'BLUR' : '    '}  ${counted.length} area(s)  ${result.label ?? '-'}  ${result.ms.toFixed(0)} ms`);
      panels.push({
        title: `${entry.model.name}: ${percent(result.score).trim()}${wouldBlur ? ' (blur)' : ''}`,
        wouldBlur,
        boxes: result.boxes.map((b) => ({ ...b, counts: b.score >= options.threshold })),
        covers: result.covers,
      });
      row.push(result.score.toFixed(3), counted.length, result.ms.toFixed(1));
    }
    csv.push(csvRow(row));

    if (options.out) {
      const base64 = await page.webContents.executeJavaScript(`annotate(${JSON.stringify(url)}, ${JSON.stringify(panels)}, ${PANEL_HEIGHT})`);
      fs.writeFileSync(path.join(options.out, `${path.parse(imagePath).name}.compare.png`), Buffer.from(base64, 'base64'));
    }
  }

  console.log(`\nSummary (${images.length} images, would blur at ${percent(options.threshold).trim()}):`);
  for (const { model } of loaded) {
    const stat = stats.get(model.id);
    const mean = stat.scores.reduce((a, b) => a + b, 0) / stat.scores.length;
    console.log(`  ${model.name.padEnd(13)} would blur ${String(stat.blurred).padStart(3)}/${images.length}   mean score ${percent(mean)}   median ${median(stat.ms).toFixed(0)} ms`);
  }
  if (options.out) {
    fs.writeFileSync(path.join(options.out, 'summary.csv'), csv.join('\n') + '\n');
    console.log(`\nPictures and summary.csv saved to ${options.out}`);
    console.log('Shaded blue = what the app would cover. Red boxes reach the threshold; yellow boxes are below it.');
  }
}

app.setPath('userData', path.join(os.tmpdir(), 'screenblur-compare-models'));
app.whenReady()
  .then(main)
  .catch((err) => {
    console.error(err?.message ?? String(err));
    process.exitCode = 1;
  })
  .finally(() => app.quit());
