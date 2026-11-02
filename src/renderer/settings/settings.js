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
  models: document.getElementById('models'),
  modes: document.getElementById('modes'),
  engineStatus: document.getElementById('engine-status'),
  patchStyles: document.getElementById('patch-styles'),
  patchPreview: document.getElementById('patch-preview'),
  patchName: document.getElementById('patch-name'),
  choosePatch: document.getElementById('choose-patch'),
  previewPatch: document.getElementById('preview-patch'),
  coverSizes: document.getElementById('cover-sizes'),
  coverSizeHint: document.getElementById('cover-size-hint'),
};

const COVER_SIZE_HINTS = Object.freeze({
  normal: 'Covers the detected part plus a small margin.',
  large: 'Bigger margin; covers that touch join into one, so nothing shows between them.',
  body: 'Also spreads over the body around each detected part (belly, chest, hips).',
});

function describeCoverSize({ coverSize, bodyContextAvailable }) {
  if (coverSize === 'body' && !bodyContextAvailable) return 'The selected model can\'t detect surrounding body parts, so this works like Large.';
  return COVER_SIZE_HINTS[coverSize] ?? '';
}

function renderCoverSize(patch) {
  elements.coverSizes.replaceChildren(...patch.coverSizes.map((size) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = size.name;
    button.className = size.id === patch.coverSize ? 'active' : '';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(size.id === patch.coverSize));
    button.addEventListener('click', () => api.setCoverSize(size.id));
    return button;
  }));
  elements.coverSizeHint.textContent = describeCoverSize(patch);
}

let renderedPatchKey = null;

function describePatch({ style, customName }) {
  if (style === 'blur') return 'Blur of the content underneath';
  if (style === 'custom' && customName) return customName;
  return 'Default GIF';
}

/** Cover style buttons and a preview of the image (or blur) that covers detected areas. */
function renderPatch(patch) {
  const key = JSON.stringify(patch);
  if (key === renderedPatchKey) return; // avoid reloading the preview image on every update
  renderedPatchKey = key;

  elements.patchStyles.replaceChildren(...patch.styles.map((style) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = style.name;
    button.className = style.id === patch.style ? 'active' : '';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(style.id === patch.style));
    button.addEventListener('click', () => api.setPatchStyle(style.id));
    return button;
  }));

  elements.patchPreview.classList.toggle('blur', !patch.imageUrl);
  if (patch.imageUrl) {
    const image = document.createElement('img');
    image.src = patch.imageUrl;
    image.alt = '';
    elements.patchPreview.replaceChildren(image);
  } else {
    elements.patchPreview.replaceChildren();
  }
  elements.patchName.textContent = describePatch(patch);
  elements.patchName.title = describePatch(patch);
  renderCoverSize(patch);
}

elements.choosePatch.addEventListener('click', () => api.choosePatchImage());
elements.previewPatch.addEventListener('click', () => api.previewPatch());

/** Builds the model and performance choices; clicking one asks main to apply it (restarts). */
function renderEngineChoices({ models, modelId, performanceModes, performanceMode }) {
  elements.models.replaceChildren(...models.map((model) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `choice${model.id === modelId ? ' active' : ''}`;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(model.id === modelId));
    const name = document.createElement('span');
    name.className = 'choice-name';
    name.textContent = model.name;
    const description = document.createElement('span');
    description.className = 'choice-description';
    description.textContent = model.description;
    button.append(name, description);
    button.addEventListener('click', () => model.id !== modelId && api.setModel(model.id));
    return button;
  }));

  elements.modes.replaceChildren(...performanceModes.map((mode) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = mode.name;
    button.className = mode.id === performanceMode ? 'active' : '';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(mode.id === performanceMode));
    button.addEventListener('click', () => mode.id !== performanceMode && api.setPerformanceMode(mode.id));
    return button;
  }));
}

function renderEngineStatus({ models, modelId, backend, msPerFrame }) {
  const modelName = models.find((model) => model.id === modelId)?.name ?? modelId;
  if (!backend) {
    elements.engineStatus.textContent = `Starting ${modelName}...`;
    return;
  }
  const timing = msPerFrame === null ? '' : `, ${msPerFrame} ms per check`;
  elements.engineStatus.textContent = `Running ${modelName} on ${backend}${timing}.`;
}

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
  renderEngineStatus(state.engine);
  renderPatch(state.patch);
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
  renderEngineChoices(state.engine);
  renderEngineStatus(state.engine);
  renderPatch(state.patch);
  api.onUpdate(render);
});
