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
  constructor(sampler, settings, { WorkerMessage, onError }) {
    this.sampler = sampler;
    this.settings = settings;
    this.WorkerMessage = WorkerMessage;
    this.onError = onError;

    this.port = null;
    this.running = false;
    this.idleTimer = null;
    this.retryTimer = null;
    this.seq = 0;
    this.inFlight = new Map(); // seq -> sent time
    this.lastSentAt = 0;
    this.lastSentFrame = -1;
    this.lastSentThumbnail = null;

    sampler.onFrame(() => this.trySend());
  }

  setPort(port) {
    this.port?.close();
    this.port = port;
    this.inFlight.clear();
    port.onmessage = ({ data }) => {
      if (data.type !== this.WorkerMessage.DONE) return;
      this.inFlight.delete(data.seq);
      this.trySend();
    };
    this.trySend();
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
    if (!this.running || !this.port || !this.sampler.ready || this.isBusy()) return;
    try {
      this.sendIfDue();
    } catch (err) {
      this.onError(err);
    }
  }

  isBusy() {
    const now = performance.now();
    for (const [seq, sentAt] of this.inFlight) {
      if (now - sentAt >= this.settings.busyTimeoutMs) this.inFlight.delete(seq); // never answered
    }
    return this.inFlight.size >= this.settings.maxInFlight;
  }

  sendIfDue() {
    const now = performance.now();
    const elapsed = now - this.lastSentAt;
    const minInterval = 1000 / this.settings.fps;
    const idleInterval = 1000 / this.settings.idleFps;

    if (elapsed < minInterval) {
      this.retryAfter(minInterval - elapsed);
      return;
    }

    const hasNewFrame = this.sampler.frameNumber !== this.lastSentFrame;
    if (!hasNewFrame && elapsed < idleInterval) return;

    const thumbnail = this.sampler.thumbnail();
    if (hasNewFrame && elapsed < idleInterval && this.isStatic(thumbnail)) return;

    this.send(now);
    this.lastSentThumbnail = thumbnail;
  }

  isStatic(thumbnail) {
    if (!this.lastSentThumbnail) return false;
    const { staticPixelDelta, staticMaxChangedPixels } = this.settings;
    return countChangedPixels(thumbnail, this.lastSentThumbnail, staticPixelDelta) <= staticMaxChangedPixels;
  }

  retryAfter(delayMs) {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.trySend();
    }, delayMs);
  }

  send(now) {
    const { image, contentWidth, contentHeight } = this.sampler.letterboxedFrame();
    this.seq += 1;
    this.inFlight.set(this.seq, now);
    this.lastSentAt = now;
    this.lastSentFrame = this.sampler.frameNumber;
    // No transfer list: ports entangled with a utility process silently drop messages
    // that transfer ArrayBuffers. Copying a 2 MB frame is cheap compared with inference.
    this.port.postMessage({
      type: this.WorkerMessage.FRAME,
      seq: this.seq,
      ts: this.sampler.frameCapturedAt, // when the screen content was captured
      width: image.width,
      height: image.height,
      contentWidth,
      contentHeight,
      data: image.data.buffer,
    });
  }
}
