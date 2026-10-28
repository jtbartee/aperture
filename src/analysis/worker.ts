/// <reference lib="webworker" />
// Image analysis worker: receives downscaled tiles (ImageBitmaps), assembles the analysis image,
// computes the feature grid and contours off the UI thread. The assembled RGBA stays here (one
// per asset) so a contour-setting change re-runs only the contour stage.

import type { ContourSettings } from '../core/types';
import { computeGrid, gridBuffers, type RGBAImage } from './features';
import { extractContourSet } from './contours';

const images = new Map<string, RGBAImage>();
let canvas: OffscreenCanvas | null = null;

type Msg =
  | { type: 'begin'; asset: string; width: number; height: number }
  | { type: 'tile'; asset: string; x: number; bitmap: ImageBitmap }
  | { type: 'analyze'; asset: string; cols: number; rows: number; contours: ContourSettings; id: number }
  | { type: 'contours'; asset: string; contours: ContourSettings; id: number };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    if (m.type === 'begin') {
      images.set(m.asset, { width: m.width, height: m.height, data: new Uint8ClampedArray(m.width * m.height * 4) });
      // keep the most recent image and panorama only
      while (images.size > 2) images.delete(images.keys().next().value!);
      canvas = null;
    } else if (m.type === 'tile') {
      const img = images.get(m.asset);
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
      const img = images.get(m.asset);
      if (!img) throw new Error('nothing to analyse');
      post({ type: 'progress', stage: 'features', id: m.id });
      const grid = computeGrid(img, m.cols, m.rows);
      post({ type: 'progress', stage: 'contours', id: m.id });
      const contours = extractContourSet(img, m.contours);
      post({ type: 'result', id: m.id, grid, contours }, gridBuffers(grid));
    } else if (m.type === 'contours') {
      const img = images.get(m.asset);
      if (!img) throw new Error('nothing to analyse');
      post({ type: 'contours', id: m.id, contours: extractContourSet(img, m.contours) });
    }
  } catch (err) {
    post({ type: 'error', id: (m as { id?: number }).id ?? -1, message: String((err as Error)?.message ?? err) });
  }
};
