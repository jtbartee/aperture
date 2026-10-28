// Main-thread side of image analysis: decode with safeguards, build a multiresolution set
// (overview, display, analysis), stream analysis tiles to the worker, and cache results per asset.

import type { ContourSettings } from '../core/types';
import { computeGrid, type FeatureGrid, type RGBAImage } from './features';
import { extractContourSet, type ContourSet } from './contours';

export interface ImageLevels {
  width: number;
  height: number;
  /** for scrolling / display: height-limited (panorama) or size-limited (image) */
  display: ImageBitmap;
  /** whole-image overview strip */
  overview: ImageBitmap;
}

export interface AnalysisResult {
  grid: FeatureGrid;
  contours: ContourSet;
  analysisWidth: number;
  analysisHeight: number;
  /** the settings the current contours were traced with (so a stale trace is detected) */
  contourSettings: ContourSettings;
}

const MAX_PIXELS = 150e6; // ~600 MB decoded; beyond this, decoding is likely to fail or freeze
const levels = new Map<string, ImageLevels>();
const results = new Map<string, AnalysisResult>();
/** main-thread fallback keeps the analysis pixels so contours can be re-run without a worker */
const fallbackPixels = new Map<string, RGBAImage>();

export const getLevels = (assetId: string) => levels.get(assetId);
export const getAnalysis = (assetId: string) => results.get(assetId);

export class AnalysisCancelled extends Error { constructor() { super('Analysis cancelled'); } }

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  if (!/^image\//.test(blob.type) && blob.type !== '') throw new Error(`"${blob.type}" is not an image this browser can decode. Use JPG, PNG, WebP or GIF.`);
  let bmp: ImageBitmap;
  try {
    // GIFs decode to their first frame (documented still-frame behaviour)
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new Error(`The browser could not decode this image (${(e as Error).message || 'unknown error'}). Very large panoramas may exceed the browser's limit — try exporting it at under 20,000 px wide as a JPG.`);
  }
  if (bmp.width * bmp.height > MAX_PIXELS) {
    const w = bmp.width, h = bmp.height;
    bmp.close();
    throw new Error(`This image is ${w}×${h} (${Math.round((w * h) / 1e6)} MP), above the ${MAX_PIXELS / 1e6} MP safety limit. Resize it (keeping the aspect ratio) and import again.`);
  }
  return bmp;
}

export async function buildLevels(assetId: string, bmp: ImageBitmap, kind: 'image' | 'panorama'): Promise<ImageLevels> {
  const { width: W, height: H } = bmp;
  const dispH = kind === 'panorama' ? Math.min(H, 720) : Math.min(H, Math.round(H * Math.min(1, 1600 / Math.max(W, H))));
  let dispW = Math.round((W * dispH) / H);
  if (dispW > 16000) dispW = 16000; // keep display bitmaps inside GPU texture limits
  const display = await createImageBitmap(bmp, { resizeWidth: dispW, resizeHeight: Math.round((dispW * H) / W) || 1, resizeQuality: 'high' });
  const ovW = Math.min(W, 2048);
  const overview = await createImageBitmap(bmp, { resizeWidth: ovW, resizeHeight: Math.max(1, Math.round((ovW * H) / W)), resizeQuality: 'medium' });
  const lv = { width: W, height: H, display, overview };
  const old = levels.get(assetId);
  if (old) { old.display.close(); old.overview.close(); }
  levels.set(assetId, lv);
  return lv;
}

export interface AnalyzeOptions {
  kind: 'image' | 'panorama';
  contours: ContourSettings;
  onProgress?: (f: number, stage: string) => void;
  signal?: AbortSignal;
}

let worker: Worker | null = null;
let msgId = 0;
function getWorker(): Worker | null {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  if (!worker) worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return worker;
}
function resetWorker() { worker?.terminate(); worker = null; }

function analysisSize(W: number, H: number, kind: 'image' | 'panorama') {
  if (kind === 'panorama') {
    const ah = Math.min(H, 288);
    const aw = Math.min(6144, Math.round((W * ah) / H));
    return { aw, ah: Math.max(16, Math.round((aw * H) / W)) };
  }
  const s = Math.min(1, 560 / Math.max(W, H));
  return { aw: Math.max(16, Math.round(W * s)), ah: Math.max(16, Math.round(H * s)) };
}

/** Analyse an image: tiles are cut from the full-resolution bitmap and downscaled one at a time,
 *  so a 15 000 px panorama is analysed at full height-resolution without one giant resize. */
export async function analyzeBitmap(assetId: string, bmp: ImageBitmap, o: AnalyzeOptions): Promise<AnalysisResult> {
  const { width: W, height: H } = bmp;
  const { aw, ah } = analysisSize(W, H, o.kind);
  const cols = o.kind === 'panorama' ? Math.min(aw, 1024) : Math.min(aw, 192);
  const rows = o.kind === 'panorama' ? 32 : 24;
  const nTiles = Math.max(1, Math.ceil(aw / 1024));
  const w = getWorker();
  const check = () => { if (o.signal?.aborted) throw new AnalysisCancelled(); };
  if (!w) {
    // fallback: main thread, with yields between tiles
    const cv = document.createElement('canvas');
    cv.width = aw; cv.height = ah;
    const c = cv.getContext('2d', { willReadFrequently: true })!;
    for (let t = 0; t < nTiles; t++) {
      check();
      const sx = Math.floor((t * W) / nTiles), ex = Math.floor(((t + 1) * W) / nTiles);
      const dx = Math.floor((t * aw) / nTiles), dw = Math.floor(((t + 1) * aw) / nTiles) - dx;
      c.drawImage(bmp, sx, 0, ex - sx, H, dx, 0, dw, ah);
      o.onProgress?.((t + 1) / nTiles * 0.5, 'tiles');
      await new Promise((r) => setTimeout(r, 0));
    }
    const img: RGBAImage = { width: aw, height: ah, data: c.getImageData(0, 0, aw, ah).data };
    o.onProgress?.(0.6, 'features');
    await new Promise((r) => setTimeout(r, 0));
    const grid = computeGrid(img, cols, rows);
    check();
    o.onProgress?.(0.85, 'contours');
    const contours = extractContourSet(img, o.contours);
    fallbackPixels.set(assetId, img);
    const res = { grid, contours, analysisWidth: aw, analysisHeight: ah, contourSettings: o.contours };
    results.set(assetId, res);
    o.onProgress?.(1, 'done');
    return res;
  }
  const id = ++msgId;
  return new Promise<AnalysisResult>((resolve, reject) => {
    const onAbort = () => { resetWorker(); reject(new AnalysisCancelled()); };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') o.onProgress?.(m.stage === 'features' ? 0.6 : 0.85, m.stage);
      else if (m.type === 'result') {
        o.signal?.removeEventListener('abort', onAbort);
        const res = { grid: m.grid as FeatureGrid, contours: m.contours as ContourSet, analysisWidth: aw, analysisHeight: ah, contourSettings: o.contours };
        results.set(assetId, res);
        o.onProgress?.(1, 'done');
        resolve(res);
      } else if (m.type === 'error') { o.signal?.removeEventListener('abort', onAbort); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { reject(new Error(e.message || 'analysis worker failed')); resetWorker(); };
    (async () => {
      w.postMessage({ type: 'begin', asset: assetId, width: aw, height: ah });
      for (let t = 0; t < nTiles; t++) {
        check();
        const sx = Math.floor((t * W) / nTiles), ex = Math.floor(((t + 1) * W) / nTiles);
        const dx = Math.floor((t * aw) / nTiles), dw = Math.max(1, Math.floor(((t + 1) * aw) / nTiles) - dx);
        const tile = await createImageBitmap(bmp, sx, 0, ex - sx, H, { resizeWidth: dw, resizeHeight: ah, resizeQuality: 'medium' });
        w.postMessage({ type: 'tile', asset: assetId, x: dx, bitmap: tile }, [tile]);
        o.onProgress?.(((t + 1) / nTiles) * 0.5, 'tiles');
      }
      w.postMessage({ type: 'analyze', asset: assetId, cols, rows, contours: o.contours, id });
    })().catch((e) => reject(e));
  });
}

/** Re-run only the contour stage with new settings (the worker kept the analysis image). */
export function rerunContours(assetId: string, contours: ContourSettings): Promise<ContourSet> {
  const prev = results.get(assetId);
  if (!prev) return Promise.reject(new Error('Analyse the image first'));
  const px = fallbackPixels.get(assetId);
  if (px) { prev.contours = extractContourSet(px, contours); prev.contourSettings = contours; return Promise.resolve(prev.contours); }
  const w = getWorker();
  if (!w) return Promise.reject(new Error('Analyse the image first'));
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'contours') { prev.contours = m.contours; prev.contourSettings = contours; resolve(m.contours); }
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.postMessage({ type: 'contours', asset: assetId, contours, id });
  });
}

/** True when the cached contours were traced with different settings. */
export function contoursStale(assetId: string, s: ContourSettings): boolean {
  const r = results.get(assetId);
  return !!r && JSON.stringify(r.contourSettings) !== JSON.stringify(s);
}

export function forgetAsset(assetId: string) {
  const lv = levels.get(assetId);
  if (lv) { lv.display.close(); lv.overview.close(); }
  levels.delete(assetId);
  results.delete(assetId);
  fallbackPixels.delete(assetId);
}

/** RGBA (from the procedural generators) → PNG blob, for factory projects. */
export async function rgbaToPng(img: RGBAImage): Promise<Blob> {
  const data = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d')!.putImageData(data, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(data, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
}
