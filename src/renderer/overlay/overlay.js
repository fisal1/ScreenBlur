'use strict';

const api = window.screenblurOverlay;
const container = document.getElementById('regions');
const elements = new Map(); // region id -> { root, canvas, region }
const patchImageUrl = new URLSearchParams(window.location.search).get('patch') || '';

let motion = { renderDelayMs: 16, maxLeadMs: 200 };
let animationFrame = null;

/** A patch shows the GIF when one is installed, otherwise a blur of the content underneath. */
function createRegionElement() {
  const root = document.createElement('div');
  root.className = 'region';
  let canvas = null;
  if (patchImageUrl) {
    const image = document.createElement('img');
    image.src = patchImageUrl;
    image.alt = '';
    root.append(image);
  } else {
    canvas = document.createElement('canvas');
    root.append(canvas);
  }
  container.append(root);
  return { root, canvas };
}

function drawMosaic(canvas, { cols, rows, data }) {
  canvas.width = cols;
  canvas.height = rows;
  canvas.getContext('2d').putImageData(new ImageData(Uint8ClampedArray.from(data), cols, rows), 0, 0);
}

function placeRegion(root, { x, y, width, height }) {
  root.style.left = `${x * 100}%`;
  root.style.top = `${y * 100}%`;
  root.style.width = `${width * 100}%`;
  root.style.height = `${height * 100}%`;
}

function isMoving({ velocity }) {
  return velocity.x !== 0 || velocity.y !== 0;
}

/** Repositions every patch for the current time; keeps running while any patch moves. */
function animate() {
  animationFrame = null;
  const now = Date.now();
  let moving = false;
  for (const { root, region } of elements.values()) {
    placeRegion(root, api.sweptBox(region, now, motion));
    moving ||= isMoving(region);
  }
  if (moving) animationFrame = requestAnimationFrame(animate);
}

function render({ regions, motion: motionOptions }) {
  motion = motionOptions;
  const seen = new Set();
  for (const region of regions) {
    seen.add(region.id);
    let element = elements.get(region.id);
    if (!element) {
      element = createRegionElement();
      elements.set(region.id, element);
    }
    element.region = region;
    if (element.canvas && region.mosaic) drawMosaic(element.canvas, region.mosaic);
  }
  for (const [id, element] of elements) {
    if (seen.has(id)) continue;
    element.root.remove();
    elements.delete(id);
  }

  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animate();
}

api.onRender(render);
