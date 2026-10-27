/// <reference lib="webworker" />
// Image analysis worker: receives downscaled tiles (ImageBitmaps), assembles the analysis image,
// computes the feature grid and contours off the UI thread. The assembled RGBA stays here so
// a contour-sensitivity change re-runs only the contour stage.

import { computeGrid, extractContours, type ContourOptions, type RGBAImage } from './features';

let img: RGBAImage | null = null;
let canvas: OffscreenCanvas | null = null;

type Msg =
  | { type: 'begin'; width: number; height: number }
  | { type: 'tile'; x: number; bitmap: ImageBitmap }
  | { type: 'analyze'; cols: number; rows: number; contours: ContourOptions; id: number }
  | { type: 'contours'; contours: ContourOptions; id: number };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === 'begin') {
      img = { width: m.width, height: m.height, data: new Uint8ClampedArray(m.width * m.height * 4) };
      canvas = null;
    } else if (m.type === 'tile') {
      if (!img) throw new Error('tile before begin');
      const { bitmap } = m;
      if (!canvas || canvas.width < bitmap.width || canvas.height < bitmap.height) canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const c = canvas.getContext('2d', { willReadFrequently: true })!;
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.drawImage(bitmap, 0, 0);
      const d = c.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const w = Math.min(bitmap.width, img.width - m.x);
      for (let y = 0; y < Math.min(bitmap.height, img.height); y++) {
        img.data.set(d.subarray(y * bitmap.width * 4, (y * bitmap.width + w) * 4), (y * img.width + m.x) * 4);
      }
      bitmap.close();
    } else if (m.type === 'analyze') {
      if (!img) throw new Error('nothing to analyse');
      (self as unknown as Worker).postMessage({ type: 'progress', stage: 'features', id: m.id });
      const grid = computeGrid(img, m.cols, m.rows);
      (self as unknown as Worker).postMessage({ type: 'progress', stage: 'contours', id: m.id });
      const gestures = extractContours(img, m.contours);
      const bufs = [grid.count, grid.lum, grid.lum2, grid.sat, grid.hueX, grid.hueY, grid.grad, grid.gradV, grid.gradH, grid.hist].map((a) => a.buffer);
      (self as unknown as Worker).postMessage({ type: 'result', id: m.id, grid, gestures }, bufs as ArrayBuffer[]);
    } else if (m.type === 'contours') {
      if (!img) throw new Error('nothing to analyse');
      (self as unknown as Worker).postMessage({ type: 'contours', id: m.id, gestures: extractContours(img, m.contours) });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', id: (m as { id?: number }).id ?? -1, message: String((err as Error)?.message ?? err) });
  }
};
