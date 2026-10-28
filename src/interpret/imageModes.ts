// IMAGE → music. Contour mode (default) reads the traced contours as independent voices; Colour,
// Atmospheric and Hybrid modes add colour-, light- and texture-driven layers. Every mode produces
// independent, editable layers keyed by generator id, so any single layer can be regenerated alone.

import type { FeatureKey, ImageSettings, NoteEvent, ProjectSettings } from '../core/types';
import { hash32, rng, type Rng } from '../core/rng';
import { barBeats, metricWeight } from '../core/time';
import { type Curve, type CurveKey, type FeatureGrid, type MaskFn, curveSummary, curveValue, fullMask, bandMask, regionCurve } from '../analysis/features';
import { type ContourSet, contourPreset } from '../analysis/contours';
import { type ChordSlot, type ProgressionType, generateProgression } from '../theory/progression';
import { allowedPitches, mapY, scaleIntervals } from '../theory/scales';
import { instrument } from '../audio/patches';
import { curveLane, generateRole } from './roles';
import { fxSlot, layer, type LayerOutput, ROLE_RANGE } from './layers';
import { defaultShape, textureEvents, visualEvents, type ScanSeg } from './sonify';
import { atmosphereLayer, contourVoiceLayers, contourVoiceSpecs, rhythmLayer, type SonicContext, voiceSound } from './sonicLayers';

export interface ImageAnalysis { grid: FeatureGrid; contours: ContourSet }

export function defaultImageSettings(): ImageSettings {
  return {
    ...defaultShape(),
    mode: 'contour', bars: 16, contour: contourPreset('photo'), density: 0.45, smoothing: 0.35,
    mapping: { pitch: 'brightness', velocity: 'brightness', density: 'texture', richness: 'saturation', accent: 'contrast', duration: 'texture' },
    hueRoutes: [0, 1, 2, 3, 1, 2],
    hybrid: { contour: true, atmosphere: true, bass: false, pads: false, percussion: true, filter: true },
    seed: 1,
  };
}

export const COLOR_VOICES = [
  { name: 'Colour voice A', patch: 'Plucked Synth' },
  { name: 'Colour voice B', patch: 'Digital Mallet' },
  { name: 'Colour voice C', patch: 'Electric Keyboard' },
  { name: 'Colour voice D', patch: 'Soft Arpeggio Synth' },
];

/** Generator keys of the contour voices (A and B keep their pre-sonification ids so regenerating
 *  an older project updates its existing tracks, mix and mutes included). */
export const IMAGE_VOICE_KEYS = ['image:contour:lead', 'image:contour:counter', 'image:contour:c', 'image:contour:field'];

const fv = (cv: Curve, key: FeatureKey, t01: number) => curveValue(cv, key as CurveKey | 'none', t01);

/** Harmony guided by colour: the image's dominant hue is "home"; other hues map to other degrees,
 *  colour coherence decides how strongly, saturation decides chord colour. */
export function imageHarmony(cv: Curve, ps: ProjectSettings, beats: number, r: Rng, type?: ProgressionType): ChordSlot[] {
  const s = curveSummary(cv);
  let hx = 0, hy = 0;
  for (let j = 0; j < cv.n; j++) { hx += Math.cos(cv.hue[j] * 2 * Math.PI) * cv.saturation[j]; hy += Math.sin(cv.hue[j] * 2 * Math.PI) * cv.saturation[j]; }
  let home = Math.atan2(hy, hx) / (2 * Math.PI);
  if (home < 0) home += 1;
  const n = scaleIntervals(ps.scale, ps.customScale).length;
  const t: ProgressionType = type ?? (s.brightness < 0.22 ? 'pedal' : s.variation < 0.08 && s.edges < 0.08 ? 'sparse' : s.contrast > 0.35 && s.edges > 0.15 ? 'diatonic' : 'modal');
  return generateProgression({
    type: t, beats, barBeats: barBeats(ps.timeSig), root: ps.key, scale: ps.scale, custom: ps.customScale,
    harmonicRhythm: s.variation > 0.15 ? 1 : 2, tension: Math.min(1, s.contrast * 1.4), rng: r,
    guide: (t01) => {
      const hue = curveValue(cv, 'hue', t01);
      const rel = (hue - home + 1) % 1;
      return { degree: Math.round(rel * n) % n, strength: Math.min(1, curveValue(cv, 'saturation', t01) * 1.6), colour: curveValue(cv, 'saturation', t01) };
    },
  });
}

const steps = (beats: number, perBeat: number) => Math.max(8, Math.round(beats * perBeat));

/** Image mode scans left → right once: x maps linearly onto the piece. */
function imageContext(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, beats: number): SonicContext {
  const n = steps(beats, 2);
  const segs: ScanSeg[] = [{ t0: 0, t1: beats, x0: 0, x1: 1 }];
  const curve = (mask: MaskFn, o: { strip?: number; smoothing?: number } = {}) => regionCurve(a.grid, mask, { steps: n, sensitivity: s.contour.sensitivity, strip: o.strip ?? 0.5, smoothing: o.smoothing ?? s.smoothing });
  const full = curve(fullMask);
  return {
    grid: a.grid, set: a.contours, shape: s, density: s.density, ps, beats, segs, seed: s.seed, origin: 'image', curve,
    harmony: imageHarmony(full, ps, beats, rng(hash32(`${s.seed}:image:harmony`))),
    pxWidth: a.contours.width, aspect: a.contours.width / Math.max(1, a.contours.height), res: 1 / 64,
  };
}

// ---------------------------------------------------------------------- MODE A: contour

export function contourLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, beats: number, only?: string): LayerOutput[] {
  const ctx = imageContext(a, s, ps, beats);
  const out: LayerOutput[] = [];
  const want = (k: string) => !only || only === k;
  const specs = contourVoiceSpecs(ctx, 'rank', IMAGE_VOICE_KEYS).filter((v) => want(v.key));
  out.push(...contourVoiceLayers(ctx, specs));
  if (s.hybrid.percussion && (want('image:rhythm') || want('image:hybrid:perc'))) {
    const r = rhythmLayer(ctx, 'image:rhythm', 'image:hybrid:perc');
    if (r && want(r.key)) out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------- MODE B: colour & texture

export function colorLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, beats: number): LayerOutput[] {
  const perBeat = s.density > 0.5 ? 4 : 2;
  const n = steps(beats, perBeat);
  const cv = regionCurve(a.grid, fullMask, { steps: n, sensitivity: s.contour.sensitivity, strip: 0.2, smoothing: s.smoothing * 0.5 });
  const voices = COLOR_VOICES.map((v, i) => layer(`image:color:${i}`, v.name, 'melody', 'imageColor', {
    patch: instrument(v.patch), pitch: { mode: 'scale', low: 48 + (i % 2) * 7, high: 84 - (i % 2) * 5 },
    mix: { volume: -9, pan: [-0.45, 0.45, -0.2, 0.2][i] }, color: ['#e07a6a', '#d9cf6a', '#7fcf9a', '#6fb7d6'][i],
  }));
  const r = rng(hash32(`${s.seed}:color`));
  const bb = barBeats(ps.timeSig);
  const step = 1 / perBeat;
  const pitchesFor = voices.map((v) => allowedPitches(v.pitch, ps.key, ps.scale, ps.customScale));
  const counters = voices.map(() => 0);
  const metric = s.rhythm === 'metric';
  // outside metric mode, notes may only start where the image actually changes
  const allowed = new Map<number, number>();
  if (!metric) {
    for (const e of [...visualEvents(a.grid, a.contours, s.density), ...textureEvents(a.grid)]) {
      const j = Math.min(n - 1, Math.floor(e.x * n));
      allowed.set(j, Math.max(allowed.get(j) ?? 0, e.x * beats - j * step));
    }
  }
  for (let j = 0; j < n; j++) {
    const t = (j + 0.5) / n;
    if (!metric && !allowed.has(j)) continue;
    const b = metric ? j * step : j * step + (allowed.get(j) ?? 0);
    const dens = fv(cv, s.mapping.density, t);
    const drive = dens * (0.35 + s.density * 1.1);
    if (drive < 0.1 || !r.chance(Math.min(0.95, drive * 1.4))) continue;
    const sat = cv.saturation[j] * cv.hueStrength[j];
    const sector = Math.floor(cv.hue[j] * 6) % 6;
    const vi = sat < 0.06 ? 0 : s.hueRoutes[sector] ?? 0;
    const target = voices[vi];
    const pitches = pitchesFor[vi];
    let y: number;
    if (s.mapping.pitch === 'brightness') {
      const prof = cv.profile[j];
      let best = 0;
      for (let k = 1; k < prof.length; k++) if (prof[k] > prof[best]) best = k;
      y = 1 - (best + 0.5) / prof.length;
    } else y = fv(cv, s.mapping.pitch, t);
    const mw = metric ? metricWeight(ps.timeSig, ((b % bb) + bb) % bb) : 0.5;
    const accent = fv(cv, s.mapping.accent, t) > 0.45 && mw >= 0.5 ? 0.2 : 0;
    const vel = 0.3 + fv(cv, s.mapping.velocity, t) * 0.5 + accent;
    const rich = fv(cv, s.mapping.richness, t);
    const tones = rich > 0.55 ? [0, 2, 4] : rich > 0.28 ? [0, 2] : [0];
    const durF = fv(cv, s.mapping.duration, t);
    const dur = step * (0.6 + (1 - durF) * 3.5);
    // visual variation makes the rhythm more complex: syncopated or split onsets
    const vary = cv.variation[j];
    const onsets = metric ? (dens > 0.62 && s.density > 0.4 ? [0, step / 2] : vary > 0.35 ? [step / 2] : [0]) : [0];
    for (const o of onsets) {
      for (const off of tones) {
        target.notes.push({
          id: `${target.key}_${counters[vi]++}`, start: b + o + off * 0.012, dur, midi: mapY(y, pitches, off), vel: Math.min(1, vel * (off ? 0.8 : 1)),
          origin: 'image', pitchY: y, stepOffset: off || undefined, src: [t, y],
        });
      }
    }
  }
  return voices.filter((v) => v.notes.length > 0 || v.key === 'image:color:0');
}

// ---------------------------------------------------------------------- MODE C: atmospheric

export function atmosLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, beats: number, only?: string): LayerOutput[] {
  const n = steps(beats, 1);
  const cv = regionCurve(a.grid, fullMask, { steps: n, sensitivity: s.contour.sensitivity, strip: 1.5, smoothing: Math.max(0.5, s.smoothing) });
  const sum = curveSummary(cv);
  const harmony = imageHarmony(cv, ps, beats, rng(hash32(`${s.seed}:atmos:harmony`)), sum.variation < 0.06 ? 'static' : sum.variation < 0.14 ? 'sparse' : 'modal');
  const rhythm = s.rhythm;
  const params = { density: s.density * 0.7, threshold: 0.45 + (1 - s.density) * 0.3, polyphony: 6, quantize: 0, rhythm };
  const base = { settings: ps, beats, harmony, params, origin: 'image' as const };
  const ctx = { ...imageContext(a, s, ps, beats), harmony };
  const out: LayerOutput[] = [];
  const want = (k: string) => !only || only === k;
  if (want('image:atmos:pad')) {
    const l = layer('image:atmos:pad', 'Atmos pads', 'pad', 'imageAtmos', { patch: instrument(sum.brightness > 0.45 ? 'Glassy Ambient Pad' : 'Warm Analog Pad'), fx: [fxSlot('atmosSweep', {}, 'fx_atmos_pad')], color: '#b48ee0', mix: { volume: -2 } });
    const r = generateRole({ ...base, curve: cv, role: 'pad', track: l, rng: rng(hash32(`${s.seed}:atmos:pad`)), idPrefix: l.key });
    l.notes = r.notes;
    l.automation = [curveLane(cv, 'brightness', 'cutoff', beats, 0.35, 0.95, false, 'auto_pad_cutoff'), curveLane(cv, 'texture', 'reverbSend', beats, 0.3, 1, true, 'auto_pad_verb')];
    out.push(l);
  }
  if (want('image:atmos:drone')) {
    const l = atmosphereLayer(ctx, 'image:atmos:drone', 'Atmos drone');
    if (l) out.push(l);
  }
  if (want('image:atmos:melody')) {
    const l = layer('image:atmos:melody', 'Atmos fragments', 'melody', 'imageAtmos', { patch: instrument('Bell / FM Tone'), mix: { volume: -7, reverb: 0.55, delay: 0.3 }, color: '#d9cf6a' });
    l.notes = atmosFragments(cv, l.pitch, ps, beats, s.density, rng(hash32(`${s.seed}:atmos:mel`)), l.key);
    if (s.synth === 'image') voiceSound(ctx, l, 'shimmer', fullMask, cv, 'Bell / FM Tone');
    out.push(l);
  }
  if (want('image:atmos:texture') && sum.edges > 0.04) {
    const l = rhythmLayer({ ...ctx, shape: { ...s, rhythm: rhythm === 'metric' ? 'metric' : 'texture' }, density: s.density * 0.6 }, 'image:atmos:texture', 'image:atmos:texture');
    if (l) { l.name = 'Atmos grain'; l.automation = [...l.automation, curveLane(cv, 'centroid', 'pan', beats, 0.2, 0.8, false, 'auto_tex_pan')]; out.push(l); }
  }
  return out;
}

/** Sparse fragments placed on the image's luminous features: beats where brightness stands out
 *  from its surroundings (glows) score highest, edges and visual change add to the score. How
 *  many fragments there are follows the overall light and activity, so a dark, uniform frame
 *  stays almost silent while a soft haze still gets a few long, bell-like notes. */
function atmosFragments(cv: Curve, pitch: LayerOutput['pitch'], ps: ProjectSettings, beats: number, density: number, r: Rng, key: string): NoteEvent[] {
  const pitches = allowedPitches(pitch, ps.key, ps.scale, ps.customScale);
  const sum = curveSummary(cv);
  const at = (k: CurveKey, b: number) => curveValue(cv, k, b / beats);
  const cands: { b: number; score: number }[] = [];
  for (let b = 0; b < beats - 2; b += 1) {
    let local = 0;
    for (let d = -4; d <= 4; d++) local += at('brightness', Math.max(0, Math.min(beats, b + d)));
    const prominence = at('brightness', b) - local / 9;
    cands.push({ b, score: prominence * 4 + at('edges', b) * 2 + at('variation', b) * 3 + r() * 0.02 });
  }
  const count = Math.round((beats / 8) * (0.4 + density) * (1 + sum.edges * 6 + sum.variation * 10) * Math.min(1, sum.brightness * 3));
  cands.sort((a, z) => z.score - a.score);
  const chosen: number[] = [];
  for (const c of cands) {
    if (chosen.length >= count) break;
    if (chosen.every((x) => Math.abs(x - c.b) >= 3)) chosen.push(c.b);
  }
  return chosen.sort((a, z) => a - z).map((b, i) => {
    const y = Math.max(0, Math.min(1, at('centroid', b)));
    return { id: `${key}_${i}`, start: b, dur: 3 + r() * 3, midi: mapY(y, pitches), vel: 0.35 + at('brightness', b) * 0.45, origin: 'image' as const, pitchY: y, src: [b / beats, y] as [number, number] };
  });
}

// ---------------------------------------------------------------------- HYBRID

export function hybridLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, beats: number, only?: string): LayerOutput[] {
  const out: LayerOutput[] = [];
  const want = (k: string) => !only || only.startsWith(k);
  const n = steps(beats, 2);
  const ctx = imageContext(a, s, ps, beats);
  const full = ctx.curve(fullMask);
  const base = { settings: ps, beats, harmony: ctx.harmony, origin: 'image' as const };
  if (s.hybrid.contour) out.push(...contourVoiceLayers(ctx, contourVoiceSpecs(ctx, 'rank', IMAGE_VOICE_KEYS).filter((v) => want(v.key))));
  if (s.hybrid.atmosphere && want('image:atmos:bed')) {
    const l = atmosphereLayer(ctx, 'image:atmos:bed', 'Image atmosphere');
    if (l) {
      if (s.hybrid.filter && s.synth !== 'image') l.automation = [...l.automation, curveLane(full, 'brightness', 'cutoff', beats, 0.3, 0.95, false, 'auto_hybrid_bed_cutoff')];
      out.push(l);
    }
  }
  if (s.hybrid.bass && want('image:hybrid:bass')) {
    // low-frequency structure of the bottom third → bass
    const low = regionCurve(a.grid, bandMask(0.66, 1, a.grid.rows), { steps: n, sensitivity: s.contour.sensitivity, strip: 2, smoothing: Math.max(0.6, s.smoothing) });
    const l = layer('image:hybrid:bass', 'Low structure → bass', 'bass', 'imageTexture', { color: '#6a8de0' });
    l.notes = generateRole({ ...base, curve: low, role: 'bass', track: l, rng: rng(hash32(`${s.seed}:hybrid:bass`)), params: { density: s.density, threshold: 0.4, polyphony: 1, quantize: 2, rhythm: s.rhythm }, idPrefix: l.key, yRange: [0, 0.34] }).notes;
    out.push(l);
  }
  if (s.hybrid.pads && want('image:hybrid:pads')) {
    const l = layer('image:hybrid:pads', 'Colour regions → pads', 'pad', 'imageColor', { color: '#b48ee0' });
    l.notes = generateRole({ ...base, curve: full, role: 'pad', track: l, rng: rng(hash32(`${s.seed}:hybrid:pads`)), params: { density: s.density, threshold: 0.5, polyphony: 5, quantize: 0, rhythm: s.rhythm }, idPrefix: l.key }).notes;
    if (s.hybrid.filter) l.automation = [curveLane(full, 'brightness', 'cutoff', beats, 0.3, 0.95, false, 'auto_hybrid_cutoff')];
    out.push(l);
  }
  if (s.hybrid.percussion && (want('image:rhythm') || want('image:hybrid:perc'))) {
    const l = rhythmLayer(ctx, 'image:rhythm', 'image:hybrid:perc');
    if (l && (!only || only === l.key)) out.push(l);
  }
  return out;
}

export function generateImageLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, only?: string): LayerOutput[] {
  const beats = s.bars * barBeats(ps.timeSig);
  let layers: LayerOutput[];
  switch (s.mode) {
    case 'contour': layers = contourLayers(a, s, ps, beats, only); break;
    case 'color': layers = colorLayers(a, s, ps, beats); break;
    case 'atmos': layers = atmosLayers(a, s, ps, beats, only); break;
    default: layers = hybridLayers(a, s, ps, beats, only);
  }
  return only ? layers.filter((l) => l.key === only) : layers;
}

export { ROLE_RANGE };
