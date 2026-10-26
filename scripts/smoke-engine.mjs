#!/usr/bin/env node
/**
 * End-to-end smoke test for the sidecar wire protocol.
 *
 * Spawns `python -m app.main --port 0` from engine/, reads PORT/TOKEN from stdout,
 * opens the WebSocket, sends a 24-byte framed JPEG, and expects a result.
 *
 * Requires: engine dependencies installed (fastapi, uvicorn, pillow, numpy).
 * Uses the WebSocket implementation built into Node 22+.
 *
 * Usage:
 *   node scripts/smoke-engine.mjs
 *   SCREENBLUR_PYTHON=/path/to/python node scripts/smoke-engine.mjs
 *   SCREENBLUR_ENGINE_BINARY=engine/dist/screenblur-engine node scripts/smoke-engine.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = path.join(root, "engine");
const binary = process.env.SCREENBLUR_ENGINE_BINARY
  ? path.resolve(root, process.env.SCREENBLUR_ENGINE_BINARY)
  : undefined;
const python = process.env.SCREENBLUR_PYTHON ?? path.join(engineDir, ".venv", "bin", "python");
const command = binary ?? python;
const args = binary ? ["--port", "0"] : ["-m", "app.main", "--port", "0"];

// 8x8 solid JPEG (valid baseline JPEG; the engine validates markers and decodes it).
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0KiiivnD6M//Z",
  "base64",
);

function encodeFrame({ seq, displayId, ts, payload }) {
  const header = Buffer.alloc(24);
  header.writeUInt8(1, 0); // protocol version
  header.writeUInt8(1, 1); // msg_type: frame
  header.writeUInt32BE(seq >>> 0, 2);
  header.writeUInt32BE(displayId >>> 0, 6);
  header.writeBigUInt64BE(BigInt(ts), 10);
  header.writeUInt32BE(payload.length, 18);
  header.writeUInt16BE(0, 22);
  return Buffer.concat([header, payload]);
}

function waitForStartup(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for PORT/TOKEN after ${timeoutMs}ms\n${buffer}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const port = buffer.match(/^PORT=(\d+)$/m);
      const token = buffer.match(/^TOKEN=(\S+)$/m);
      if (port && token) {
        cleanup();
        resolve({ port: Number(port[1]), token: token[1] });
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Engine exited (code=${code}, signal=${signal})\n${buffer}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

async function main() {
  console.log(`[smoke] starting engine with ${command}`);
  const child = spawn(command, args, {
    cwd: engineDir,
    env: { ...process.env, SCREENBLUR_LOG_LEVEL: "warning" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk) => process.stderr.write(`[engine] ${chunk}`));

  let ws;
  try {
    const { port, token } = await waitForStartup(child, 30_000);
    const url = `ws://127.0.0.1:${port}/ws/stream?token=${token}`;
    console.log(`[smoke] connecting to ${url.replace(token, token ? "<token>" : "")}`);

    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for ready")), 10_000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "ready") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
      ws.addEventListener("close", () => reject(new Error("WebSocket closed before ready")));
    });
    console.log(`[smoke] ready: version=${ready.version} detector=${ready.detector}`);

    const seq = 1;
    ws.send(encodeFrame({ seq, displayId: 1, ts: Date.now(), payload: JPEG }));

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for result")), 10_000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "result" && msg.seq === seq) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    console.log(
      `[smoke] result: seq=${result.seq} show=${result.show} score=${result.score} latency=${result.latency_ms}ms`,
    );

    ws.send(JSON.stringify({ type: "ping", id: 7 }));
    const pong = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for pong")), 5_000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "pong") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    console.log(`[smoke] pong: id=${pong.id}`);
    console.log("[smoke] PASS");
  } finally {
    ws?.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

main().catch((error) => {
  console.error("[smoke] FAIL:", error.message);
  process.exitCode = 1;
});
