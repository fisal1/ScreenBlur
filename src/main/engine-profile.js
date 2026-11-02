// Turns the user's engine settings (detection model + performance mode) into concrete choices.
const { getModel } = require('../inference/models');

const PERFORMANCE_MODES = Object.freeze({
  // GPU when available, full model input, up to 30 updates/s.
  best: Object.freeze({ id: 'best', name: 'Best (GPU)' }),
  // CPU only (~200 MB less memory, no GPU power draw), smaller input, up to 15 updates/s.
  // Measured on a Ryzen 7 4800H at 640x352: NudeNet / EraX nano ~36 ms per frame.
  light: Object.freeze({ id: 'light', name: 'Light (CPU, less memory)' }),
});

const LIGHT_MODE = Object.freeze({
  backends: Object.freeze([Object.freeze({ name: 'cpu' })]),
  modelInputLongSide: 640,
  fps: 15,
  maxInFlight: 1,
});

function getPerformanceMode(id) {
  return PERFORMANCE_MODES[id] ?? PERFORMANCE_MODES.best;
}

/**
 * @param config app config (src/main/config.js)
 * @param settings { modelId, performanceMode }
 * @returns { model, mode, backends, modelInput, capture }
 */
function resolveEngine(config, { modelId, performanceMode }) {
  const model = getModel(modelId);
  const mode = getPerformanceMode(performanceMode);
  if (mode.id === 'light') {
    return {
      model,
      mode,
      backends: LIGHT_MODE.backends,
      modelInput: { ...config.modelInput, longSide: LIGHT_MODE.modelInputLongSide },
      capture: { ...config.capture, fps: LIGHT_MODE.fps, maxInFlight: LIGHT_MODE.maxInFlight },
    };
  }
  return { model, mode, backends: config.inference.backends, modelInput: config.modelInput, capture: config.capture };
}

module.exports = { PERFORMANCE_MODES, getPerformanceMode, resolveEngine };
