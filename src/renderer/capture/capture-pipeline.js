'use strict';

/**
 * Latest-only frame pipeline (RFC 6.1, 6.2), driven by the capture stream rather than a timer
 * (Windows timers tick every ~15.6 ms, which capped polling at ~17 fps).
 *
 * - A new screen frame is sent as soon as it arrives, at most `fps` times per second and only
 *   while fewer than `maxInFlight` frames are being analyzed. The worker keeps just the newest
 *   waiting frame, so the next frame is transferred while the previous one is analyzed.
 * - When the worker finishes a frame and a newer screen frame is waiting, it is sent right away.
 * - A static screen is re-sent `idleFps` times per second so areas on a still image stay confirmed.
 *   A frame where only a few thumbnail pixels changed (e.g. a blinking cursor) counts as static.
 *   Counting changed pixels, rather than averaging, keeps small moving content (a video in a
 *   window) at the full rate: it barely moves the average but changes many pixels.
 */
class CapturePipeline {
  constructor(sampler, settings, { WorkerMessage, onError, onResult, onInferenceState }) {
    this.sampler = sampler;
    this.settings = settings;
    this.WorkerMessage = WorkerMessage;
    this.onError = onError;
    this.onResult = onResult;
    this.onInferenceState = onInferenceState;

    this.transport = null;
    this.running = false;
    this.idleTimer = null;
    this.retryTimer = null;
    this.seq = 0;
    this.inFlight = new Map(); // seq -> sent time
    this.lastSentAt = 0;
    this.lastSentFrame = -1;
    this.lastSentThumbnail = null;
    this.mask = null; // thumbnail pixels covered by our overlay
    this.maskedPixels = 0;
    this.remoteFps = 2;
    this.remoteRttMs = null;

    sampler.onFrame(() => this.trySend());
  }

  /** Areas covered by our overlay (normalized boxes); change detection ignores them. */
  setMask(boxes) {
    this.mask = boxes.length ? maskFromBoxes(boxes, this.sampler.thumbnailSize) : null;
    this.maskedPixels = this.mask ? this.mask.reduce((sum, value) => sum + value, 0) : 0;
  }

  setPort(port) {
    this.transport?.close();
    this.inFlight.clear();
    const transport = new MessagePortInferenceTransport(port, this.WorkerMessage, {
      maxInFlight: this.settings.maxInFlight,
      onFrameDone: ({ seq }) => {
        if (this.transport !== transport) return;
        this.inFlight.delete(seq);
        this.trySend();
      },
    });
    this.transport = transport;
    this.trySend();
  }

  setRemote(remote) {
    this.transport?.close();
    this.transport = null;
    this.inFlight.clear();
    if (!remote?.enabled) return;
    this.remoteFps = ({ low: 1, mid: 2, high: 3 })[remote.profile] ?? 2;
    this.transport = new WebSocketTransport({
      endpoint: remote.endpoint,
      token: remote.token,
      profile: remote.profile,
      onResult: (result) => this.handleRemoteResult(result),
      onFrameError: (message) => this.handleRemoteError(message),
      onState: (state, detail) => {
        this.onInferenceState?.(state, detail);
        this.trySend();
      },
    });
    this.transport.connect();
  }

  resume() {
    if (this.running) return;
    this.running = true;
    this.idleTimer = setInterval(() => this.trySend(), 1000 / this.settings.idleFps);
    this.trySend();
  }

  pause() {
    this.running = false;
    clearInterval(this.idleTimer);
    clearTimeout(this.retryTimer);
  }

  trySend() {
    if (
      !this.running ||
      !this.transport?.ready ||
      !this.sampler.ready ||
      this.isBusy()
    ) return;
    try {
      this.sendIfDue();
    } catch (err) {
      this.onError(err);
    }
  }

  isBusy() {
    const now = performance.now();
    for (const [seq, pending] of this.inFlight) {
      const sentAt = typeof pending === 'number' ? pending : pending.sentAt;
      if (now - sentAt >= this.settings.busyTimeoutMs) this.inFlight.delete(seq); // never answered
    }
    const maxInFlight = this.transport.maxInFlight;
    return this.inFlight.size >= maxInFlight;
  }

  sendIfDue() {
    const now = performance.now();
    const elapsed = this.lastSentAt === 0 ? Infinity : now - this.lastSentAt;
    const remote = this.transport.format === 'jpeg';
    const fps = remote ? Math.min(this.settings.fps, this.remoteFps) : this.settings.fps;
    const idleFps = remote ? Math.min(this.settings.idleFps, this.remoteFps) : this.settings.idleFps;
    const minInterval = 1000 / fps;
    const idleInterval = 1000 / idleFps;

    if (elapsed < minInterval) {
      this.retryAfter(minInterval - elapsed);
      return;
    }

    const hasNewFrame = this.sampler.frameNumber !== this.lastSentFrame;
    if (!hasNewFrame && elapsed < idleInterval) return;

    const thumbnail = this.sampler.thumbnail();
    const changedPixels = this.changedPixels(thumbnail);
    if (hasNewFrame && elapsed < idleInterval && changedPixels <= this.settings.staticMaxChangedPixels) return;

    const visiblePixels = Math.max(1, thumbnail.length - this.maskedPixels);
    this.send(now, Math.min(1, changedPixels / visiblePixels));
    this.lastSentThumbnail = thumbnail;
  }

  /**
   * Thumbnail pixels outside our overlay that changed since the last sent frame
   * (all of them for the first frame).
   */
  changedPixels(thumbnail) {
    if (!this.lastSentThumbnail) return thumbnail.length;
    return countChangedPixels(thumbnail, this.lastSentThumbnail, this.settings.staticPixelDelta, this.mask);
  }

  retryAfter(delayMs) {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.trySend();
    }, delayMs);
  }

  /** @param sceneChange share (0..1) of the screen that changed since the last sent frame */
  send(now, sceneChange) {
    const transport = this.transport;
    if (transport.format === 'jpeg') {
      this.sendRemote(now, sceneChange, transport).catch((err) => this.onError(err));
      return;
    }
    const { image, contentWidth, contentHeight } = this.sampler.letterboxedFrame();
    this.seq += 1;
    this.inFlight.set(this.seq, now);
    this.lastSentAt = now;
    this.lastSentFrame = this.sampler.frameNumber;
    // No transfer list: ports entangled with a utility process silently drop messages
    // that transfer ArrayBuffers. Copying a 2 MB frame is cheap compared with inference.
    transport.sendFrame({
      seq: this.seq,
      ts: this.sampler.frameCapturedAt, // when the screen content was captured
      sceneChange,
      width: image.width,
      height: image.height,
      contentWidth,
      contentHeight,
      data: image.data.buffer,
    });
  }

  async sendRemote(now, sceneChange, transport) {
    const seq = ++this.seq;
    const frame = {
      seq,
      ts: this.sampler.frameCapturedAt,
      capturedAtMonotonic: this.sampler.frameCapturedAtMonotonic,
      sceneChange,
    };
    this.inFlight.set(seq, {
      sentAt: now,
      capturedAt: frame.ts,
      capturedAtMonotonic: frame.capturedAtMonotonic,
      sceneChange,
    });
    this.lastSentAt = now;
    this.lastSentFrame = this.sampler.frameNumber;

    try {
      const { bytes, width, height, contentWidth, contentHeight } =
        await this.sampler.jpegFrame(this.settings.jpegQuality ?? 0.82);
      if (!this.inFlight.has(seq) || this.transport !== transport) return;
      const sent = transport.sendFrame({
        ...frame,
        correlationId: `frame-${seq}-${frame.ts}`,
        width,
        height,
        contentWidth,
        contentHeight,
      }, bytes);
      if (!sent) {
        this.inFlight.delete(seq);
        this.onInferenceState?.('backpressure', 'Frame not sent because the connection is busy');
        this.trySend();
      }
    } catch (error) {
      this.inFlight.delete(seq);
      this.onError(error);
      this.trySend();
    }
  }

  handleRemoteResult(message) {
    const pending = this.inFlight.get(message.seq);
    if (!pending) return;
    this.inFlight.delete(message.seq);
    if (message.correlationId !== `frame-${message.seq}-${pending.capturedAt}` ||
        !Number.isFinite(message.score) || message.score < 0 || message.score > 1 ||
        !Array.isArray(message.regions) || message.regions.length > 20 ||
        message.regions.some((region) =>
          !Number.isFinite(region.score) || region.score < 0 || region.score > 1 ||
          !region.box || ['x', 'y', 'width', 'height'].some((key) => !Number.isFinite(region.box[key])) ||
          region.box.x < 0 || region.box.y < 0 || region.box.width <= 0 || region.box.height <= 0 ||
          region.box.x + region.box.width > 1.001 || region.box.y + region.box.height > 1.001 ||
          typeof region.label !== 'string' ||
          !region.mosaic || !Number.isInteger(region.mosaic.cols) || !Number.isInteger(region.mosaic.rows) ||
          region.mosaic.cols < 1 || region.mosaic.cols > 10 || region.mosaic.rows < 1 || region.mosaic.rows > 10 ||
          !Array.isArray(region.mosaic.data) || region.mosaic.data.length !== region.mosaic.cols * region.mosaic.rows * 4
        )) {
      this.onInferenceState?.('error', 'Service returned an invalid inference result');
      this.trySend();
      return;
    }

    const maxAgeMs = this.settings.maxFrameAgeMs ?? 1500;
    const ageMs = performance.now() - pending.capturedAtMonotonic;
    if (ageMs > maxAgeMs || message.captureTimestampMs !== pending.capturedAt) {
      this.onInferenceState?.('stale', `Ignored a result ${Math.round(ageMs)} ms after capture`);
      this.trySend();
      return;
    }

    this.onInferenceState?.('connected');
    const rtt = Math.max(0, performance.now() - pending.sentAt);
    this.remoteRttMs = this.remoteRttMs === null ? rtt : this.remoteRttMs * 0.75 + rtt * 0.25;
    if (this.remoteRttMs > 1500) this.remoteFps = 1;
    else if (this.remoteRttMs > 600) this.remoteFps = Math.max(1, this.remoteFps - 1);
    else if (this.remoteRttMs < 250) {
      const profileLimit = ({ low: 1, mid: 2, high: 3 })[this.transport?.profile] ?? 2;
      this.remoteFps = Math.min(profileLimit, this.remoteFps + 0.25);
    }

    this.onResult?.({
      seq: message.seq,
      ts: pending.capturedAt,
      sceneChange: pending.sceneChange,
      score: message.score,
      label: message.label,
      regions: message.regions,
      latencyMs: message.inferenceMs,
      modelVersion: message.modelVersion,
    });
    this.trySend();
  }

  handleRemoteError(message) {
    const pending = this.inFlight.get(message.seq);
    if (pending) this.inFlight.delete(message.seq);
    this.onInferenceState?.('error', `${message.code ?? 'SERVICE_ERROR'}: ${message.message ?? 'Inference failed'}`);
    this.trySend();
  }
}

if (typeof module !== 'undefined') {
  module.exports = { CapturePipeline };
}
