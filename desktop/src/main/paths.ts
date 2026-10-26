import type { BrowserWindow } from 'electron';
import { join } from 'node:path';

export type RendererPage = 'renderer' | 'capture' | 'overlay';

/**
 * Resolve a renderer page either from the Vite dev server or the built
 * `dist/renderer` directory. Vite preserves the page folder layout.
 */
export function pageUrl(page: RendererPage): { type: 'url'; value: string } | { type: 'file'; value: string } {
  const devServer = process.env.SCREENBLUR_DEV_SERVER_URL;
  if (devServer) {
    return { type: 'url', value: `${devServer.replace(/\/$/, '')}/${page}/index.html` };
  }
  return { type: 'file', value: join(__dirname, '..', '..', 'dist', 'renderer', page, 'index.html') };
}

export async function loadPage(window: BrowserWindow, page: RendererPage): Promise<void> {
  const target = pageUrl(page);
  if (target.type === 'url') {
    await window.loadURL(target.value);
  } else {
    await window.loadFile(target.value);
  }
}

export function preloadPath(name: 'index' | 'capture' | 'overlay'): string {
  return join(__dirname, '..', 'preload', `${name}.js`);
}
