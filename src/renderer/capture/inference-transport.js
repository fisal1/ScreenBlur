'use strict';

class InferenceTransport {
  constructor({ format, maxInFlight, onResult, onFrameDone, onFrameError, onState }) {
    this.format = format;
    this.maxInFlight = maxInFlight;
    this.onResult = onResult;
    this.onFrameDone = onFrameDone;
    this.onFrameError = onFrameError;
    this.onState = onState;
  }

  get ready() {
    return false;
  }

  sendFrame() {
    throw new Error('Inference transport does not implement sendFrame');
  }

  close() {
    throw new Error('Inference transport does not implement close');
  }
}

class MessagePortInferenceTransport extends InferenceTransport {
  constructor(port, WorkerMessage, { maxInFlight, onFrameDone }) {
    super({ format: 'rgba', maxInFlight, onFrameDone });
    this.port = port;
    this.WorkerMessage = WorkerMessage;
    port.onmessage = ({ data }) => {
      if (data.type === WorkerMessage.DONE) this.onFrameDone?.(data);
    };
  }

  get ready() {
    return this.port !== null;
  }

  sendFrame(frame) {
    if (!this.port) return false;
    this.port.postMessage({ type: this.WorkerMessage.FRAME, ...frame });
    return true;
  }

  close() {
    const port = this.port;
    this.port = null;
    if (!port) return;
    port.onmessage = null;
    port.close();
  }
}

if (typeof module !== 'undefined') {
  module.exports = { InferenceTransport, MessagePortInferenceTransport };
}
