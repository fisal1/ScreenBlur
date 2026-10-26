'use strict';

/**
 * Latest-only frame pipeline (RFC 6.1, 6.2).
 * At most one frame is in flight. Each tick compares a tiny thumbnail with the last sent
 * frame and sends a fresh frame when the screen changed a lot or the frame interval elapsed.
 * Frames are grabbed at send time, so the worker always gets the newest screen contents.
 */
class CapturePipeline {
  constructor(sampler, settings, { WorkerMessage, onError }) {
    this.sampler = sampler;
    this.settings = settings;
    this.WorkerMessage = WorkerMessage;
    this.onError = onError;

    this.port = null;
    this.running = false;
    this.timer = null;
    this.seq = 0;
    this.inFlightSince = null;
    this.lastSentAt = 0;
    this.lastSentThumbnail = null;
  }

  setPort(port) {
    this.port?.close();
    this.port = port;
    this.inFlightSince = null;
    port.onmessage = ({ data }) => {
      if (data.type === this.WorkerMessage.DONE) this.inFlightSince = null;
    };
  }

  resume() {
    if (this.running) return;
    this.running = true;
    this.scheduleTick();
  }

  pause() {
    this.running = false;
    clearTimeout(this.timer);
  }

  scheduleTick() {
    this.timer = setTimeout(() => this.tick(), this.settings.tickMs);
  }

  tick() {
    if (!this.running) return;
    try {
      if (this.port && this.sampler.ready && !this.isBusy()) this.sendIfDue();
    } catch (err) {
      this.onError(err);
    }
    this.scheduleTick();
  }

  isBusy() {
    if (this.inFlightSince === null) return false;
    if (performance.now() - this.inFlightSince < this.settings.busyTimeoutMs) return true;
    this.inFlightSince = null; // worker never replied; stop waiting
    return false;
  }

  sendIfDue() {
    const now = performance.now();
    const thumbnail = this.sampler.thumbnail();
    const change = this.lastSentThumbnail ? meanAbsoluteDifference(thumbnail, this.lastSentThumbnail) : Infinity;

    const { fps, idleFps, sceneChangeThreshold, staticThreshold } = this.settings;
    const interval = 1000 / (change < staticThreshold ? idleFps : fps);
    const sceneChanged = change >= sceneChangeThreshold;
    if (!sceneChanged && now - this.lastSentAt < interval) return;

    this.send(now);
    this.lastSentThumbnail = thumbnail;
  }

  send(now) {
    const image = this.sampler.letterboxedFrame();
    this.seq += 1;
    this.inFlightSince = now;
    this.lastSentAt = now;
    // No transfer list: ports entangled with a utility process silently drop messages
    // that transfer ArrayBuffers. Copying a 400 KB frame is negligible.
    this.port.postMessage({
      type: this.WorkerMessage.FRAME,
      seq: this.seq,
      ts: Date.now(),
      width: image.width,
      height: image.height,
      data: image.data.buffer,
    });
  }
}
