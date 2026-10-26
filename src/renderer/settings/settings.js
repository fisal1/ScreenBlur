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
};

let presetButtons = [];

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
  if (overlayVisible) return 'Content is hidden right now.';
  if (scorePercent >= thresholdPercent) return 'Above the threshold - the blur will appear.';
  return 'Below the threshold - nothing is hidden.';
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
}

elements.slider.addEventListener('input', () => applyThreshold(Number(elements.slider.value)));
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
  api.onUpdate(render);
});
