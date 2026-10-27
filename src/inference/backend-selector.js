// Picks the fastest working ONNX Runtime execution provider (GPU via DirectML, or CPU)
// by timing a few runs of the model at the real input size.

function describeBackend({ name, deviceId }) {
  return name === 'dml' ? `GPU ${deviceId} (DirectML)` : name.toUpperCase();
}

function sessionOptions(backend) {
  const options = {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    logSeverityLevel: 3, // hide "some nodes were not assigned" warnings
  };
  if (backend.name === 'dml') options.enableMemPattern = false; // required by DirectML
  if (backend.name === 'cpu') options.intraOpNumThreads = 2;
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

module.exports = { createFastestSession, describeBackend };
