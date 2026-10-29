// Downloads the NudeNet 320n ONNX detector into models/ and verifies its size and SHA256.
// Uses the GitHub API asset endpoint: the github.com release URL may redirect to a login page.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MODEL = Object.freeze({
  url: 'https://api.github.com/repos/notAI-tech/NudeNet/releases/assets/176831997',
  size: 12150158,
  sha256: process.env.SCREENBLUR_MODEL_SHA256 || 'c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f',
  path: path.join(__dirname, '..', 'models', '320n.onnx'),
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function verify(buffer) {
  if (buffer.length !== MODEL.size) {
    throw new Error(`Model size mismatch: expected ${MODEL.size} bytes, got ${buffer.length}`);
  }
  const actual = sha256(buffer);
  if (MODEL.sha256 && actual !== MODEL.sha256) {
    throw new Error(`Model checksum mismatch: expected ${MODEL.sha256}, got ${actual}`);
  }
  return actual;
}

async function download() {
  console.log(`Downloading NudeNet 320n model from ${MODEL.url}`);
  const headers = { Accept: 'application/octet-stream' };
  // Unauthenticated GitHub API calls are rate-limited per IP; CI runners share IPs.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(MODEL.url, { headers });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  fs.mkdirSync(path.dirname(MODEL.path), { recursive: true });

  if (fs.existsSync(MODEL.path)) {
    try {
      verify(fs.readFileSync(MODEL.path));
      console.log('Model already present and verified');
      return;
    } catch (err) {
      console.warn(`${err.message}; downloading again`);
      fs.unlinkSync(MODEL.path);
    }
  }

  const buffer = await download();
  const hash = verify(buffer);
  fs.writeFileSync(MODEL.path, buffer);
  console.log(`Model ready (sha256 ${hash})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
