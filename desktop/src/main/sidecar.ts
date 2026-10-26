import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import type { EngineState } from '../shared/types';
import { Logger, logger as defaultLogger } from './logger';

const STARTUP_TIMEOUT_MS = 20_000;
const MAX_RESTART_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30_000;
const STABLE_RESET_MS = 30_000;

export interface SidecarOptions {
  appPath: string;
  userDataDir: string;
  resourcesPath: string;
  isPackaged: boolean;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

interface ResolvedEngine {
  command: string;
  args: string[];
  cwd: string;
  label: string;
}

export interface SidecarTarget {
  url: string;
  token: string;
  managed: boolean;
}

function binaryName(): string {
  return process.platform === 'win32' ? 'screenblur-engine.exe' : 'screenblur-engine';
}

/**
 * Owns the Python engine process (or an external engine URL in development).
 *
 * Lifecycle:
 *  - spawn, parse `PORT=` from stdout before the 20s startup deadline
 *  - stream logs into the redacting ring buffer
 *  - restart with exponential backoff (1s..30s) up to five times
 *  - kill the whole process group on stop/quit
 */
export class SidecarManager extends EventEmitter {
  private readonly options: SidecarOptions;
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private token = '';
  private child: ChildProcess | null = null;
  private state: EngineState = 'stopped';
  private port: number | null = null;
  private pid: number | null = null;
  private restartAttempts = 0;
  private lastError: string | null = null;
  private stopping = false;
  private external = false;
  private externalUrl = '';
  private readonly expectedExits = new WeakSet<ChildProcess>();
  private startTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private readonly handleProcessExit = (): void => {
    const child = this.child;
    if (child) this.killChildSync(child);
  };

  constructor(options: SidecarOptions) {
    super();
    this.options = options;
    this.logger = options.logger ?? defaultLogger;
    this.env = options.env ?? process.env;
    process.once('exit', this.handleProcessExit);

    if (this.env.SCREENBLUR_ENGINE_URL) {
      this.external = true;
      this.externalUrl = this.env.SCREENBLUR_ENGINE_URL;
      this.state = 'external';
      try {
        const parsed = new URL(this.externalUrl);
        const port = Number.parseInt(parsed.port, 10);
        if (Number.isInteger(port) && port > 0) this.port = port;
      } catch {
        // Invalid URLs are reported by the WebSocket client.
      }
      const fromEnv = this.env.SCREENBLUR_ENGINE_TOKEN ?? '';
      this.token = fromEnv || this.tokenFromUrl(this.externalUrl);
      if (this.token) this.logger.addSecret(this.token);
      if (!this.token) {
        this.logger.warn('sidecar', 'External engine URL has no token; waiting for engine to accept an unauthenticated connection');
      }
    } else {
      this.token = randomBytes(32).toString('hex');
      this.logger.addSecret(this.token);
    }
  }

  get stateValue(): EngineState {
    return this.state;
  }

  get enginePort(): number | null {
    return this.port;
  }

  get enginePid(): number | null {
    return this.pid;
  }

  get isExternal(): boolean {
    return this.external;
  }

  get attempts(): number {
    return this.restartAttempts;
  }

  get error(): string | null {
    return this.lastError;
  }

  getTarget(): SidecarTarget | null {
    if (this.external) {
      return { url: this.externalUrl, token: this.token, managed: false };
    }
    if (this.port === null) return null;
    return {
      url: `ws://127.0.0.1:${this.port}/ws/stream`,
      token: this.token,
      managed: true,
    };
  }

  /** Start (or resume starting) the engine. Safe to call more than once. */
  start(): void {
    this.stopping = false;
    this.clearTimer('restart');
    if (this.external) {
      this.state = 'external';
      this.emitState();
      const target = this.getTarget();
      if (target) this.emit('port', target);
      return;
    }
    if (this.child || this.state === 'starting') return;

    this.restartAttempts = 0;
    this.lastError = null;
    this.spawnEngine();
  }

  /** Manual restart: kill the current child and start from a clean backoff. */
  restart(): void {
    this.logger.info('sidecar', 'Engine restart requested');
    this.stopProcessOnly();
    this.restartAttempts = 0;
    this.lastError = null;
    this.stopping = false;
    this.setState('restarting');
    if (this.external) {
      const target = this.getTarget();
      if (target) this.emit('port', target);
      this.setState('external');
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnEngine();
    }, 150);
  }

  /** Stop and stay stopped. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimer('start');
    this.clearTimer('restart');
    this.clearTimer('stable');
    const child = this.child;
    this.child = null;
    this.pid = null;
    this.port = null;
    if (child) await this.killChild(child);
    this.setState('stopped');
  }

  async dispose(): Promise<void> {
    await this.stop();
    process.removeListener('exit', this.handleProcessExit);
    this.removeAllListeners();
  }

  private spawnEngine(): void {
    if (this.stopping) return;

    const resolved = this.resolveEngine();
    if (!resolved) {
      this.lastError =
        'No ScreenBlur engine found. Build engine/dist/screenblur-engine, install one into userData/bin, or run the Python engine from engine/.';
      this.logger.error('sidecar', this.lastError);
      this.setState('error');
      return;
    }

    this.setState('starting');
    this.logger.info('sidecar', `Starting engine: ${resolved.label}`);

    let child: ChildProcess;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: resolved.cwd,
        env: {
          ...this.env,
          SCREENBLUR_HOST: '127.0.0.1',
          SCREENBLUR_PORT: '0',
          SCREENBLUR_TOKEN: this.token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      this.handleSpawnFailure(error);
      return;
    }

    this.child = child;
    this.pid = child.pid ?? null;
    this.port = null;

    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.child !== child || this.port !== null) return;
      this.lastError = 'Engine did not report a PORT within 20s';
      this.logger.error('sidecar', this.lastError);
      this.terminateChild(child);
      this.scheduleRestart(this.lastError);
    }, STARTUP_TIMEOUT_MS);

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => this.handleStdout(line, child));
    }
    if (child.stderr) {
      const lines = createInterface({ input: child.stderr });
      lines.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const message = this.logger.redact(trimmed);
        this.logger.warn('engine', message);
        this.emit('log', { level: 'warn', message });
      });
    }

    child.on('error', (error) => {
      this.expectedExits.add(child);
      this.handleSpawnFailure(error);
    });

    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.pid = null;
        this.port = null;
      }
      this.clearTimer('start');
      this.clearTimer('stable');
      const expected = this.expectedExits.delete(child);
      const reason = `Engine exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
      this.logger.warn('sidecar', reason);
      this.emit('exit', { code, signal });
      if (this.stopping) {
        this.setState('stopped');
        return;
      }
      if (expected) return;
      this.lastError = reason;
      this.setState('error');
      this.scheduleRestart(reason);
    });
  }

  private handleSpawnFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = `Could not start engine: ${message}`;
    this.logger.error('sidecar', this.lastError);
    this.clearTimer('start');
    this.setState('error');
    this.scheduleRestart(this.lastError);
  }

  private handleStdout(line: string, child: ChildProcess): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    const portMatch = /^PORT=(\d{1,5})$/.exec(trimmed);
    if (portMatch) {
      const port = Number.parseInt(portMatch[1] ?? '', 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        this.logger.warn('sidecar', `Ignoring invalid engine port line: ${trimmed}`);
        return;
      }
      if (this.child !== child) return;
      this.clearTimer('start');
      this.port = port;
      this.lastError = null;
      this.setState('running');
      this.logger.info('sidecar', `Engine listening on 127.0.0.1:${port}`);
      const target = this.getTarget();
      if (target) this.emit('port', target);

      this.clearTimer('stable');
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.state === 'running') this.restartAttempts = 0;
      }, STABLE_RESET_MS);
      return;
    }

    const tokenMatch = /^TOKEN=(.+)$/.exec(trimmed);
    if (tokenMatch?.[1]) {
      // Only relevant when connecting to an engine that generated its own token.
      const token = tokenMatch[1].trim();
      if (!this.env.SCREENBLUR_TOKEN && token.length >= 8) {
        this.token = token;
        this.logger.addSecret(token);
        this.logger.info('sidecar', 'Adopted engine-generated token');
      }
      return;
    }

    this.logger.info('engine', this.logger.redact(trimmed));
    this.emit('log', { level: 'info', message: this.logger.redact(trimmed) });
  }

  private scheduleRestart(reason: string): void {
    if (this.stopping || this.external) return;
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.lastError = `${reason} (giving up after ${MAX_RESTART_ATTEMPTS} restart attempts)`;
      this.logger.error('sidecar', this.lastError);
      this.setState('error');
      return;
    }

    this.restartAttempts += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.restartAttempts - 1));
    this.lastError = reason;
    this.setState('restarting');
    this.logger.warn(
      'sidecar',
      `Restarting engine in ${Math.round(delay / 100) / 10}s (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`,
    );

    this.clearTimer('restart');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnEngine();
    }, delay);
  }

  private stopProcessOnly(): void {
    this.clearTimer('start');
    this.clearTimer('restart');
    this.clearTimer('stable');
    const child = this.child;
    this.child = null;
    this.pid = null;
    this.port = null;
    if (child) {
      this.expectedExits.add(child);
      void this.killChild(child);
    }
  }

  private terminateChild(child: ChildProcess): void {
    this.child = null;
    this.pid = null;
    this.port = null;
    this.expectedExits.add(child);
    void this.killChild(child);
  }

  /** Best-effort synchronous kill used from the process `exit` handler. */
  private killChildSync(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;

    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } catch {
        // Process already gone.
      }
      return;
    }

    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Process already gone.
      }
    }
  }

  private async killChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.killed) return;
    const pid = child.pid;
    if (pid === undefined) return;

    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } catch {
        child.kill();
      }
      return;
    }

    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
    }

    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
        resolveExit();
      }, 3000);

      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  private resolveEngine(): ResolvedEngine | null {
    const bin = binaryName();
    const candidates = [
      join(this.options.resourcesPath, 'engine', bin),
      join(this.options.userDataDir, 'bin', bin),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return {
          command: candidate,
          args: ['--port', '0'],
          cwd: dirname(candidate),
          label: candidate,
        };
      }
    }

    // Development: run the Python module from the repository engine folder.
    if (!this.options.isPackaged) {
      const overrideDir = this.env.SCREENBLUR_ENGINE_DIR;
      const engineDir = overrideDir
        ? resolve(overrideDir)
        : resolve(this.options.appPath, '..', 'engine');
      if (existsSync(join(engineDir, 'app', 'main.py'))) {
        const python = this.resolvePython(engineDir);
        return {
          command: python,
          args: ['-m', 'app.main', '--port', '0'],
          cwd: engineDir,
          label: `${python} -m app.main (cwd ${engineDir})`,
        };
      }
      this.logger.debug('sidecar', `No development engine at ${engineDir}`);
    }

    return null;
  }

  /**
   * Prefer the engine's local virtualenv so `npm run dev` works after following
   * the README setup, then fall back to an explicit override or the PATH.
   */
  private resolvePython(engineDir: string): string {
    if (this.env.SCREENBLUR_PYTHON) return this.env.SCREENBLUR_PYTHON;
    const venvPython =
      process.platform === 'win32'
        ? join(engineDir, '.venv', 'Scripts', 'python.exe')
        : join(engineDir, '.venv', 'bin', 'python');
    if (existsSync(venvPython)) return venvPython;
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private tokenFromUrl(raw: string): string {
    try {
      return new URL(raw).searchParams.get('token') ?? '';
    } catch {
      return '';
    }
  }

  private setState(state: EngineState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private emitState(): void {
    this.emit('state', this.state);
  }

  private clearTimer(kind: 'start' | 'restart' | 'stable'): void {
    const timer = kind === 'start' ? this.startTimer : kind === 'restart' ? this.restartTimer : this.stableTimer;
    if (timer) clearTimeout(timer);
    if (kind === 'start') this.startTimer = null;
    else if (kind === 'restart') this.restartTimer = null;
    else this.stableTimer = null;
  }
}
