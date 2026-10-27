// PANORAMA: the image is scanned over time. ONE mapping — scanPoint(t) — decides which image
// position corresponds to a moment of the piece; the scrolling viewport, the analysed strip and
// the generated events all use it, which is what keeps sight and sound aligned.

import type { PanoramaSettings, PanoramaSource, ProjectSettings, Region, Role } from '../core/types';
import { hash32, rng } from '../core/rng';
import { barBeats } from '../core/time';
import { type FeatureGrid, bandMask, bitsMask, fullMask, regionCurve, type MaskFn } from '../analysis/features';
import { instrument } from '../audio/patches';
import { curveLane, generateRole } from './roles';
import { imageHarmony } from './imageModes';
import { fxSlot, layer, type LayerOutput, PALETTE } from './layers';

export function defaultPanoramaSettings(): PanoramaSettings {
  return {
    timing: 'free', seconds: 120, bars: 32, direction: 'ltr', region: { x0: 0, x1: 1 }, path: [],
    scanResolution: 256, stripWidth: 0.5, sensitivity: 0.55, density: 0.5, smoothing: 0.4, polyphony: 5, threshold: 0.45,
    quantize: 4, seed: 1,
  };
}

export function defaultRegions(): Region[] {
  return [
    { id: 'reg_upper', name: 'Upper image', role: 'pad', band: { y0: 0, y1: 0.34 }, trackId: '', enabled: true },
    { id: 'reg_middle', name: 'Middle image', role: 'melody', band: { y0: 0.33, y1: 0.67 }, trackId: '', enabled: true },
    { id: 'reg_lower', name: 'Lower image', role: 'bass', band: { y0: 0.66, y1: 1 }, trackId: '', enabled: true },
    { id: 'reg_detail', name: 'Fine detail (whole frame)', role: 'percussion', band: { y0: 0, y1: 1 }, trackId: '', enabled: false },
    { id: 'reg_drone', name: 'Lower image drone', role: 'drone', band: { y0: 0.5, y1: 1 }, trackId: '', enabled: false },
  ];
}

/** Total length of the panorama scan in beats. FREE TIME keeps seconds fixed (so the bar count
 *  follows the tempo); BEAT SYNC keeps bars fixed (so the duration follows the tempo). */
export function panoramaBeats(s: PanoramaSettings, ps: Pick<ProjectSettings, 'bpm' | 'timeSig'>): number {
  if (s.timing === 'beat') return s.bars * barBeats(ps.timeSig);
  return (s.seconds * ps.bpm) / 60;
}

/** Beats the display maps across the image: the generated length if any, else the settings. */
export function displayBeats(s: PanoramaSettings, ps: Pick<ProjectSettings, 'bpm' | 'timeSig'>): number {
  return s.genBeats ?? panoramaBeats(s, ps);
}

export function panoramaSeconds(s: PanoramaSettings, ps: Pick<ProjectSettings, 'bpm' | 'timeSig'>): number {
  return (panoramaBeats(s, ps) * 60) / ps.bpm;
}

/** Normalised image position (x, and y for paths) for normalised musical time t ∈ [0, 1]. */
export function scanPoint(t: number, s: PanoramaSettings): { x: number; y?: number } {
  const u = Math.max(0, Math.min(1, t));
  switch (s.direction) {
    case 'rtl': return { x: 1 - u };
    case 'pingpong': return { x: u < 0.5 ? u * 2 : 2 - u * 2 };
    case 'region': return { x: s.region.x0 + u * (s.region.x1 - s.region.x0) };
    case 'path': {
      const p = s.path;
      if (p.length < 2) return { x: u };
      // arc-length parameterisation so the scan speed is constant along the drawn path
      const seg: number[] = [0];
      for (let i = 1; i < p.length; i++) seg.push(seg[i - 1] + Math.hypot(p[i].x - p[i - 1].x, (p[i].y - p[i - 1].y) * 0.3));
      const total = seg[seg.length - 1] || 1;
      const d = u * total;
      let i = 1;
      while (i < seg.length - 1 && seg[i] < d) i++;
      const f = (d - seg[i - 1]) / Math.max(1e-9, seg[i] - seg[i - 1]);
      return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * f, y: p[i - 1].y + (p[i].y - p[i - 1].y) * f };
    }
    default: return { x: u };
  }
}

/** Inverse for the simple directions: which time first visits image position x (for click-to-seek). */
export function timeForX(x: number, s: PanoramaSettings): number {
  const u = Math.max(0, Math.min(1, x));
  switch (s.direction) {
    case 'rtl': return 1 - u;
    case 'pingpong': return u / 2;
    case 'region': return Math.max(0, Math.min(1, (u - s.region.x0) / Math.max(1e-6, s.region.x1 - s.region.x0)));
    default: return u;
  }
}

/** Horizontal viewport offset (in display pixels) that puts scan position x under the fixed playhead. */
export function viewportOffset(x: number, imageDisplayWidth: number, viewportWidth: number, playheadFrac = 0.5): number {
  return x * imageDisplayWidth - viewportWidth * playheadFrac;
}

export function regionMask(r: Region, grid: FeatureGrid): MaskFn {
  if (r.mask) return bitsMask(r.mask, grid.cols, grid.rows);
  if (r.band) return bandMask(r.band.y0, r.band.y1, grid.rows);
  return fullMask;
}

/** Vertical extent of a region in bottom-up coordinates (for pitch normalisation). */
export function regionYRange(r: Region): [number, number] {
  if (r.band) return [1 - r.band.y1, 1 - r.band.y0];
  if (r.mask) {
    let top = r.mask.rows, bot = -1;
    for (let row = 0; row < r.mask.rows; row++) for (let c = 0; c < r.mask.cols; c++) if (r.mask.bits[row * r.mask.cols + c] === '1') { top = Math.min(top, row); bot = Math.max(bot, row); }
    if (bot >= 0) return [1 - (bot + 1) / r.mask.rows, 1 - top / r.mask.rows];
  }
  return [0, 1];
}

const ROLE_PATCHES: Record<Role, string> = {
  pad: 'Glassy Ambient Pad', melody: 'Digital Mallet', bass: 'Deep Current', drone: 'Subterranean Drone', percussion: 'Drum Kit',
  texture: 'Glitch Percussion', arp: 'Soft Arpeggio Synth', chords: 'Electric Keyboard',
};

export function scanPath(s: PanoramaSettings, steps: number): { x: number; y?: number }[] {
  return Array.from({ length: steps }, (_, j) => scanPoint(steps > 1 ? j / (steps - 1) : 0, s));
}

/** Generate one layer per enabled region. Harmony comes from the whole frame along the scan, so
 *  all regions share chords. `only` regenerates a single region's layer. */
export function generatePanoramaLayers(grid: FeatureGrid, src: PanoramaSource, ps: ProjectSettings, only?: string): LayerOutput[] {
  const s = src.settings;
  const beats = panoramaBeats(s, ps);
  const n = Math.max(16, Math.round(s.scanResolution));
  const path = scanPath(s, n);
  const curveOpts = { steps: n, sensitivity: s.sensitivity, strip: s.stripWidth, smoothing: s.smoothing, path };
  const frame = regionCurve(grid, fullMask, { ...curveOpts, strip: Math.max(1, s.stripWidth * 3), smoothing: Math.max(0.5, s.smoothing) });
  const harmony = imageHarmony(frame, ps, beats, rng(hash32(`${s.seed}:pano:harmony`)));
  const out: LayerOutput[] = [];
  src.regions.forEach((r, i) => {
    if (!r.enabled) return;
    const key = `pano:${r.id}`;
    if (only && only !== key) return;
    const cv = regionCurve(grid, regionMask(r, grid), curveOpts);
    const fx = r.role === 'pad' ? [fxSlot('atmosSweep', { mix: 0.4 }, `fx_${r.id}_sweep`)] : r.role === 'melody' ? [fxSlot('pingpong', { wet: 0.2 }, `fx_${r.id}_pp`)] : [];
    const l = layer(key, `${r.name} → ${r.role}`, r.role, 'panorama', { patch: instrument(ROLE_PATCHES[r.role]), color: PALETTE[(i * 3 + 1) % PALETTE.length], fx });
    const res = generateRole({
      curve: cv, role: r.role, track: l, settings: ps, beats, harmony, rng: rng(hash32(`${s.seed}:${key}`)),
      params: { density: s.density, threshold: s.threshold, polyphony: s.polyphony, quantize: s.quantize }, origin: 'panorama',
      idPrefix: key, yRange: regionYRange(r),
    });
    l.notes = res.notes;
    l.automation = res.automation;
    if (r.role === 'pad' || r.role === 'drone') {
      l.automation = [...l.automation.filter((a) => a.target !== 'cutoff'), curveLane(cv, 'brightness', 'cutoff', beats, 0.3, 0.95, false, `auto_${r.id}_cutoff`)];
    }
    if (r.role === 'melody') l.automation.push(curveLane(cv, 'centroid', 'pan', beats, 0.25, 0.75, false, `auto_${r.id}_pan`));
    out.push(l);
  });
  return out;
}
