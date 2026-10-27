// IMAGE → music. Three interpretation modes + hybrid. Each produces independent, editable layers
// keyed by generator id, so any single layer can be regenerated without touching the others.

import type { FeatureKey, ImageSettings, NoteEvent, ProjectSettings } from '../core/types';
import { hash32, rng, type Rng } from '../core/rng';
import { barBeats, metricWeight } from '../core/time';
import { type Curve, type CurveKey, type FeatureGrid, type Gesture, curveSummary, curveValue, fullMask, bandMask, regionCurve } from '../analysis/features';
import { type ChordSlot, type ProgressionType, generateProgression } from '../theory/progression';
import { allowedPitches, mapY, scaleIntervals } from '../theory/scales';
import { instrument } from '../audio/patches';
import { curveLane, generateRole } from './roles';
import { fxSlot, layer, type LayerOutput, ROLE_RANGE } from './layers';

export interface ImageAnalysis { grid: FeatureGrid; gestures: Gesture[] }

export function defaultImageSettings(): ImageSettings {
  return {
    mode: 'hybrid', bars: 16, edgeSensitivity: 0.55, minContour: 24, detail: 0.5, density: 0.55, smoothing: 0.35, grouping: 0.6,
    mapping: { pitch: 'brightness', velocity: 'brightness', density: 'texture', richness: 'saturation', accent: 'contrast', duration: 'texture' },
    hueRoutes: [0, 1, 2, 3, 1, 2],
    hybrid: { contour: true, bass: true, pads: true, percussion: true, filter: true },
    seed: 1,
  };
}

export const COLOR_VOICES = [
  { name: 'Colour voice A', patch: 'Plucked Synth' },
  { name: 'Colour voice B', patch: 'Digital Mallet' },
  { name: 'Colour voice C', patch: 'Electric Keyboard' },
  { name: 'Colour voice D', patch: 'Soft Arpeggio Synth' },
];

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

// ---------------------------------------------------------------------- MODE A: contour

export function contourLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, beats: number): LayerOutput[] {
  const lead = layer('image:contour:lead', 'Contour lead', 'melody', 'imageContour', { color: '#e0a458' });
  const counter = layer('image:contour:counter', 'Contour counterline', 'melody', 'imageContour', { patch: instrument('Digital Mallet'), pitch: { mode: 'scale', low: 45, high: 74 }, color: '#9ad0c9', mix: { volume: -9, pan: 0.25 } });
  lead.mix = { ...lead.mix, pan: -0.15 };
  const r = rng(hash32(`${s.seed}:contour`));
  const gestures = a.gestures.slice(0, Math.max(2, Math.round(4 + s.density * 40)));
  const step = s.density > 0.66 ? 0.25 : s.density > 0.33 ? 0.5 : 1;
  const leadCount = Math.max(1, Math.ceil(gestures.length * 0.4));
  gestures.forEach((g, gi) => {
    const target = gi < leadCount ? lead : counter;
    const pitches = allowedPitches(target.pitch, ps.key, ps.scale, ps.customScale);
    const rows = pitches.length;
    const vel = 0.4 + g.intensity * 0.45 + Math.min(0.15, g.thickness * 0.05);
    const gate = g.curvature > 0.5 ? 0.5 : g.curvature > 0.25 ? 0.75 : 0.95;
    const id = (k: number) => `${target.key}_${g.id}_${k}`;
    const push = (n: Omit<NoteEvent, 'id' | 'origin'>, k: number) => {
      if (n.start >= beats || (s.density < 1 && !r.chance(0.55 + s.density * 0.45))) return;
      target.notes.push({ ...n, id: id(k), origin: 'image', vel: Math.min(1, n.vel) });
    };
    const xs = g.points.map((p) => p.x);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const ys = g.points.map((p) => p.y);
    const ySpan = Math.max(...ys) - Math.min(...ys);
    if (g.vertical) {
      // vertical contour → strummed chord spanning its height
      const lo = Math.min(...ys), hi = Math.max(...ys);
      const r0 = Math.round(lo * (rows - 1)), r1 = Math.round(hi * (rows - 1));
      let k = 0;
      for (let row = r0; row <= r1 && k < 6; row += 2) {
        const y = row / (rows - 1);
        push({ start: Math.floor(x0 * beats / step) * step + k * 0.03, dur: step * 2, midi: mapY(y, pitches), vel: vel * 0.9, pitchY: y }, k);
        k++;
      }
      return;
    }
    // smooth the contour (phrase smoothing)
    const win = 1 + Math.round(s.smoothing * 6);
    const sm = g.points.map((_, i) => {
      let acc = 0, c = 0;
      for (let d = -win; d <= win; d++) { const p = g.points[i + d]; if (p) { acc += p.y; c++; } }
      return { x: g.points[i].x, y: acc / c };
    });
    const yAt = (x: number) => {
      let j = 0;
      while (j < sm.length - 1 && sm[j + 1].x < x) j++;
      const p = sm[j], q = sm[Math.min(sm.length - 1, j + 1)];
      const t = q.x > p.x ? (x - p.x) / (q.x - p.x) : 0;
      return p.y + (q.y - p.y) * Math.max(0, Math.min(1, t));
    };
    if (ySpan < 0.03 && x1 - x0 > 0.08) {
      // long horizontal contour → sustained note
      const y = ys.reduce((acc, v) => acc + v, 0) / ys.length;
      push({ start: Math.floor(x0 * beats / step) * step, dur: Math.max(step, (x1 - x0) * beats), midi: mapY(y, pitches), vel, pitchY: y }, 0);
      return;
    }
    let k = 0;
    let runRow = -1, runStart = 0, runEnd = 0, runY = 0;
    const flush = () => { if (runRow >= 0) push({ start: runStart, dur: (runEnd - runStart) * gate, midi: mapY(runY, pitches), vel, pitchY: runY }, k++); };
    for (let b = Math.floor(x0 * beats / step) * step; b <= x1 * beats + 1e-6; b += step) {
      const y = yAt(b / beats);
      const row = Math.round(y * (rows - 1));
      const ry = row / Math.max(1, rows - 1);
      if (row !== runRow || s.grouping < 0.5) { flush(); runRow = row; runStart = b; runY = ry; }
      runEnd = b + step;
    }
    flush();
  });
  lead.notes.sort((x, y) => x.start - y.start);
  counter.notes.sort((x, y) => x.start - y.start);
  return [lead, counter];
}

// ---------------------------------------------------------------------- MODE B: colour & texture

export function colorLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, beats: number): LayerOutput[] {
  const perBeat = s.density > 0.5 ? 4 : 2;
  const n = steps(beats, perBeat);
  const cv = regionCurve(a.grid, fullMask, { steps: n, sensitivity: s.edgeSensitivity, strip: 0.2, smoothing: s.smoothing * 0.5 });
  const voices = COLOR_VOICES.map((v, i) => layer(`image:color:${i}`, v.name, 'melody', 'imageColor', {
    patch: instrument(v.patch), pitch: { mode: 'scale', low: 48 + (i % 2) * 7, high: 84 - (i % 2) * 5 },
    mix: { volume: -9, pan: [-0.45, 0.45, -0.2, 0.2][i] }, color: ['#e07a6a', '#d9cf6a', '#7fcf9a', '#6fb7d6'][i],
  }));
  const r = rng(hash32(`${s.seed}:color`));
  const bb = barBeats(ps.timeSig);
  const step = 1 / perBeat;
  const pitchesFor = voices.map((v) => allowedPitches(v.pitch, ps.key, ps.scale, ps.customScale));
  const counters = voices.map(() => 0);
  for (let j = 0; j < n; j++) {
    const t = (j + 0.5) / n;
    const b = j * step;
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
    const mw = metricWeight(ps.timeSig, ((b % bb) + bb) % bb);
    const accent = fv(cv, s.mapping.accent, t) > 0.45 && mw >= 0.5 ? 0.2 : 0;
    const vel = 0.3 + fv(cv, s.mapping.velocity, t) * 0.5 + accent;
    const rich = fv(cv, s.mapping.richness, t);
    const tones = rich > 0.55 ? [0, 2, 4] : rich > 0.28 ? [0, 2] : [0];
    const durF = fv(cv, s.mapping.duration, t);
    const dur = step * (0.6 + (1 - durF) * 3.5);
    // visual variation makes the rhythm more complex: syncopated or split onsets
    const vary = cv.variation[j];
    const onsets = dens > 0.62 && s.density > 0.4 ? [0, step / 2] : vary > 0.35 ? [step / 2] : [0];
    for (const o of onsets) {
      for (const off of tones) {
        target.notes.push({
          id: `${target.key}_${counters[vi]++}`, start: b + o + off * 0.012, dur, midi: mapY(y, pitches, off), vel: Math.min(1, vel * (off ? 0.8 : 1)),
          origin: 'image', pitchY: y, stepOffset: off || undefined,
        });
      }
    }
  }
  return voices.filter((v) => v.notes.length > 0 || v.key === 'image:color:0');
}

// ---------------------------------------------------------------------- MODE C: atmospheric

export function atmosLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, beats: number, only?: string): LayerOutput[] {
  const n = steps(beats, 1);
  const cv = regionCurve(a.grid, fullMask, { steps: n, sensitivity: s.edgeSensitivity, strip: 1.5, smoothing: Math.max(0.5, s.smoothing) });
  const sum = curveSummary(cv);
  const harmony = imageHarmony(cv, ps, beats, rng(hash32(`${s.seed}:atmos:harmony`)), sum.variation < 0.06 ? 'static' : sum.variation < 0.14 ? 'sparse' : 'modal');
  const params = { density: s.density * 0.7, threshold: 0.45 + (1 - s.density) * 0.3, polyphony: 6, quantize: 0 };
  const base = { settings: ps, beats, harmony, params, origin: 'image' as const };
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
    const l = layer('image:atmos:drone', 'Atmos drone', 'drone', 'imageAtmos', { color: '#8fa3b8', mix: { volume: -3 } });
    const r = generateRole({ ...base, curve: cv, role: 'drone', track: l, rng: rng(hash32(`${s.seed}:atmos:drone`)), idPrefix: l.key });
    l.notes = r.notes;
    l.automation = r.automation;
    out.push(l);
  }
  if (want('image:atmos:melody')) {
    const l = layer('image:atmos:melody', 'Atmos fragments', 'melody', 'imageAtmos', { patch: instrument('Bell / FM Tone'), mix: { volume: -7, reverb: 0.55, delay: 0.3 }, color: '#d9cf6a' });
    l.notes = atmosFragments(cv, l.pitch, ps, beats, s.density, rng(hash32(`${s.seed}:atmos:mel`)), l.key);
    out.push(l);
  }
  if (want('image:atmos:texture') && sum.edges > 0.04) {
    const l = layer('image:atmos:texture', 'Atmos grain', 'texture', 'imageAtmos', { patch: instrument('Microclicks'), color: '#9ad0c9' });
    const r = generateRole({ ...base, params: { ...params, density: s.density * 0.4 }, curve: cv, role: 'texture', track: l, rng: rng(hash32(`${s.seed}:atmos:tex`)), idPrefix: l.key });
    l.notes = r.notes;
    l.automation = [curveLane(cv, 'centroid', 'pan', beats, 0.2, 0.8, false, 'auto_tex_pan')];
    out.push(l);
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
    return { id: `${key}_${i}`, start: b, dur: 3 + r() * 3, midi: mapY(y, pitches), vel: 0.35 + at('brightness', b) * 0.45, origin: 'image' as const, pitchY: y };
  });
}

// ---------------------------------------------------------------------- HYBRID

export function hybridLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, beats: number, only?: string): LayerOutput[] {
  const out: LayerOutput[] = [];
  const want = (k: string) => !only || only.startsWith(k);
  const n = steps(beats, 2);
  const full = regionCurve(a.grid, fullMask, { steps: n, sensitivity: s.edgeSensitivity, strip: 0.5, smoothing: s.smoothing });
  const harmony = imageHarmony(full, ps, beats, rng(hash32(`${s.seed}:hybrid:harmony`)));
  const base = { settings: ps, beats, harmony, origin: 'image' as const };
  if (s.hybrid.contour && want('image:contour:lead')) out.push(...contourLayers(a, s, ps, beats).slice(0, 1));
  if (s.hybrid.bass && want('image:hybrid:bass')) {
    // low-frequency structure of the bottom third → bass
    const low = regionCurve(a.grid, bandMask(0.66, 1, a.grid.rows), { steps: n, sensitivity: s.edgeSensitivity, strip: 2, smoothing: Math.max(0.6, s.smoothing) });
    const l = layer('image:hybrid:bass', 'Low structure → bass', 'bass', 'imageTexture', { color: '#6a8de0' });
    l.notes = generateRole({ ...base, curve: low, role: 'bass', track: l, rng: rng(hash32(`${s.seed}:hybrid:bass`)), params: { density: s.density, threshold: 0.4, polyphony: 1, quantize: 2 }, idPrefix: l.key, yRange: [0, 0.34] }).notes;
    out.push(l);
  }
  if (s.hybrid.pads && want('image:hybrid:pads')) {
    const l = layer('image:hybrid:pads', 'Colour regions → pads', 'pad', 'imageColor', { color: '#b48ee0' });
    l.notes = generateRole({ ...base, curve: full, role: 'pad', track: l, rng: rng(hash32(`${s.seed}:hybrid:pads`)), params: { density: s.density, threshold: 0.5, polyphony: 5, quantize: 0 }, idPrefix: l.key }).notes;
    if (s.hybrid.filter) l.automation = [curveLane(full, 'brightness', 'cutoff', beats, 0.3, 0.95, false, 'auto_hybrid_cutoff')];
    out.push(l);
  }
  if (s.hybrid.percussion && want('image:hybrid:perc')) {
    const l = layer('image:hybrid:perc', 'Fine texture → percussion', 'percussion', 'imageTexture', { color: '#e07a6a' });
    l.notes = generateRole({ ...base, curve: full, role: 'percussion', track: l, rng: rng(hash32(`${s.seed}:hybrid:perc`)), params: { density: s.density, threshold: 0.35, polyphony: 4, quantize: 4 }, idPrefix: l.key }).notes;
    out.push(l);
  }
  return out;
}

export function generateImageLayers(a: ImageAnalysis, s: ImageSettings, ps: ProjectSettings, only?: string): LayerOutput[] {
  const beats = s.bars * barBeats(ps.timeSig);
  let layers: LayerOutput[];
  switch (s.mode) {
    case 'contour': layers = contourLayers(a, s, ps, beats); break;
    case 'color': layers = colorLayers(a, s, ps, beats); break;
    case 'atmos': layers = atmosLayers(a, s, ps, beats, only); break;
    default: layers = hybridLayers(a, s, ps, beats, only);
  }
  return only ? layers.filter((l) => l.key === only) : layers;
}

export { ROLE_RANGE };
