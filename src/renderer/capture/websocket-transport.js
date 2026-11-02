'use strict';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 5 * 1024 * 1024;
const TransportBase = typeof module !== 'undefined'
  ? require('./inference-transport').InferenceTransport
  : InferenceTransport;

class WebSocketTransport extends TransportBase {
  constructor({ endpoint, token, profile = 'mid', onResult, onFrameError, onState }) {
    super({
      format: 'jpeg',
      maxInFlight: 1,
      onResult,
      onFrameError,
      onState,
    });
    this.endpoint = endpoint;
    this.token = token;
    this.profile = ['low', 'mid', 'high'].includes(profile) ? profile : 'mid';
    this.socket = null;
    this.sessionId = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.closed = false;
  }

  connect() {
    if (this.closed || this.socket) return;
    this.onState('connecting');
    let socket;
    try {
      socket = new WebSocket(this.endpoint);
    } catch (error) {
      this.onState('disconnected', error.message);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ type: 'auth', protocolVersion: PROTOCOL_VERSION, token: this.token }));
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      this.handleMessage(event.data);
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.onState('connecting', 'WebSocket connection error');
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.sessionId = null;
      this.onState('disconnected', `WebSocket closed (${event.code})`);
      this.scheduleReconnect();
    });
  }

  get ready() {
    return this.socket?.readyState === WebSocket.OPEN && this.sessionId !== null;
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.onState('disconnected', 'Service returned invalid JSON');
      this.socket?.close(1002, 'Invalid service response');
      return;
    }

    if (message.type === 'ready') {
      if (message.protocolVersion !== PROTOCOL_VERSION || typeof message.sessionId !== 'string') {
        this.socket?.close(1002, 'Unsupported service protocol');
        return;
      }
      this.sessionId = message.sessionId;
      this.retryAttempt = 0;
      this.onState('connected', message.modelVersion);
      return;
    }
    if (message.type === 'ping') {
      this.socket?.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (message.type === 'result') {
      if (message.protocolVersion !== PROTOCOL_VERSION || message.sessionId !== this.sessionId) {
        this.onState('disconnected', 'Service response does not match this session');
        return;
      }
      this.onResult(message);
      return;
    }
    if (message.type === 'error') {
      this.onFrameError(message);
      return;
    }
    this.onState('disconnected', 'Service returned an unsupported message');
    this.socket?.close(1002, 'Unsupported service response');
  }

  sendFrame(frame, jpegBytes) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.sessionId) return false;
    if (jpegBytes.byteLength > MAX_FRAME_BYTES) return false;
    if (socket.bufferedAmount + jpegBytes.byteLength > MAX_BUFFERED_BYTES) return false;
    socket.send(JSON.stringify({
      type: 'frame',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      correlationId: frame.correlationId,
      seq: frame.seq,
      captureTimestampMs: frame.ts,
      sceneChange: frame.sceneChange,
      width: frame.width,
      height: frame.height,
      contentWidth: frame.contentWidth,
      contentHeight: frame.contentHeight,
      format: 'jpeg',
      payloadBytes: jpegBytes.byteLength,
    }));
    socket.send(jpegBytes);
    return true;
  }

  scheduleReconnect() {
    if (this.closed || this.retryTimer) return;
    const baseDelay = Math.min(30_000, 500 * (2 ** this.retryAttempt++));
    const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.sessionId = null;
    socket?.close(1000, 'Inference transport stopped');
  }
}

if (typeof module !== 'undefined') {
  module.exports = { WebSocketTransport };
}
