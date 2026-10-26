import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';

import type {
  AppConfig,
  ConnectionState,
  ConnectionStatus,
  EngineMessage,
  EngineResultMessage,
  PongMessage,
  ReadyMessage,
} from '../shared/types';
import { Logger, logger as defaultLogger } from './logger';
import { parseEngineMessage, type ControlMessage } from './protocol';

export interface WsClientOptions {
  url: string;
  token: string;
  logger?: Logger;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Loopback WebSocket client with token auth, ready handshake, heartbeats and
 * jittered exponential reconnect. Results are forwarded as parsed messages;
 * malformed payloads are ignored.
 */
export class WsClient extends EventEmitter {
  private readonly logger: Logger;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  private baseUrl: string;
  private token: string;
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private lastError: string | null = null;
  private latencyMs: number | null = null;
  private lastResultAt: number | null = null;
  private lastSentSeq = 0;

  private intentionalClose = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatDeadline: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingId = 0;
  private pendingPingId: number | null = null;
  private pingSentAt = 0;

  constructor(options: WsClientOptions) {
    super();
    this.logger = options.logger ?? defaultLogger;
    this.baseUrl = options.url;
    this.token = options.token;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 6_000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
  }

  get lastSequence(): number {
    return this.lastSentSeq;
  }

  getStatus(): ConnectionStatus {
    return {
      state: this.state,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      latencyMs: this.latencyMs,
      lastResultAt: this.lastResultAt,
      lastSentSeq: this.lastSentSeq,
    };
  }

  /** Point the client at a new engine and connect. Replaces any existing socket. */
  connect(url?: string, token?: string): void {
    if (url) this.baseUrl = url;
    if (token !== undefined) this.token = token;
    if (!this.baseUrl) {
      this.lastError = 'No engine URL configured';
      this.setState('error');
      return;
    }

    this.intentionalClose = false;
    this.clearTimers();
    this.detachSocket();

    let target: URL;
    try {
      target = new URL(this.baseUrl);
    } catch {
      this.lastError = 'Invalid engine URL';
      this.logger.error('ws', this.lastError);
      this.setState('error');
      return;
    }
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      this.lastError = 'Engine URL must use ws:// or wss://';
      this.logger.error('ws', this.lastError);
      this.setState('error');
      return;
    }
    if (!isLoopbackHost(target.hostname)) {
      this.lastError = 'Refusing to connect to a non-loopback engine';
      this.logger.error('ws', this.lastError);
      this.setState('error');
      return;
    }
    if (this.token && !target.searchParams.has('token')) {
      target.searchParams.set('token', this.token);
    }

    this.setState('connecting');
    this.logger.info('ws', `Connecting to ${target.origin}${target.pathname}`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(target.toString(), {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
        handshakeTimeout: 10_000,
        maxPayload: 16 * 1024 * 1024,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error('ws', `WebSocket setup failed: ${this.lastError}`);
      this.setState('error');
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.logger.info('ws', 'WebSocket connected; waiting for engine ready');
      this.setState('handshaking');
      this.startReadyTimer(socket);
    });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (this.socket !== socket || isBinary) return;
      this.handleMessage(data.toString());
    });

    socket.on('error', (error) => {
      if (this.socket !== socket) return;
      this.lastError = error.message;
      this.logger.warn('ws', `WebSocket error: ${error.message}`);
    });

    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.pendingPingId = null;
      const detail = `WebSocket closed (${code}${reason.length ? `: ${reason.toString()}` : ''})`;
      if (this.intentionalClose) {
        this.logger.info('ws', detail);
        this.setState('disconnected');
        return;
      }
      this.lastError = detail;
      this.logger.warn('ws', detail);
      this.setState('disconnected');
      this.scheduleReconnect();
    });
  }

  /** Close the socket and stop reconnecting. */
  close(): void {
    this.intentionalClose = true;
    this.clearTimers();
    this.detachSocket();
    this.setState('disconnected');
  }

  dispose(): void {
    this.close();
    this.removeAllListeners();
  }

  sendFrame(frame: Uint8Array, seq: number): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.state !== 'ready') {
      return false;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.logger.debug('ws', 'Dropping frame because the socket is backpressured');
      return false;
    }
    socket.send(frame, (error) => {
      if (error) {
        this.logger.warn('ws', `Frame send failed: ${error.message}`);
      }
    });
    this.lastSentSeq = seq;
    return true;
  }

  sendControl(message: ControlMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(message);
    socket.send(payload, (error) => {
      if (error) this.logger.warn('ws', `Control send failed: ${error.message}`);
    });
    return true;
  }

  sendConfig(config: Pick<AppConfig, 'sensitivity' | 'fps'>): boolean {
    return this.sendControl({ type: 'config', sensitivity: config.sensitivity, fps: config.fps });
  }

  private handleMessage(raw: string): void {
    const message = parseEngineMessage(raw);
    if (!message) {
      this.logger.debug('ws', 'Ignoring malformed engine message');
      return;
    }

    switch (message.type) {
      case 'ready':
        this.handleReady(message);
        return;
      case 'result':
        this.handleResult(message);
        return;
      case 'status':
        this.emit('status', message);
        return;
      case 'error':
        this.lastError = `${message.code}: ${message.message}`;
        this.logger.warn('engine', `Engine error ${message.code}: ${message.message}`);
        this.emit('engine-error', message);
        return;
      case 'pong':
        this.handlePong(message);
        return;
    }
  }

  private handleReady(message: ReadyMessage): void {
    this.clearReadyTimer();
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.setState('ready');
    this.logger.info(
      'ws',
      `Engine ready: v${message.version} protocol ${message.protocol} detector ${message.detector}`,
    );
    this.startHeartbeat();
    this.emit('ready', message);
  }

  private handleResult(message: EngineResultMessage): void {
    if (this.state !== 'ready') return;
    this.lastResultAt = Date.now();
    this.emit('result', message);
  }

  private handlePong(message: PongMessage): void {
    if (this.pendingPingId !== null && message.id === this.pendingPingId) {
      this.latencyMs = Math.max(0, Date.now() - this.pingSentAt);
      this.pendingPingId = null;
      this.clearHeartbeatDeadline();
    }
    // Mirror the engine message, consistent with 'ready'/'result'/'status'.
    // `latencyMs` (updated for heartbeat replies) remains available via
    // getStatus().
    this.emit('pong', message);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'ready') return;
      if (this.pendingPingId !== null) {
        this.failConnection('Engine heartbeat timed out');
        return;
      }
      const id = ++this.pingId;
      this.pendingPingId = id;
      this.pingSentAt = Date.now();
      if (!this.sendControl({ type: 'ping', id })) {
        this.pendingPingId = null;
        return;
      }
      this.heartbeatDeadline = setTimeout(() => {
        if (this.pendingPingId === id) this.failConnection('Engine heartbeat timed out');
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private failConnection(reason: string): void {
    this.lastError = reason;
    this.logger.warn('ws', reason);
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    this.pendingPingId = null;
    if (socket) {
      this.destroySocket(socket);
    }
    this.setState('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempts - 1, 10),
    );
    const jitter = 0.7 + Math.random() * 0.6;
    const delay = Math.round(backoff * jitter);
    this.logger.info('ws', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) this.connect();
    }, delay);
  }

  private startReadyTimer(socket: WebSocket): void {
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.socket !== socket || this.state === 'ready') return;
      this.failConnection('Engine did not send ready within 10s');
    }, this.readyTimeoutMs);
  }

  private detachSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.pendingPingId = null;
    if (socket) {
      this.destroySocket(socket);
    }
  }

  /**
   * Detach and terminate a socket. A no-op `error` listener is attached before
   * terminating so an asynchronous socket error cannot become unhandled.
   */
  private destroySocket(socket: WebSocket): void {
    socket.removeAllListeners();
    socket.on('error', () => {
      // Errors during intentional teardown are expected.
    });
    try {
      socket.terminate();
    } catch {
      // Already closed.
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit('connection', this.getStatus());
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private clearHeartbeatDeadline(): void {
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.clearHeartbeatDeadline();
  }

  private clearTimers(): void {
    this.clearReadyTimer();
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

export type { EngineMessage };
