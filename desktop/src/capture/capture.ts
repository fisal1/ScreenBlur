/**
 * Hidden capture renderer. Reads the desktop source id and configuration from
 * the main process over IPC, captures frames with getUserMedia, downscales them
 * on a canvas, JPEG-encodes with toBlob and forwards ArrayBuffers to main.
 *
 * This page never renders visible UI and does not access the network.
 */

import type { CaptureConfig, CaptureInit } from '../shared/types';

interface CaptureState {
  config: CaptureInit | null;
  paused: boolean;
  running: boolean;
  stream: MediaStream | null;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
  timer: number | null;
  lastErrorAt: number;
  stopping: boolean;
}

const state: CaptureState = {
  config: null,
  paused: true,
  running: false,
  stream: null,
  video: document.createElement('video'),
  canvas: document.createElement('canvas'),
  context: null,
  timer: null,
  lastErrorAt: 0,
  stopping: false,
};

state.video.muted = true;
state.video.playsInline = true;
state.video.autoplay = true;
state.video.style.display = 'none';
document.body.appendChild(state.video);
state.context = state.canvas.getContext('2d', { alpha: false });

function reportError(message: string): void {
  const now = Date.now();
  if (now - state.lastErrorAt < 3000) return;
  state.lastErrorAt = now;
  try {
    window.captureBridge.error(message);
  } catch {
    // Preload bridge is unavailable; nothing else we can do.
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function stopStream(): void {
  if (state.timer !== null) {
    window.clearTimeout(state.timer);
    state.timer = null;
  }
  state.running = false;
  if (state.stream) {
    for (const track of state.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore track shutdown failures.
      }
    }
  }
  state.stream = null;
  state.video.srcObject = null;
}

/** Release camera/screen tracks before the hidden window is destroyed. */
function stopCapture(): void {
  state.stopping = true;
  state.paused = true;
  state.config = null;
  stopStream();
  state.stopping = false;
}

async function startCapture(payload: CaptureInit): Promise<void> {
  const config: CaptureInit = {
    sourceId: String(payload.sourceId),
    displayId: typeof payload.displayId === 'number' ? payload.displayId : null,
    fps: Math.round(clamp(payload.fps, 1, 5, 2)),
    jpegQuality: Math.round(clamp(payload.jpegQuality, 50, 95, 75)),
    maxWidth: Math.round(clamp(payload.maxWidth, 320, 3840, 1280)),
  };

  if (!config.sourceId) {
    reportError('No desktop capture source was provided');
    return;
  }

  state.stopping = true;
  stopStream();
  state.config = config;
  state.stopping = false;
  // Leave `paused` as-is: the main process sends the authoritative pause state
  // immediately after init, and it may arrive before getUserMedia resolves.

  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: config.sourceId,
        maxFrameRate: Math.min(10, Math.max(1, config.fps)),
        maxWidth: 4096,
        maxHeight: 2160,
      },
    },
  } as unknown as MediaStreamConstraints;

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (state.stopping) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    state.stream = stream;
    state.video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Video did not start within 8s')), 8000);
      const onLoaded = (): void => {
        window.clearTimeout(timeout);
        state.video.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      state.video.addEventListener('loadedmetadata', onLoaded);
    });

    await state.video.play().catch(() => {
      // A muted hidden video normally autoplays; failing to play is reported
      // through the first capture attempt instead of aborting outright.
    });

    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (!state.stopping) reportError('Screen capture source ended');
      });
    }

    state.running = true;
    window.captureBridge.ready({
      width: state.video.videoWidth,
      height: state.video.videoHeight,
    });
    scheduleNextFrame();
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'NotAllowedError') {
      reportError('Screen Recording permission was denied for the capture source');
    } else {
      reportError(`Could not open the desktop capture source: ${message}`);
    }
    stopStream();
  }
}

function scheduleNextFrame(): void {
  if (!state.running || !state.config) return;
  if (state.timer !== null) window.clearTimeout(state.timer);
  const delay = Math.max(100, Math.round(1000 / state.config.fps));
  state.timer = window.setTimeout(() => {
    state.timer = null;
    void captureFrame();
  }, delay);
}

async function captureFrame(): Promise<void> {
  if (!state.running || !state.config) return;
  if (state.paused || state.video.readyState < 2) {
    scheduleNextFrame();
    return;
  }

  const config = state.config;
  const sourceWidth = state.video.videoWidth;
  const sourceHeight = state.video.videoHeight;
  if (!sourceWidth || !sourceHeight) {
    scheduleNextFrame();
    return;
  }

  const scale = Math.min(1, config.maxWidth / sourceWidth);
  const width = Math.max(2, Math.round(sourceWidth * scale));
  const height = Math.max(2, Math.round(sourceHeight * scale));

  if (state.canvas.width !== width || state.canvas.height !== height) {
    state.canvas.width = width;
    state.canvas.height = height;
  }

  const context = state.context;
  if (!context) {
    reportError('Could not create a 2D canvas context');
    return;
  }

  try {
    context.drawImage(state.video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      state.canvas.toBlob(resolve, 'image/jpeg', config.jpegQuality / 100);
    });
    if (!blob) {
      reportError('JPEG encoding returned an empty frame');
      return;
    }
    if (state.paused || !state.running) return;
    const buffer = await blob.arrayBuffer();
    if (state.paused || !state.running) return;
    window.captureBridge.frame(buffer);
  } catch (error) {
    reportError(`Frame capture failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    scheduleNextFrame();
  }
}

function mergeConfig(patch: CaptureConfig): void {
  if (!state.config) return;
  const next: CaptureInit = {
    ...state.config,
    fps: Math.round(clamp(patch.fps, 1, 5, state.config.fps)),
    jpegQuality: Math.round(clamp(patch.jpegQuality, 50, 95, state.config.jpegQuality)),
    maxWidth: Math.round(clamp(patch.maxWidth, 320, 3840, state.config.maxWidth)),
  };
  const fpsChanged = next.fps !== state.config.fps;
  state.config = next;
  if (fpsChanged && state.running) scheduleNextFrame();
}

window.captureBridge.onInit((payload) => {
  void startCapture(payload);
});

window.captureBridge.onConfig((payload) => {
  mergeConfig(payload);
});

window.captureBridge.onPaused((paused) => {
  state.paused = Boolean(paused);
});

window.captureBridge.onStop(() => {
  stopCapture();
});

window.addEventListener('error', (event) => {
  reportError(`Unhandled capture error: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  reportError(`Unhandled capture promise rejection: ${reason}`);
});
