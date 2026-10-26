import { describe, expect, it } from 'vitest';

import {
  decodeFrame,
  decodeFrameHeader,
  encodeFrame,
  FRAME_HEADER_SIZE,
  MAX_FRAME_PAYLOAD_BYTES,
  parseEngineMessage,
  ProtocolError,
} from '../main/protocol';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

describe('frame framing', () => {
  it('round-trips all header fields big-endian', () => {
    const seq = 0x01020304;
    const displayId = 0x00a1b2c3;
    const ts = 1_729_999_999_123;
    const frame = encodeFrame(seq, displayId, ts, JPEG);

    expect(frame.byteLength).toBe(FRAME_HEADER_SIZE + JPEG.byteLength);
    expect(frame.readUInt8(0)).toBe(1);
    expect(frame.readUInt8(1)).toBe(1);
    expect(frame.readUInt32BE(2)).toBe(seq);
    expect(frame.readUInt32BE(6)).toBe(displayId);
    expect(frame.readBigUInt64BE(10)).toBe(BigInt(ts));
    expect(frame.readUInt32BE(18)).toBe(JPEG.byteLength);
    expect(frame.readUInt16BE(22)).toBe(0);

    const header = decodeFrameHeader(frame);
    expect(header).toMatchObject({
      version: 1,
      msgType: 1,
      seq,
      displayId,
      ts,
      payloadLength: JPEG.byteLength,
      flags: 0,
    });

    const decoded = decodeFrame(frame);
    expect(Buffer.from(decoded.payload).equals(JPEG)).toBe(true);
  });

  it('rejects a declared payload larger than the buffer', () => {
    const frame = encodeFrame(1, 2, 3, JPEG);
    frame.writeUInt32BE(JPEG.byteLength + 10, 18);
    expect(() => decodeFrame(frame)).toThrowError(ProtocolError);
    try {
      decodeFrame(frame);
    } catch (error) {
      expect((error as ProtocolError).code).toBe('PAYLOAD_LENGTH_MISMATCH');
    }
  });

  it('rejects a declared payload smaller than the buffer', () => {
    const frame = encodeFrame(1, 2, 3, JPEG);
    frame.writeUInt32BE(JPEG.byteLength - 1, 18);
    expect(() => decodeFrame(frame)).toThrowError(ProtocolError);
  });

  it('rejects truncated headers and bad versions', () => {
    expect(() => decodeFrameHeader(Buffer.alloc(FRAME_HEADER_SIZE - 1))).toThrowError(ProtocolError);
    const frame = encodeFrame(1, 2, 3, JPEG);
    frame.writeUInt8(9, 0);
    expect(() => decodeFrameHeader(frame)).toThrowError(ProtocolError);
  });

  it('rejects payloads above the 8 MiB safety limit', () => {
    const oversized = Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES + 1);
    expect(() => encodeFrame(1, 2, 3, oversized)).toThrowError(ProtocolError);
  });

  it('rejects out-of-range sequence and timestamp fields', () => {
    expect(() => encodeFrame(-1, 1, Date.now(), JPEG)).toThrowError(ProtocolError);
    expect(() => encodeFrame(1, 1, -5, JPEG)).toThrowError(ProtocolError);
    expect(() => encodeFrame(1, 0x1_0000_0000, Date.now(), JPEG)).toThrowError(ProtocolError);
  });
});

describe('engine JSON parsing', () => {
  it('parses and clamps result messages', () => {
    const message = parseEngineMessage(
      JSON.stringify({
        type: 'result',
        seq: 42,
        display_id: 7,
        show: true,
        score: 1.4,
        category: 'explicit',
        boxes: [[1, 2, 3, 4], ['bad']],
        roi: null,
        latency_ms: 12,
        processing_ms: 9,
        superseded: false,
      }),
    );
    expect(message?.type).toBe('result');
    if (message?.type !== 'result') throw new Error('expected result');
    expect(message.score).toBe(1);
    expect(message.seq).toBe(42);
    expect(message.boxes).toEqual([[1, 2, 3, 4]]);
  });

  it('ignores malformed, unknown and non-result payloads', () => {
    expect(parseEngineMessage('not json')).toBeNull();
    expect(parseEngineMessage('[]')).toBeNull();
    expect(parseEngineMessage(JSON.stringify({ type: 'mystery' }))).toBeNull();
    expect(parseEngineMessage(JSON.stringify({ type: 'result', seq: 'x', show: true, score: 0.5 }))).toBeNull();
    expect(parseEngineMessage(JSON.stringify({ type: 'result', seq: 3, show: 'yes', score: 0.5 }))).toBeNull();
  });

  it('parses ready and pong messages', () => {
    const ready = parseEngineMessage(
      JSON.stringify({ type: 'ready', version: '0.1.0', protocol: 1, models: ['heuristic'], detector: 'heuristic' }),
    );
    expect(ready).toEqual({
      type: 'ready',
      version: '0.1.0',
      protocol: 1,
      models: ['heuristic'],
      detector: 'heuristic',
    });

    expect(parseEngineMessage(JSON.stringify({ type: 'pong', id: 4 }))).toEqual({ type: 'pong', id: 4 });
  });
});
