// Turns detections (model input pixels) into the areas to cover: grown to the surrounding body
// (optional), padded, merged where they touch, normalized to the captured screen (0..1), each
// with a tiny averaged-color mosaic used to draw the blur.
const { growBox, padBox, boxesTouch, unionBox } = require('../shared/geometry');

/**
 * Grows an explicit area to include the body-part detections around it (belly, armpits,
 * covered chest or hips...), so the cover spans the body rather than just the detected part.
 * Only context boxes within `reach` (fraction of the area's size) of the area are added; this
 * is a single pass so it can't chain from one person to the next.
 */
function expandWithContext(box, contextDetections, reach) {
  const nearby = growBox(box, reach);
  return contextDetections.reduce((result, { box: other }) => (boxesTouch(nearby, other) ? unionBox(result, other) : result), box);
}

/** Merges areas that overlap or touch into one, keeping the highest score and its label. */
function mergeTouching(areas) {
  const merged = [...areas];
  for (let i = 0; i < merged.length; i++) {
    for (let j = i + 1; j < merged.length; j++) {
      if (!boxesTouch(merged[i].box, merged[j].box)) continue;
      const [stronger, weaker] = merged[i].score >= merged[j].score ? [merged[i], merged[j]] : [merged[j], merged[i]];
      merged[i] = { ...stronger, box: unionBox(stronger.box, weaker.box) };
      merged.splice(j, 1);
      j = i; // the bigger box may now touch earlier ones
    }
  }
  return merged;
}

/**
 * The areas to cover, in model input pixels.
 * @param detections explicit detections ({ box, score, label })
 * @param contextDetections non-explicit body-part detections ({ box }), used when bodyContext is on
 * @param content the screen area inside the (letterboxed) frame
 * @param coverage { padding, merge, bodyContext, contextReach } (see main/cover-size.js)
 */
function coverAreas(detections, contextDetections, content, { padding, merge = false, bodyContext = false, contextReach = 0.6 }) {
  let areas = detections.map((detection) => ({
    ...detection,
    box: bodyContext ? expandWithContext(detection.box, contextDetections, contextReach) : detection.box,
  }));
  areas = areas.map((area) => ({ ...area, box: padBox(area.box, padding, content) }));
  if (merge) areas = mergeTouching(areas);
  return areas.filter(({ box }) => box.width >= 1 && box.height >= 1);
}

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
 * @param detections explicit detections, boxes in model input pixels
 * @param frame { rgba, width, contentWidth, contentHeight } - the screen occupies the top-left
 *        contentWidth x contentHeight of the frame; the rest is padding
 * @param options coverage options (see coverAreas) plus mosaicCells
 * @param contextDetections non-explicit body-part detections for bodyContext
 */
function toScreenRegions(detections, frame, options, contextDetections = []) {
  const content = { x: 0, y: 0, width: frame.contentWidth, height: frame.contentHeight };
  return coverAreas(detections, contextDetections, content, options)
    .map(({ score, label, box }) => ({
      score,
      label,
      box: {
        x: box.x / content.width,
        y: box.y / content.height,
        width: box.width / content.width,
        height: box.height / content.height,
      },
      mosaic: mosaic(frame.rgba, frame.width, box, options.mosaicCells),
    }));
}

module.exports = { mosaic, toScreenRegions, coverAreas, expandWithContext, mergeTouching };
