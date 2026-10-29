// electron-builder afterPack hook: onnxruntime-node ships native binaries for every OS and CPU
// (~250 MB). Keep only the ones for the platform and architecture being packaged.
const fs = require('node:fs');
const path = require('node:path');

// electron-builder's Arch enum: 0 ia32, 1 x64, 2 armv7l, 3 arm64, 4 universal
const ARCH_NAMES = { 1: 'x64', 3: 'arm64' };

function resourcesDir(appOutDir, platform, productFilename) {
  return platform === 'darwin'
    ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH_NAMES[context.arch];
  const binDir = path.join(
    resourcesDir(context.appOutDir, platform, context.packager.appInfo.productFilename),
    'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6',
  );
  if (!fs.existsSync(binDir)) throw new Error(`onnxruntime binaries not found at ${binDir}`);

  for (const os of fs.readdirSync(binDir)) {
    for (const cpu of fs.readdirSync(path.join(binDir, os))) {
      if (os === platform && cpu === arch) continue;
      fs.rmSync(path.join(binDir, os, cpu), { recursive: true, force: true });
    }
    if (fs.readdirSync(path.join(binDir, os)).length === 0) fs.rmSync(path.join(binDir, os), { recursive: true });
  }

  const kept = path.join(binDir, platform, arch);
  if (!fs.existsSync(kept)) throw new Error(`No onnxruntime binaries for ${platform}/${arch}`);
  console.log(`  • kept onnxruntime binaries for ${platform}/${arch} only`);
};
