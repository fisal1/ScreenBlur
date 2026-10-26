import type { LogEntry, LogLevel, LogSource } from '../shared/types';

const MAX_ENTRIES = 500;
const TOKEN_PATTERNS = [
  /(token=)[A-Za-z0-9._~+/=-]+/gi,
  /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /("token"\s*:\s*")[^"]+(")/gi,
];

/**
 * In-memory log ring buffer. Tokens are redacted before anything is stored so
 * the settings log viewer cannot leak the per-launch engine token.
 */
export class Logger {
  private entries: LogEntry[] = [];
  private secrets = new Set<string>();
  private listeners = new Set<(entry: LogEntry) => void>();

  addSecret(secret: string): void {
    if (secret.length >= 8) this.secrets.add(secret);
  }

  log(level: LogLevel, source: LogSource, message: string): void {
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      source,
      message: this.redact(message).slice(0, 4000),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A broken listener must never break logging.
      }
    }
    if (process.env.NODE_ENV !== 'production' || process.env.SCREENBLUR_DEBUG) {
      const line = `[${entry.source}] ${entry.message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
  }

  debug(source: LogSource, message: string): void {
    this.log('debug', source, message);
  }

  info(source: LogSource, message: string): void {
    this.log('info', source, message);
  }

  warn(source: LogSource, message: string): void {
    this.log('warn', source, message);
  }

  error(source: LogSource, message: string): void {
    this.log('error', source, message);
  }

  getEntries(limit = MAX_ENTRIES): LogEntry[] {
    const bounded = Math.max(1, Math.min(MAX_ENTRIES, Math.trunc(limit)));
    return this.entries.slice(-bounded);
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  redact(message: string): string {
    let result = message;
    for (const secret of this.secrets) {
      if (secret.length >= 8) result = result.split(secret).join('[redacted]');
    }
    for (const pattern of TOKEN_PATTERNS) {
      result = result.replace(pattern, (_match, prefix: string, suffix = '') => `${prefix}[redacted]${suffix}`);
    }
    return result;
  }
}

export const logger = new Logger();
