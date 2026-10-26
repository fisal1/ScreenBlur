/**
 * Cross-stack integration test: spawn the real Python sidecar and drive it
 * through the TypeScript WebSocket client and binary frame encoder.
 *
 * The test skips when the engine virtualenv is not installed, so `npm test`
 * still works in a desktop-only environment.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { encodeFrame } from '../main/protocol';
import { WsClient } from '../main/wsClient';
import type { EngineResultMessage, PongMessage, ReadyMessage } from '../shared/types';

const engineDir = resolve(process.cwd(), '..', 'engine');
const python =
  process.platform === 'win32'
    ? join(engineDir, '.venv', 'Scripts', 'python.exe')
    : join(engineDir, '.venv', 'bin', 'python');
const engineAvailable = existsSync(python) && existsSync(join(engineDir, 'app', 'main.py'));

// Valid 8x8 JPEG with a skin-tone-ish colour (enough to exercise decoding).
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0KiiivnD6M//Z',
  'base64',
);

interface StartedEngine {
  child: ChildProcessWithoutNullStreams;
  port: number;
  token: string;
}

function startEngine(): Promise<StartedEngine> {
  const child = spawn(python, ['-m', 'app.main', '--port', '0'], {
    cwd: engineDir,
    env: { ...process.env, SCREENBLUR_LOG_LEVEL: 'warning' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolveStart, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`Engine did not start in time:\n${output}`));
    }, 20_000);

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };

    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const port = output.match(/^PORT=(\d+)$/m);
      const token = output.match(/^TOKEN=(\S+)$/m);
      if (port && token) {
        cleanup();
        resolveStart({ child, port: Number(port[1]), token: token[1] ?? '' });
      }
    };

    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Engine exited early (code ${code}):\n${output}`));
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

function waitFor<T>(register: (resolve: (value: T) => void) => () => void, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolveValue, reject) => {
    const timer = setTimeout(() => {
      unregister();
      reject(new Error('Timed out waiting for engine message'));
    }, timeoutMs);
    const unregister = register((value) => {
      clearTimeout(timer);
      unregister();
      resolveValue(value);
    });
  });
}

async function stopEngine(engine: StartedEngine | null): Promise<void> {
  if (!engine) return;
  const { child } = engine;
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

describe.skipIf(!engineAvailable)('engine integration', () => {
  it(
    'completes ready -> frame -> result -> pong through WsClient',
    async () => {
      let engine: StartedEngine | null = null;
      const client = new WsClient({
        url: '',
        token: '',
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 5_000,
        readyTimeoutMs: 10_000,
        reconnectBaseMs: 60_000,
        reconnectMaxMs: 60_000,
      });

      try {
        engine = await startEngine();
        const url = `ws://127.0.0.1:${engine.port}/ws/stream`;
        const readyPromise = waitFor<ReadyMessage>((resolveReady) => {
          client.once('ready', resolveReady);
          return () => client.off('ready', resolveReady);
        });
        const resultPromise = waitFor<EngineResultMessage>((resolveResult) => {
          const listener = (result: EngineResultMessage): void => {
            if (result.seq === 1) resolveResult(result);
          };
          client.on('result', listener);
          return () => client.off('result', listener);
        });
        // Heartbeats are sent by the client itself; a pong also proves that
        // engine -> client control messages flow through the same socket.
        const pongPromise = waitFor<PongMessage>((resolvePong) => {
          const listener = (pong: PongMessage): void => {
            if (pong.id >= 1) resolvePong(pong);
          };
          client.on('pong', listener);
          return () => client.off('pong', listener);
        });

        client.connect(url, engine.token);
        const ready = await readyPromise;
        expect(ready.type).toBe('ready');
        expect(ready.protocol).toBe(1);
        expect(ready.detector.length).toBeGreaterThan(0);

        const sent = client.sendFrame(encodeFrame(1, 1, Date.now(), JPEG), 1);
        expect(sent).toBe(true);

        const result = await resultPromise;
        expect(result.seq).toBe(1);
        expect(result.show).toBeTypeOf('boolean');
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);

        await expect(pongPromise).resolves.toMatchObject({ type: 'pong' });
      } finally {
        client.dispose();
        await stopEngine(engine);
      }
    },
    30_000,
  );
});
