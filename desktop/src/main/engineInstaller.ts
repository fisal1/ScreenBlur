import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { get } from 'node:http';
import { get as getHttps } from 'node:https';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

import { Logger, logger as defaultLogger } from './logger';

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface InstallProgress {
  received: number;
  total: number | null;
  percent: number | null;
}

export interface InstallOptions {
  userDataDir: string;
  downloadUrl?: string;
  sha256?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (progress: InstallProgress) => void;
  logger?: Logger;
}

export function installerConfig(env: NodeJS.ProcessEnv = process.env): {
  downloadUrl: string;
  sha256: string;
} | null {
  const downloadUrl = env.SCREENBLUR_ENGINE_DOWNLOAD_URL?.trim() ?? '';
  const sha256 = env.SCREENBLUR_ENGINE_SHA256?.trim() ?? '';
  if (!downloadUrl || !/^[a-f0-9]{64}$/i.test(sha256)) return null;
  try {
    const parsed = new URL(downloadUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return { downloadUrl, sha256 };
}

/**
 * Optional release-asset downloader. Used only when the app has no bundled
 * engine and the build was configured with SCREENBLUR_ENGINE_DOWNLOAD_URL and
 * SCREENBLUR_ENGINE_SHA256. SHA-256 is verified before the binary is moved
 * into userData/bin.
 */
export async function installEngine(options: InstallOptions): Promise<string | null> {
  const env = options.env ?? process.env;
  const config = installerConfig(env);
  const logger = options.logger ?? defaultLogger;
  if (!config) {
    logger.debug('app', 'Engine installer not configured; skipping download');
    return null;
  }

  const expected = config.sha256.toLowerCase();
  const target = join(
    options.userDataDir,
    'bin',
    process.platform === 'win32' ? 'screenblur-engine.exe' : 'screenblur-engine',
  );
  const temp = `${target}.download-${process.pid}`;
  mkdirSync(join(options.userDataDir, 'bin'), { recursive: true });

  logger.info('app', 'Downloading ScreenBlur engine (configured release asset)');

  try {
    await download(config.downloadUrl, temp, 0, options.onProgress);
    const digest = await hashFile(temp);
    if (digest.toLowerCase() !== expected) {
      throw new Error(`SHA-256 mismatch (expected ${expected}, got ${digest})`);
    }
    chmodSync(temp, 0o755);
    renameSync(temp, target);
    logger.info('app', 'Engine download verified and installed');
    return target;
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Ignore cleanup failure.
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error('app', `Engine download failed: ${message}`);
    return null;
  }
}

function download(
  url: string,
  destination: string,
  redirects: number,
  onProgress: ((progress: InstallProgress) => void) | undefined,
  requestCount = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (requestCount > 3) {
      reject(new Error('Too many download attempts'));
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Invalid download URL'));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error('Only http(s) downloads are allowed'));
      return;
    }

    const getter = parsed.protocol === 'https:' ? getHttps : get;
    const request = getter(
      parsed,
      {
        timeout: 30_000,
        headers: { 'user-agent': 'ScreenBlur-Desktop', accept: 'application/octet-stream' },
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error('Too many redirects'));
            return;
          }
          const next = new URL(response.headers.location, parsed).toString();
          download(next, destination, redirects + 1, onProgress, requestCount + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`Download failed with HTTP ${status}`));
          return;
        }

        const totalHeader = response.headers['content-length'];
        const total = totalHeader ? Number.parseInt(totalHeader, 10) : null;
        let received = 0;

        const file = createWriteStream(destination, { mode: 0o755 });
        const overallTimer = setTimeout(() => {
          file.destroy(new Error('Download timed out'));
          response.destroy();
        }, DOWNLOAD_TIMEOUT_MS);

        response.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (total && total > 0) {
            onProgress?.({
              received,
              total,
              percent: Math.min(100, Math.round((received / total) * 100)),
            });
          } else {
            onProgress?.({ received, total: null, percent: null });
          }
        });

        response.on('error', (error) => {
          clearTimeout(overallTimer);
          file.destroy();
          reject(error);
        });
        file.on('error', (error) => {
          clearTimeout(overallTimer);
          reject(error);
        });
        file.on('finish', () => {
          clearTimeout(overallTimer);
          resolve();
        });

        response.pipe(file);
      },
    );

    request.on('timeout', () => request.destroy(new Error('Download request timed out')));
    request.on('error', (error) => reject(error));
  });
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
