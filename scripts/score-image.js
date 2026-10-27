// Diagnostic: scores an image file with the model, the same way the app scores the screen.
// Usage: electron scripts/score-image.js <image> [--screen WIDTHxHEIGHT]
//
// Prints the top class confidences for:
//   - the image on its own, scaled to the model input
//   - the image as it would appear on a screen of the given size (default 1920x1080),
//     which shows how much detail is lost when the whole screen is scaled down
const path = require('node:path');
const { app, nativeImage } = require('electron');
const ort = require('onnxruntime-node');
const config = require('../src/main/config');
const { modelInputSize } = require('../src/main/model-input');
const { EXPLICIT_LABELS, classIdsFor, rgbaToNchw, analyze, classConfidences } = require('../src/inference/nudenet');

const TOP_CLASSES = 5;

function parseArgs(argv) {
  const args = argv.slice(2); // [electron, script, ...args]
  const imagePath = args.find((arg) => !arg.startsWith('--') && !/^\d+x\d+$/.test(arg));
  const screenArg = args[args.indexOf('--screen') + 1];
  const [width, height] = (args.includes('--screen') ? screenArg : '1920x1080').split('x').map(Number);
  if (!imagePath) throw new Error('Usage: electron scripts/score-image.js <image> [--screen 1920x1080]');
  return { imagePath: path.resolve(imagePath), screen: { width, height } };
}

/** Draws an image into a width x height RGBA buffer, scaled to fit, top-left, black padding. */
function letterbox(image, { width, height }) {
  const source = image.getSize();
  const scale = Math.min(width / source.width, height / source.height);
  const scaledWidth = Math.max(1, Math.round(source.width * scale));
  const scaledHeight = Math.max(1, Math.round(source.height * scale));
  const bgra = image.resize({ width: scaledWidth, height: scaledHeight, quality: 'best' }).toBitmap();

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < scaledHeight; y++) {
    for (let x = 0; x < scaledWidth; x++) {
      const src = (y * scaledWidth + x) * 4;
      const dst = (y * width + x) * 4;
      rgba[dst] = bgra[src + 2];
      rgba[dst + 1] = bgra[src + 1];
      rgba[dst + 2] = bgra[src];
      rgba[dst + 3] = 255;
    }
  }
  return rgba;
}

/** Simulates the image shown at its natural size (or fitted) in the middle of a black screen. */
function placeOnScreen(image, screen) {
  const { width, height } = image.getSize();
  const fit = Math.min(1, screen.width / width, screen.height / height);
  const shown = image.resize({ width: Math.round(width * fit), height: Math.round(height * fit), quality: 'best' });
  const { width: shownWidth, height: shownHeight } = shown.getSize();
  const imageBgra = shown.toBitmap();

  const screenBgra = Buffer.alloc(screen.width * screen.height * 4);
  const left = Math.floor((screen.width - shownWidth) / 2);
  const top = Math.floor((screen.height - shownHeight) / 2);
  for (let y = 0; y < shownHeight; y++) {
    imageBgra.copy(screenBgra, ((top + y) * screen.width + left) * 4, y * shownWidth * 4, (y + 1) * shownWidth * 4);
  }
  return { image: nativeImage.createFromBitmap(screenBgra, screen), shownWidth, shownHeight };
}

async function score(session, image, inputSize) {
  const { width, height } = inputSize;
  const input = new ort.Tensor('float32', rgbaToNchw(letterbox(image, inputSize), width, height), [1, 3, height, width]);
  const output = (await session.run({ [session.inputNames[0]]: input }))[session.outputNames[0]];
  const explicit = analyze(output, classIdsFor(EXPLICIT_LABELS), config.detection);
  return { explicit, top: classConfidences(output).slice(0, TOP_CLASSES) };
}

function printResult(title, { explicit, top }) {
  console.log(`\n${title}`);
  console.log(`  explicit score: ${explicit.score.toFixed(3)} (${explicit.label ?? '-'})`);
  console.log(`  explicit areas found: ${explicit.detections.length}`);
  for (const { score: value, label, box } of explicit.detections) {
    console.log(`    ${value.toFixed(3)}  ${label} at ${Math.round(box.x)},${Math.round(box.y)} size ${Math.round(box.width)}x${Math.round(box.height)} (model pixels)`);
  }
  console.log('  top classes:');
  for (const { label, score: value } of top) console.log(`    ${value.toFixed(3)}  ${label}`);
}

async function main() {
  const { imagePath, screen } = parseArgs(process.argv);
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error(`Could not read image: ${imagePath}`);

  const session = await ort.InferenceSession.create(config.paths.model);
  const { width, height } = image.getSize();
  console.log(`Image: ${path.basename(imagePath)} (${width}x${height})`);

  const imageInput = modelInputSize(image.getSize(), config.modelInput);
  printResult(`Image alone (model input ${imageInput.width}x${imageInput.height}):`, await score(session, image, imageInput));

  const onScreen = placeOnScreen(image, screen);
  const screenInput = modelInputSize(screen, config.modelInput);
  printResult(
    `Image shown at ${onScreen.shownWidth}x${onScreen.shownHeight} on a ${screen.width}x${screen.height} screen, ` +
      `model input ${screenInput.width}x${screenInput.height} (what the app sees):`,
    await score(session, onScreen.image, screenInput),
  );
}

app.whenReady()
  .then(main)
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
