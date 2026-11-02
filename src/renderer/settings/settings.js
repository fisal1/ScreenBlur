'use strict';

const api = window.screenblurSettings;

const PRESET_NAMES = Object.freeze({ strict: 'Strict', balanced: 'Balanced', relaxed: 'Relaxed' });

const elements = {
  slider: document.getElementById('threshold-slider'),
  thresholdValue: document.getElementById('threshold-value'),
  hideValue: document.getElementById('hide-value'),
  presets: document.getElementById('presets'),
  scoreValue: document.getElementById('score-value'),
  meterFill: document.getElementById('meter-fill'),
  meterMarker: document.getElementById('meter-marker'),
  status: document.getElementById('status'),
  remoteEnabled: document.getElementById('remote-enabled'),
  remoteEndpoint: document.getElementById('remote-endpoint'),
  remoteProfile: document.getElementById('remote-profile'),
  remoteToken: document.getElementById('remote-token'),
  clearToken: document.getElementById('clear-token'),
  saveRemote: document.getElementById('save-remote'),
  remoteStatus: document.getElementById('remote-status'),
};

let presetButtons = [];
let remoteSettingsDirty = false;

function renderPresets(presets) {
  elements.presets.replaceChildren();
  presetButtons = Object.entries(presets).map(([key, percent]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${PRESET_NAMES[key] ?? key} ${percent}%`;
    button.dataset.percent = String(percent);
    button.addEventListener('click', () => applyThreshold(percent));
    elements.presets.append(button);
    return button;
  });
}

function renderThreshold(percent) {
  elements.slider.value = String(percent);
  elements.thresholdValue.textContent = `${percent}%`;
  elements.hideValue.textContent = `${Math.round(percent / 2)}%`;
  elements.meterMarker.style.left = `${percent}%`;
  for (const button of presetButtons) {
    button.classList.toggle('active', Number(button.dataset.percent) === percent);
  }
}

function describeStatus({ scorePercent, thresholdPercent, overlayVisible, running }) {
  if (!running) return 'Protection is paused.';
  if (overlayVisible) return 'Detected areas are blurred right now.';
  if (scorePercent >= thresholdPercent) return 'Above the threshold - the detected area will be blurred.';
  return 'Below the threshold - nothing is blurred.';
}

function renderLive(state) {
  if (state.scorePercent === null) return;
  const score = Math.round(state.scorePercent);
  elements.scoreValue.textContent = `${score}%`;
  elements.meterFill.style.width = `${Math.min(100, state.scorePercent)}%`;
  elements.meterFill.classList.toggle('over', state.scorePercent >= state.thresholdPercent);
  elements.status.textContent = describeStatus(state);
}

function applyThreshold(percent) {
  renderThreshold(percent);
  api.setThresholdPercent(percent);
}

let dragging = false;

function render(state) {
  // Don't fight the user's drag with an echo of their own change.
  if (!dragging) renderThreshold(state.thresholdPercent);
  renderLive(state);
  if (!remoteSettingsDirty) {
    elements.remoteEnabled.checked = state.remoteInference;
    elements.remoteEndpoint.value = state.remoteEndpoint;
    elements.remoteProfile.value = state.remoteProfile;
  }
  elements.remoteStatus.textContent = state.remoteError ??
    (state.remoteInference ? `Remote inference: ${state.remoteConnection}` : 'Local inference is active.');
}

elements.slider.addEventListener('input', () => applyThreshold(Number(elements.slider.value)));
for (const element of [elements.remoteEnabled, elements.remoteEndpoint, elements.remoteProfile, elements.clearToken]) {
  element.addEventListener('input', () => { remoteSettingsDirty = true; });
  element.addEventListener('change', () => { remoteSettingsDirty = true; });
}
elements.saveRemote.addEventListener('click', async () => {
  elements.saveRemote.disabled = true;
  elements.remoteStatus.textContent = 'Applying settings...';
  const settings = {
    enabled: elements.remoteEnabled.checked,
    endpoint: elements.remoteEndpoint.value.trim(),
    profile: elements.remoteProfile.value,
    clearToken: elements.clearToken.checked,
  };
  if (elements.remoteToken.value) settings.token = elements.remoteToken.value;
  try {
    const result = await api.setRemoteInference(settings);
    if (!result.ok) elements.remoteStatus.textContent = result.error;
    else {
      remoteSettingsDirty = false;
      elements.remoteToken.value = '';
      elements.clearToken.checked = false;
      elements.remoteStatus.textContent = 'Settings applied.';
    }
  } catch (error) {
    elements.remoteStatus.textContent = `Could not apply settings: ${error.message}`;
  } finally {
    elements.saveRemote.disabled = false;
  }
});
elements.slider.addEventListener('pointerdown', () => { dragging = true; });
for (const event of ['pointerup', 'pointercancel']) {
  elements.slider.addEventListener(event, () => { dragging = false; });
}

api.getState().then((state) => {
  elements.slider.min = String(state.range.min);
  elements.slider.max = String(state.range.max);
  renderPresets(state.presets);
  renderThreshold(state.thresholdPercent);
  renderLive(state);
  elements.remoteEnabled.checked = state.remoteInference;
  elements.remoteEndpoint.value = state.remoteEndpoint;
  elements.remoteProfile.value = state.remoteProfile;
  elements.remoteStatus.textContent = state.remoteError ??
    (state.remoteInference ? `Remote inference: ${state.remoteConnection}` : 'Local inference is active.');
  api.onUpdate(render);
});
