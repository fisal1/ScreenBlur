const { Tray, Menu } = require('electron');
const { createDotIcon, IconColor } = require('./tray-icon');

const PRESET_NAMES = Object.freeze({
  strict: 'Strict',
  balanced: 'Balanced',
  relaxed: 'Relaxed',
});

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function describeStatus(state) {
  if (state.error) return `Error: ${state.error}`;
  if (!state.ready) return 'Starting...';
  if (state.snoozedUntil > Date.now()) return `Snoozed until ${formatTime(state.snoozedUntil)}`;
  if (!state.enabled) return 'Paused';
  if (state.locked) return 'Screen locked';
  if (state.overlayVisible) return 'Content hidden';
  return 'Watching';
}

function pickIconColor(state) {
  if (state.overlayVisible) return IconColor.HIDING;
  return state.running ? IconColor.WATCHING : IconColor.INACTIVE;
}

function describeLastResult(result, thresholdPercent) {
  if (!result) return '';
  return `Score ${Math.round(result.score * 100)}% (blurs at ${thresholdPercent}%)`;
}

function sensitivityMenu(state, actions) {
  const presetPercents = Object.values(state.presets);
  const isCustom = !presetPercents.includes(state.thresholdPercent);

  return [
    ...Object.entries(state.presets).map(([key, percent]) => ({
      label: `${PRESET_NAMES[key] ?? key} - blur at ${percent}%`,
      type: 'radio',
      checked: state.thresholdPercent === percent,
      click: () => actions.setThresholdPercent(percent),
    })),
    ...(isCustom ? [{ label: `Custom - blur at ${state.thresholdPercent}%`, type: 'radio', checked: true }] : []),
    { type: 'separator' },
    { label: 'Adjust...', click: actions.openSettings },
  ];
}

/** System tray icon and menu. All actions are delegated to the `actions` callbacks. */
class TrayController {
  constructor(config, actions) {
    this.config = config;
    this.actions = actions;
    this.icons = new Map();
    this.tray = new Tray(this.iconFor(IconColor.INACTIVE));
    this.tray.on('click', actions.openSettings);
    this.lastMenuKey = null;
  }

  update(state) {
    this.tray.setImage(this.iconFor(pickIconColor(state)));
    this.tray.setToolTip(['ScreenBlur', describeStatus(state), describeLastResult(state.lastResult, state.thresholdPercent)].filter(Boolean).join('\n'));

    // Rebuilding the menu while it's open closes it, so only rebuild when its content changes.
    const menuKey = JSON.stringify([describeStatus(state), state.enabled, state.thresholdPercent, state.overlayVisible, state.testOverlay, state.snoozedUntil > Date.now()]);
    if (menuKey === this.lastMenuKey) return;
    this.lastMenuKey = menuKey;
    this.tray.setContextMenu(this.buildMenu(state));
  }

  destroy() {
    this.tray.destroy();
  }

  iconFor(color) {
    const key = color.join(',');
    if (!this.icons.has(key)) this.icons.set(key, createDotIcon(color));
    return this.icons.get(key);
  }

  buildMenu(state) {
    const { actions, config } = this;
    const snoozed = state.snoozedUntil > Date.now();

    return Menu.buildFromTemplate([
      { label: describeStatus(state), enabled: false },
      { type: 'separator' },
      {
        label: 'Protection enabled',
        type: 'checkbox',
        checked: state.enabled,
        accelerator: config.hotkeys.toggle,
        click: actions.toggleEnabled,
      },
      { label: `Sensitivity (${state.thresholdPercent}%)`, submenu: sensitivityMenu(state, actions) },
      {
        label: 'Snooze',
        submenu: [
          ...config.snoozeMinutes.map((minutes) => ({
            label: `${minutes} minutes`,
            click: () => actions.snooze(minutes),
          })),
          { type: 'separator' },
          { label: 'Resume now', enabled: snoozed, click: actions.endSnooze },
        ],
      },
      {
        label: 'This was wrong (hide overlay)',
        enabled: state.overlayVisible,
        accelerator: config.hotkeys.dismiss,
        click: actions.dismiss,
      },
      {
        label: 'Test overlay',
        type: 'checkbox',
        checked: state.testOverlay,
        accelerator: config.hotkeys.testOverlay,
        click: actions.toggleTestOverlay,
      },
      { type: 'separator' },
      { label: 'Settings...', click: actions.openSettings },
      { label: 'Quit ScreenBlur', click: actions.quit },
    ]);
  }
}

module.exports = { TrayController };
