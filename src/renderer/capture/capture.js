'use strict';

const { WorkerMessage, CaptureCommand, INFERENCE_PORT_CHANNEL } = window.screenblur;
const video = document.getElementById('screen');

let pipeline = null;
let pendingPort = null;
let resumeRequested = false;

function reportError(err) {
  window.screenblur.reportStatus('error', String(err?.message ?? err));
}

async function openScreenStream(sourceId, maxSize, maxFrameRate) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: maxSize,
        maxHeight: maxSize,
        maxFrameRate,
      },
    },
  });
}

async function open({ sourceId, settings }) {
  // Capture at the model input size: the frame is scaled once, by the capturer, and reading
  // smaller frames back from the GPU is much faster.
  const { width, height } = settings.inputSize;
  const stream = await openScreenStream(sourceId, Math.max(width, height), settings.maxStreamFps);
  stream.getVideoTracks()[0].addEventListener('ended', () => reportError('Screen capture stream ended'));
  video.srcObject = stream;
  await video.play();

  pipeline = new CapturePipeline(new FrameSampler(video, settings), settings, { WorkerMessage, onError: reportError });
  if (pendingPort) pipeline.setPort(pendingPort);
  if (resumeRequested) pipeline.resume();
  window.screenblur.reportStatus('info', `capturing ${video.videoWidth}x${video.videoHeight}`);
}

const commandHandlers = {
  [CaptureCommand.OPEN]: (command) => open(command),
  [CaptureCommand.RESUME]: () => {
    resumeRequested = true;
    pipeline?.resume();
  },
  [CaptureCommand.PAUSE]: () => {
    resumeRequested = false;
    pipeline?.pause();
  },
  [CaptureCommand.PROBE]: ({ id }) => {
    window.screenblur.reportProbe(id, pipeline ? pipeline.sampler.magentaFraction() : 0);
  },
};

window.screenblur.onCommand((command) => {
  Promise.resolve(commandHandlers[command.type]?.(command)).catch(reportError);
});

// The inference port can arrive before the stream is open (and again after a worker restart).
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.channel !== INFERENCE_PORT_CHANNEL || !event.ports[0]) return;
  pendingPort = event.ports[0];
  pipeline?.setPort(pendingPort);
});
