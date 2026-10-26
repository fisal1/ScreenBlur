import { app, Menu, nativeImage, Tray, type MenuItem } from 'electron';

// 32x32 white rounded-square "shield" with a diagonal slash. Kept inline so
// the tray works before any asset pipeline runs. macOS treats it as a template
// image; other platforms use the white glyph as-is.
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAgUlEQVR42u2X2w0AIQgE7b/VK4Jr4B5gZnkkkvjnLqNixLVOTAkzuyKjJCkKQyXfgiBWse1Bn2XYDy+kqGcpAJX8Se/yJgDePFIAvvRygD+tFMCjkwF4NRKAyHwcQAKLbqcKQFmozFXKABjxHsx8DVs0JOUtWYumtEVb3uJjciIjbojjC2WswqeeAAAAAElFTkSuQmCC';

export interface TraySnapshot {
  engine: string;
  capture: string;
  paused: boolean;
  launchAtLogin: boolean;
}

export interface TrayManagerOptions {
  getSnapshot: () => TraySnapshot;
  onTogglePause: () => void;
  onTestOverlay: () => void;
  onOpenSettings: () => void;
  onRestartEngine: () => void;
  onToggleLaunchAtLogin: (enabled: boolean) => void;
  onQuit: () => void;
}

function makeIcon(): Electron.NativeImage {
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`);
  const size = process.platform === 'darwin' ? 16 : 20;
  const resized = image.resize({ width: size, height: size, quality: 'best' });
  if (process.platform === 'darwin') resized.setTemplateImage(true);
  return resized;
}

export class TrayManager {
  private readonly options: TrayManagerOptions;
  private tray: Tray | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(options: TrayManagerOptions) {
    this.options = options;
    this.create();
  }

  /** Refresh tooltip and menu; coalesces bursts of status changes. */
  update(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 250);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  private create(): void {
    this.tray = new Tray(makeIcon());
    this.tray.setToolTip('ScreenBlur');

    if (process.platform !== 'darwin') {
      // macOS uses the tray menu (its left click opens the menu); other
      // platforms open the settings window on a normal click.
      this.tray.on('click', () => this.options.onOpenSettings());
    } else {
      this.tray.on('double-click', () => this.options.onOpenSettings());
    }

    this.refresh();
  }

  private refresh(): void {
    const tray = this.tray;
    if (!tray || tray.isDestroyed()) return;

    const snapshot = this.options.getSnapshot();
    const pausedLabel = snapshot.paused ? 'Resume monitoring' : 'Pause monitoring';
    const status = `${snapshot.paused ? 'Paused' : 'Monitoring'} · Engine: ${snapshot.engine} · Capture: ${snapshot.capture}`;
    tray.setToolTip(`ScreenBlur\n${status}`);

    const menu = Menu.buildFromTemplate([
      { label: `Engine: ${snapshot.engine}`, enabled: false },
      { label: `Capture: ${snapshot.capture}`, enabled: false },
      { type: 'separator' },
      { label: pausedLabel, click: () => this.options.onTogglePause() },
      { label: 'Test overlay', click: () => this.options.onTestOverlay() },
      { label: 'Open settings…', click: () => this.options.onOpenSettings() },
      { type: 'separator' },
      { label: 'Restart engine', click: () => this.options.onRestartEngine() },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: snapshot.launchAtLogin,
        click: (item: MenuItem) => this.options.onToggleLaunchAtLogin(item.checked),
      },
      { type: 'separator' },
      { label: `ScreenBlur ${app.getVersion()}`, enabled: false },
      { label: 'Quit ScreenBlur', click: () => this.options.onQuit() },
    ]);

    tray.setContextMenu(menu);
  }
}
