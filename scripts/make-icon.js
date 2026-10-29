// Draws the app icon (build/icon.png, 1024x1024). electron-builder derives the Windows .ico,
// macOS .icns and Linux icons from it.
// Usage: electron scripts/make-icon.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SIZE = 1024;
const OUTPUT = path.join(__dirname, '..', 'build', 'icon.png');

// A rounded tile in the overlay's colors with a frosted patch partly covering a shape.
const DRAW = `(() => {
  const size = ${SIZE};
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const tile = (inset, radius) => {
    ctx.beginPath();
    ctx.roundRect(inset, inset, size - 2 * inset, size - 2 * inset, radius);
  };

  const background = ctx.createLinearGradient(0, 0, size, size);
  background.addColorStop(0, '#1d2b64');
  background.addColorStop(1, '#1f6e7f');
  tile(40, 220);
  ctx.fillStyle = background;
  ctx.fill();

  ctx.save();
  tile(40, 220);
  ctx.clip();
  ctx.fillStyle = '#ff7a8a';
  ctx.beginPath();
  ctx.arc(size * 0.42, size * 0.46, size * 0.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.filter = 'blur(28px)';
  ctx.fillStyle = 'rgba(232, 238, 247, 0.92)';
  ctx.beginPath();
  ctx.roundRect(size * 0.36, size * 0.3, size * 0.44, size * 0.44, 70);
  ctx.fill();
  ctx.filter = 'none';
  ctx.restore();

  return canvas.toDataURL('image/png').split(',')[1];
})()`;

app.setPath('userData', path.join(os.tmpdir(), 'screenblur-make-icon'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const base64 = await win.webContents.executeJavaScript(DRAW);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, Buffer.from(base64, 'base64'));
  console.log(`Wrote ${OUTPUT}`);
  app.quit();
});
