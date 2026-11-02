// Downloads the detection models into models/ and verifies their size and SHA256.
// Uses GitHub API asset URLs: github.com release URLs may redirect to a login page.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MODELS_DIR = path.join(__dirname, '..', 'models');
const ASSET_API = 'https://api.github.com/repos';

const MODELS = Object.freeze([
  {
    file: '320n.onnx', // NudeNet v3.4 (AGPL-3.0)
    url: `${ASSET_API}/notAI-tech/NudeNet/releases/assets/176831997`,
    size: 12150158,
    sha256: 'c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f',
  },
  {
    file: 'erax-yolo11n.onnx', // EraX-Anti-NSFW v1.1 nano, converted by scripts/convert-erax.py
    url: `${ASSET_API}/fisal1/ScreenBlur/releases/assets/702710009`,
    size: 10925206,
    sha256: '2287237fa86a108670b9d4ac368428e994c911d3164dbaf3b8b4be7859627fb0',
  },
  {
    file: 'erax-yolo11s.onnx', // EraX-Anti-NSFW v1.1 small
    url: `${ASSET_API}/fisal1/ScreenBlur/releases/assets/702710988`,
    size: 38252241,
    sha256: 'f2801bcdccdb1281444ed899982bc7355dc51bfd607714df486bf51f97aeb32e',
  },
]);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function verify(model, buffer) {
  if (buffer.length !== model.size) {
    throw new Error(`${model.file}: size mismatch, expected ${model.size} bytes, got ${buffer.length}`);
  }
  const actual = sha256(buffer);
  if (actual !== model.sha256) throw new Error(`${model.file}: checksum mismatch, got ${actual}`);
}

async function download(model) {
  console.log(`Downloading ${model.file}`);
  const headers = { Accept: 'application/octet-stream' };
  // Unauthenticated GitHub API calls are rate-limited per IP; CI runners share IPs.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(model.url, { headers });
  if (!response.ok) throw new Error(`${model.file}: download failed, HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function ensure(model) {
  const target = path.join(MODELS_DIR, model.file);
  if (fs.existsSync(target)) {
    try {
      verify(model, fs.readFileSync(target));
      console.log(`${model.file}: present and verified`);
      return;
    } catch (err) {
      console.warn(`${err.message}; downloading again`);
      fs.unlinkSync(target);
    }
  }
  const buffer = await download(model);
  verify(model, buffer);
  fs.writeFileSync(target, buffer);
  console.log(`${model.file}: ready`);
}

async function main() {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  for (const model of MODELS) await ensure(model);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
