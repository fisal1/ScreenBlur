// Turns detections (model input pixels) into screen regions: padded, normalized to the
// captured screen (0..1), each with a tiny averaged-color mosaic used to draw the blur.
const { padBox } = require('../shared/geometry');

/** Averages the pixels of `box` into a cols x rows RGBA grid. */
function mosaic(rgba, frameWidth, box, cells) {
  const longSide = Math.max(box.width, box.height);
  const cols = Math.max(1, Math.round((cells * box.width) / longSide));
  const rows = Math.max(1, Math.round((cells * box.height) / longSide));
  const data = new Array(cols * rows * 4).fill(0);
  const cellWidth = box.width / cols;
  const cellHeight = box.height / rows;
  const step = Math.max(1, Math.floor(Math.min(cellWidth, cellHeight) / 4)); // sample ~16 px per cell

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor(box.x + col * cellWidth);
      const y0 = Math.floor(box.y + row * cellHeight);
      const x1 = Math.max(x0 + 1, Math.floor(box.x + (col + 1) * cellWidth));
      const y1 = Math.max(y0 + 1, Math.floor(box.y + (row + 1) * cellHeight));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const p = (y * frameWidth + x) * 4;
          r += rgba[p];
          g += rgba[p + 1];
          b += rgba[p + 2];
          count++;
        }
      }
      const out = (row * cols + col) * 4;
      data[out] = Math.round(r / count);
      data[out + 1] = Math.round(g / count);
      data[out + 2] = Math.round(b / count);
      data[out + 3] = 255;
    }
  }
  return { cols, rows, data };
}

/**
 * @param detections boxes in model input pixels
 * @param frame { rgba, width, contentWidth, contentHeight } - the screen occupies the top-left
 *        contentWidth x contentHeight of the frame; the rest is padding
 * @param options { padding, mosaicCells }
 */
function toScreenRegions(detections, frame, { padding, mosaicCells }) {
  const content = { x: 0, y: 0, width: frame.contentWidth, height: frame.contentHeight };
  return detections
    .map((detection) => ({ ...detection, box: padBox(detection.box, padding, content) }))
    .filter(({ box }) => box.width >= 1 && box.height >= 1)
    .map(({ score, label, box }) => ({
      score,
      label,
      box: {
        x: box.x / content.width,
        y: box.y / content.height,
        width: box.width / content.width,
        height: box.height / content.height,
      },
      mosaic: mosaic(frame.rgba, frame.width, box, mosaicCells),
    }));
}

module.exports = { mosaic, toScreenRegions };
