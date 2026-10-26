/**
 * Binary frame framing and engine JSON message parsing.
 *
 * Wire format is documented in docs/protocol.md:
 *   0  version      u8
 *   1  msg_type     u8
 *   2  seq          u32 be
 *   6  display_id   u32 be
 *  10  ts           u64 be (unix ms)
 *  18  payload_len  u32 be
 *  22  flags        u16 be
 *  24  payload      JPEG bytes
 *
 * This module intentionally has no Electron imports so it can be unit tested.
 */

import type {
  EngineErrorMessage,
  EngineMessage,
  EngineResultMessage,
  EngineStatusMessage,
  FrameHeader,
  PongMessage,
  ReadyMessage,
} from '../shared/types';

export const FRAME_VERSION = 1;
export const MSG_TYPE_FRAME = 1;
export const FRAME_HEADER_SIZE = 24;
// The engine's limit applies to the whole WebSocket message, including the
// 24-byte header, so keep the payload just under the documented 8 MiB.
export const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024 - FRAME_HEADER_SIZE;
export const FRAME_FLAGS = 0;

export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function assertUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ProtocolError('INVALID_FIELD', `${field} must be a uint32`);
  }
}

function assertSafeTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError('INVALID_FIELD', 'ts must be a non-negative safe integer (unix ms)');
  }
}

/**
 * Encode a complete frame (header + JPEG payload).
 * Throws ProtocolError when a field or the payload is out of range.
 */
export function encodeFrame(
  seq: number,
  displayId: number,
  timestampMs: number,
  payload: Uint8Array,
): Buffer {
  assertUint32(seq, 'seq');
  assertUint32(displayId, 'display_id');
  assertSafeTimestamp(timestampMs);

  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new ProtocolError(
      'PAYLOAD_TOO_LARGE',
      `Frame payload is ${payload.byteLength} bytes; max is ${MAX_FRAME_PAYLOAD_BYTES}`,
    );
  }

  const out = Buffer.allocUnsafe(FRAME_HEADER_SIZE + payload.byteLength);
  out.writeUInt8(FRAME_VERSION, 0);
  out.writeUInt8(MSG_TYPE_FRAME, 1);
  out.writeUInt32BE(seq, 2);
  out.writeUInt32BE(displayId, 6);
  out.writeBigUInt64BE(BigInt(timestampMs), 10);
  out.writeUInt32BE(payload.byteLength, 18);
  out.writeUInt16BE(FRAME_FLAGS, 22);
  out.set(payload, FRAME_HEADER_SIZE);
  return out;
}

/**
 * Parse and validate a complete frame. The buffer length must match the
 * payload_length field exactly; partial frames are rejected rather than
 * silently truncated.
 */
export function decodeFrame(buffer: Uint8Array): {
  header: FrameHeader;
  payload: Uint8Array;
} {
  const header = decodeFrameHeader(buffer);
  const payload = buffer.subarray(FRAME_HEADER_SIZE);
  return { header, payload };
}

export function decodeFrameHeader(buffer: Uint8Array): FrameHeader {
  if (buffer.byteLength < FRAME_HEADER_SIZE) {
    throw new ProtocolError('SHORT_HEADER', `Frame header needs ${FRAME_HEADER_SIZE} bytes`);
  }

  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const version = view.readUInt8(0);
  if (version !== FRAME_VERSION) {
    throw new ProtocolError('BAD_VERSION', `Unsupported frame version ${version}`);
  }

  const msgType = view.readUInt8(1);
  if (msgType !== MSG_TYPE_FRAME) {
    throw new ProtocolError('BAD_TYPE', `Unsupported message type ${msgType}`);
  }

  const seq = view.readUInt32BE(2);
  const displayId = view.readUInt32BE(6);
  const tsBig = view.readBigUInt64BE(10);
  if (tsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtocolError('INVALID_FIELD', 'ts exceeds the safe integer range');
  }
  const ts = Number(tsBig);
  const payloadLength = view.readUInt32BE(18);
  const flags = view.readUInt16BE(22);

  if (payloadLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new ProtocolError(
      'PAYLOAD_TOO_LARGE',
      `Declared payload is ${payloadLength} bytes; max is ${MAX_FRAME_PAYLOAD_BYTES}`,
    );
  }
  const actualPayload = view.byteLength - FRAME_HEADER_SIZE;
  if (payloadLength !== actualPayload) {
    throw new ProtocolError(
      'PAYLOAD_LENGTH_MISMATCH',
      `Declared payload ${payloadLength} does not match ${actualPayload} available bytes`,
    );
  }

  return { version, msgType, seq, displayId, ts, payloadLength, flags };
}

// ---------------------------------------------------------------------------
// Engine -> Electron JSON
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asSequence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function parseReady(value: Record<string, unknown>): ReadyMessage | null {
  if (typeof value.version !== 'string') return null;
  return {
    type: 'ready',
    version: value.version,
    protocol: asFiniteNumber(value.protocol, 1),
    models: Array.isArray(value.models)
      ? value.models.filter((model): model is string => typeof model === 'string')
      : [],
    detector: asString(value.detector, 'unknown'),
  };
}

function parseResult(value: Record<string, unknown>): EngineResultMessage | null {
  const seq = asSequence(value.seq);
  if (seq === null || typeof value.show !== 'boolean') return null;
  const score = asFiniteNumber(value.score, Number.NaN);
  if (!Number.isFinite(score)) return null;

  const boxes: number[][] = [];
  if (Array.isArray(value.boxes)) {
    for (const box of value.boxes) {
      if (!Array.isArray(box)) continue;
      const numbers = box.filter((part): part is number => typeof part === 'number' && Number.isFinite(part));
      if (numbers.length === 4) boxes.push(numbers);
    }
  }

  let roi: EngineResultMessage['roi'] = null;
  if (isRecord(value.roi)) {
    const x = asFiniteNumber(value.roi.x, Number.NaN);
    const y = asFiniteNumber(value.roi.y, Number.NaN);
    const w = asFiniteNumber(value.roi.w, Number.NaN);
    const h = asFiniteNumber(value.roi.h, Number.NaN);
    if ([x, y, w, h].every(Number.isFinite)) roi = { x, y, w, h };
  }

  return {
    type: 'result',
    seq,
    display_id: Math.trunc(asFiniteNumber(value.display_id, 0)),
    show: value.show,
    score: Math.min(1, Math.max(0, score)),
    category: asString(value.category, 'unknown'),
    boxes,
    roi,
    latency_ms: Math.max(0, asFiniteNumber(value.latency_ms, 0)),
    processing_ms: Math.max(0, asFiniteNumber(value.processing_ms, 0)),
    superseded: value.superseded === true,
  };
}

function parseStatus(value: Record<string, unknown>): EngineStatusMessage | null {
  if (typeof value.paused !== 'boolean') return null;
  return {
    type: 'status',
    paused: value.paused,
    sensitivity: asFiniteNumber(value.sensitivity, 0.35),
    fps: asFiniteNumber(value.fps, 2),
    detector: asString(value.detector, 'unknown'),
  };
}

function parseError(value: Record<string, unknown>): EngineErrorMessage | null {
  if (typeof value.code !== 'string') return null;
  return {
    type: 'error',
    code: value.code,
    message: asString(value.message, 'Engine error'),
  };
}

function parsePong(value: Record<string, unknown>): PongMessage | null {
  const id = asFiniteNumber(value.id, Number.NaN);
  if (!Number.isFinite(id)) return null;
  return { type: 'pong', id };
}

/**
 * Parse an engine JSON message. Returns null for malformed or unknown
 * payloads so callers can safely ignore them.
 */
export function parseEngineMessage(raw: string | Buffer): EngineMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  switch (value.type) {
    case 'ready':
      return parseReady(value);
    case 'result':
      return parseResult(value);
    case 'status':
      return parseStatus(value);
    case 'error':
      return parseError(value);
    case 'pong':
      return parsePong(value);
    default:
      return null;
  }
}

export type ControlMessage =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'config'; sensitivity: number; fps: number }
  | { type: 'ping'; id: number };
