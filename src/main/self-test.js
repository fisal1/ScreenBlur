// Phase 0 de-risk checks (RFC 8): pipeline latency and overlay exclusion from capture.
const fs = require('node:fs');
const path = require('node:path');
const { app, desktopCapturer } = require('electron');
const { ScreenBlurApp } = require('./screenblur-app');
const { createCoverWindow } = require('./overlay');

const FIRST_RESULT_TIMEOUT_MS = 20_000;
const MEASURE_MS = 6_000;
const COVER_SETTLE_MS = 1_000;
const TEST_COLOR = '#ff00ff';

// A capture showing the unprotected test window should be mostly magenta;
// one taken with content protection should contain almost none.
const VISIBLE_MIN_FRACTION = 0.8;
const HIDDEN_MAX_FRACTION = 0.05;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForEvent(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

function isMagenta(red, green, blue) {
  return red > 200 && blue > 200 && green < 60;
}

async function measurePipeline(screenBlur) {
  const inferenceMs = [];
  const endToEndMs = [];
  const onResult = (result) => {
    inferenceMs.push(result.latencyMs);
    endToEndMs.push(Date.now() - result.ts);
  };

  screenBlur.on('result', onResult);
  await sleep(MEASURE_MS);
  screenBlur.off('result', onResult);

  return {
    frames: inferenceMs.length,
    fps: Number((inferenceMs.length / (MEASURE_MS / 1000)).toFixed(1)),
    inferenceMs: { p50: percentile(inferenceMs, 50), p95: percentile(inferenceMs, 95) },
    endToEndMs: { p50: percentile(endToEndMs, 50), p95: percentile(endToEndMs, 95) },
  };
}

async function thumbnailMagentaFraction(display) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  const bitmap = source.thumbnail.toBitmap(); // BGRA
  let magenta = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    if (isMagenta(bitmap[i + 2], bitmap[i + 1], bitmap[i])) magenta++;
  }
  return magenta / (bitmap.length / 4);
}

async function captureWithCover(screenBlur, contentProtection) {
  const cover = createCoverWindow({ bounds: screenBlur.display.bounds, contentProtection, transparent: false });
  try {
    await cover.loadURL(`data:text/html,${encodeURIComponent(`<style>html{background:${TEST_COLOR}}</style>`)}`);
    cover.showInactive();
    await sleep(COVER_SETTLE_MS);
    return {
      liveStream: Number((await screenBlur.capture.probeMagentaFraction()).toFixed(3)),
      thumbnail: Number((await thumbnailMagentaFraction(screenBlur.display)).toFixed(3)),
    };
  } finally {
    cover.destroy();
  }
}

async function checkContentProtection(screenBlur) {
  const unprotected = await captureWithCover(screenBlur, false);
  await sleep(300);
  const protectedCover = await captureWithCover(screenBlur, true);

  const controlWorked = unprotected.liveStream >= VISIBLE_MIN_FRACTION;
  const excluded = protectedCover.liveStream <= HIDDEN_MAX_FRACTION;
  return {
    verdict: !controlWorked ? 'inconclusive' : excluded ? 'pass' : 'fail',
    magentaFraction: { unprotected, protected: protectedCover },
  };
}

async function runSelfTest(config) {
  const report = {
    startedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.getSystemVersion()}`,
    // What the app currently assumes; if the content protection check passes on a platform that
    // assumes otherwise, start the app with --overlay-hidden-from-capture.
    assumesOverlayHiddenFromCapture: config.platform.overlayHiddenFromCapture,
    checks: {},
  };
  const screenBlur = new ScreenBlurApp(config, { showTray: false, overlayEnabled: false });

  try {
    await screenBlur.start();
    await waitForEvent(screenBlur, 'result', FIRST_RESULT_TIMEOUT_MS);
    report.checks.pipeline = await measurePipeline(screenBlur);
    report.checks.contentProtection = await checkContentProtection(screenBlur);
  } catch (err) {
    report.error = String(err?.message ?? err);
  } finally {
    screenBlur.stop();
  }

  report.passed = !report.error && report.checks.contentProtection?.verdict === 'pass';
  const reportDir = config.packaged ? app.getPath('userData') : config.paths.root;
  report.path = path.join(reportDir, config.paths.selfTestReportName);
  fs.writeFileSync(report.path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report.passed;
}

module.exports = { runSelfTest };
