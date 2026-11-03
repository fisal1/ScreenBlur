// Picks the fastest working ONNX Runtime execution provider (GPU via DirectML, CoreML or CUDA,
// or CPU) by timing a few runs of the model at the real input size.
const os = require('node:os');

const BACKEND_LABELS = Object.freeze({
  dml: ({ deviceId }) => `GPU ${deviceId} (DirectML)`,
  coreml: () => 'Apple GPU / Neural Engine (CoreML)',
  cuda: () => 'NVIDIA GPU (CUDA)',
  cpu: () => 'CPU',
});

function describeBackend(backend) {
  return BACKEND_LABELS[backend.name]?.(backend) ?? backend.name.toUpperCase();
}

/**
 * Threads for CPU inference: half the logical cores, 2 to 4. Measured on a 16-thread Ryzen 7
 * 4800H: 4 threads were ~10-12% faster than 2 (640x352: 51 -> 45 ms); more threads stop helping
 * and take CPU from everything else.
 */
function cpuThreadCount() {
  const cpus = os.cpus()?.length || 4;
  return Math.max(2, Math.min(4, Math.floor(cpus / 2)));
}

function sessionOptions(backend) {
  const options = {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    logSeverityLevel: 3, // hide "some nodes were not assigned" warnings
  };
  if (backend.name === 'dml') options.enableMemPattern = false; // required by DirectML
  if (backend.name === 'cpu') options.intraOpNumThreads = cpuThreadCount();
  return options;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeRuns(ort, session, { width, height }, runs) {
  const feed = () => ({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * width * height), [1, 3, height, width]) });
  await session.run(feed()); // warm-up (first run compiles GPU kernels)
  const times = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    await session.run(feed());
    times.push(performance.now() - started);
  }
  return median(times);
}

/**
 * @returns { session, backend, label, medianMs, attempts: [{ label, medianMs } | { label, error }] }
 */
async function createFastestSession(ort, modelPath, inputSize, backends, runs) {
  const attempts = [];
  let best = null;

  for (const backend of backends) {
    const label = describeBackend(backend);
    let session;
    try {
      session = await ort.InferenceSession.create(modelPath, sessionOptions(backend));
      const medianMs = await timeRuns(ort, session, inputSize, runs);
      attempts.push({ label, medianMs });
      if (!best || medianMs < best.medianMs) {
        await best?.session.release();
        best = { session, backend, label, medianMs };
        session = null;
      }
    } catch (err) {
      attempts.push({ label, error: String(err?.message ?? err).slice(0, 120) });
    } finally {
      await session?.release();
    }
  }

  if (!best) throw new Error(`No execution provider worked: ${JSON.stringify(attempts)}`);
  return { ...best, attempts };
}

/**
 * Loads the first backend that works, in order, without trying the rest. Used once the fastest
 * backend is known: every backend that is loaded keeps some driver memory even after release.
 * @returns same shape as createFastestSession
 */
async function createFirstWorkingSession(ort, modelPath, inputSize, backends, runs) {
  const attempts = [];
  for (const backend of backends) {
    const label = describeBackend(backend);
    let session;
    try {
      session = await ort.InferenceSession.create(modelPath, sessionOptions(backend));
      const medianMs = await timeRuns(ort, session, inputSize, runs);
      attempts.push({ label, medianMs });
      return { session, backend, label, medianMs, attempts };
    } catch (err) {
      attempts.push({ label, error: String(err?.message ?? err).slice(0, 120) });
      await session?.release();
    }
  }
  throw new Error(`No execution provider worked: ${JSON.stringify(attempts)}`);
}

module.exports = { createFastestSession, createFirstWorkingSession, describeBackend };
