// Layer builders shared by the Image and Panorama workspaces. Each returns a LayerOutput keyed by
// a generator id, so any one layer can be regenerated alone and tracks keep their mix on regen.

import type { NoteEvent, ProjectSettings, SonifyShape } from '../core/types';
import { hash32, rng } from '../core/rng';
import { type Curve, type FeatureGrid, type MaskFn, bandMask, fullMask } from '../analysis/features';
import type { Contour, ContourSet } from '../analysis/contours';
import type { ChordSlot } from '../theory/progression';
import { allowedPitches, mapY, scaleIntervals } from '../theory/scales';
import { instrument } from '../audio/patches';
import { type SynthCharacter, densityMod, deriveImageSynth, regionFeatures, synthLanes } from '../audio/imageSynth';
import { contourCount, contourVoice, type ScanSeg, textureEvents, timedEvents, visualEvents, voicePitch } from './sonify';
import { generateRole } from './roles';
import { fxSlot, layer, type LayerOutput } from './layers';

export interface SonicContext {
  grid: FeatureGrid;
  set: ContourSet;
  shape: SonifyShape;
  density: number;
  ps: ProjectSettings;
  beats: number;
  segs: ScanSeg[];
  seed: number;
  origin: 'image' | 'panorama';
  /** feature curve along the scan for a mask */
  curve: (mask: MaskFn, o?: { strip?: number; smoothing?: number }) => Curve;
  harmony: ChordSlot[];
  pxWidth: number;
  aspect: number;
  res: number;
}

const c01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Band mask around a vertical position (bottom-up y), ± half-height. */
export const bandAround = (y: number, half: number, rows: number) => bandMask(c01(1 - y - half), c01(1 - y + half), rows);

/** Give a layer its sound: an Image Synth patch read from its region (with evolving lanes), or a
 *  fixed preset when the user chose presets. Lanes from the image only exist for Image Synth. */
export function voiceSound(ctx: SonicContext, l: LayerOutput, character: SynthCharacter, mask: MaskFn, cv: Curve, preset: string) {
  if (ctx.shape.synth !== 'image') { l.patch = instrument(preset); return; }
  const f = regionFeatures(ctx.grid, mask, cv);
  l.patch = deriveImageSynth(`Image Synth · ${l.name}`, character, f, ctx.shape.synthMap);
  l.automation = [...l.automation, ...synthLanes(cv, ctx.shape.synthMap, character, f, ctx.shape.evolution, ctx.beats, l.key.replace(/[^a-z0-9]+/gi, '_'), ctx.origin)];
  if (!(l.fx ?? []).some((x) => x.type === 'pingpong' || x.type === 'delay')) l.fx = [...(l.fx ?? []), fxSlot('pingpong', { wet: character === 'drone' ? 0.12 : 0.2, feedback: 0.3 }, `fx_${l.key.replace(/[^a-z0-9]+/gi, '_')}_pp`)];
}

const meanY = (c: Contour) => c.pts.reduce((a, p) => a + p.y, 0) / Math.max(1, c.pts.length);

export interface VoiceSpec { key: string; name: string; character: SynthCharacter; preset: string; color: string; contours: Contour[]; shape?: Partial<SonifyShape>; vol: number; pan: number }

/** Contour voices. 'rank' (image): the most salient contour is voice A, the next B and C, the rest
 *  form a field; branches stay with their parent. 'register' (panorama): low / middle / high ridges
 *  plus fine detail. Every voice shares one pitch axis so vertical relationships survive. */
export function contourVoiceSpecs(ctx: SonicContext, mode: 'rank' | 'register', keys: string[]): VoiceSpec[] {
  // below full fidelity the seed may re-rank contours of similar salience: a different but related
  // reading of the same image. At 100 % fidelity the image alone decides.
  const r = rng(hash32(`${ctx.seed}:select`));
  const freedom = (1 - c01(ctx.shape.fidelity)) * 0.9;
  const all = ctx.set.contours
    .map((c) => ({ c, w: c.length * (0.4 + c.intensity) * (1 + freedom * (r() - 0.5)) }))
    .sort((a, b) => b.w - a.w)
    .map((x) => x.c);
  const chosen = all.slice(0, contourCount(all.length, ctx.density));
  if (!chosen.length) return [];
  if (mode === 'rank') {
    const groups: Contour[][] = [[], [], [], []];
    const voiceOf = new Map<string, number>();
    chosen.forEach((c, i) => {
      const v = c.parent && voiceOf.has(c.parent) ? voiceOf.get(c.parent)! : Math.min(3, i);
      voiceOf.set(c.id, v);
      groups[v].push(c);
    });
    const meta = [
      { name: 'Contour A', character: 'voice' as const, preset: 'Plucked Synth', color: '#e0a458', vol: -5, pan: -0.15 },
      { name: 'Contour B', character: 'pluck' as const, preset: 'Digital Mallet', color: '#9ad0c9', vol: -7, pan: 0.25 },
      { name: 'Contour C', character: 'shimmer' as const, preset: 'Bell / FM Tone', color: '#b48ee0', vol: -8, pan: -0.35 },
      { name: 'Contour field', character: 'pluck' as const, preset: 'Soft Arpeggio Synth', color: '#7fcf9a', vol: -11, pan: 0.4 },
    ];
    return groups.map((g, v) => ({ key: keys[v], ...meta[v], contours: g })).filter((x) => x.contours.length);
  }
  const low: Contour[] = [], mid: Contour[] = [], high: Contour[] = [], detail: Contour[] = [];
  for (const c of chosen) {
    if (c.coarse < 0.35 && c.length < 120) { detail.push(c); continue; }
    const y = meanY(c);
    (y < 0.4 ? low : y > 0.62 ? high : mid).push(c);
  }
  return [
    // the lowest ridge glides slowly as a deep drone that traces its shape
    { key: keys[0], name: 'Low ridge → drone', character: 'drone' as const, preset: 'Subterranean Drone', color: '#6a8de0', contours: low, shape: { glide: true, interpretation: Math.max(0.6, ctx.shape.interpretation) }, vol: -6, pan: 0 },
    { key: keys[1], name: 'Middle ridge → melody', character: 'voice' as const, preset: 'Digital Mallet', color: '#e0a458', contours: mid, vol: -6, pan: -0.2 },
    { key: keys[2], name: 'Upper ridge → harmonic texture', character: 'shimmer' as const, preset: 'Glassy Ambient Pad', color: '#b48ee0', contours: high, vol: -9, pan: 0.25 },
    { key: keys[3], name: 'Fine detail → micro-events', character: 'texture' as const, preset: 'Microclicks', color: '#9ad0c9', contours: detail, vol: -11, pan: 0.35 },
  ].filter((x) => x.contours.length);
}

export function contourVoiceLayers(ctx: SonicContext, specs: VoiceSpec[]): LayerOutput[] {
  return specs.map((v) => {
    const shape = { ...ctx.shape, ...v.shape };
    const pitch = voicePitch(shape, 36, 93);
    const l = layer(v.key, v.name, 'melody', ctx.origin === 'image' ? 'imageContour' : 'panorama', { pitch, color: v.color, mix: { volume: v.vol, pan: v.pan, reverb: 0.3, delay: 0.12 } });
    const ys = v.contours.map(meanY);
    const yc = ys.reduce((a, b) => a + b, 0) / ys.length;
    const half = Math.max(0.12, (Math.max(...ys) - Math.min(...ys)) / 2 + 0.1);
    const mask = bandAround(yc, half, ctx.grid.rows);
    const cv = ctx.curve(mask, { strip: 0.5, smoothing: 0.5 });
    if (v.character === 'texture') {
      // fine detail speaks as short micro-events at its starts and extrema
      const ev = visualEvents(ctx.grid, { ...ctx.set, contours: v.contours, junctions: [] }, Math.max(0.5, ctx.density), true);
      const timed = timedEvents(ev, ctx.segs, ctx.beats, () => 1 / 8);
      const pitches = allowedPitches(pitch, ctx.ps.key, ctx.ps.scale, ctx.ps.customScale);
      const n = pitches.length;
      l.notes = timed.map((e, k) => {
        const py = n > 1 ? Math.round(e.y * (n - 1)) / (n - 1) : 0.5;
        return { id: `${v.key}_${k}`, start: e.t, dur: 1 / 8, midi: mapY(py, pitches), vel: 0.3 + 0.5 * e.strength, origin: ctx.origin, pitchY: py, src: [e.x, e.y], timbre: 0.8 } as NoteEvent;
      });
    } else {
      l.notes = contourVoice({
        contours: v.contours, shape, density: ctx.density, ps: ctx.ps, segs: ctx.segs, pitch, rng: rng(hash32(`${ctx.seed}:${v.key}`)),
        idPrefix: v.key, origin: ctx.origin, aspect: ctx.aspect, harmony: ctx.harmony, center: yc, pxWidth: ctx.pxWidth, res: ctx.res,
      }).filter((n) => n.start < ctx.beats).map((n) => ({ ...n, dur: Math.min(n.dur, ctx.beats - n.start) }));
    }
    voiceSound(ctx, l, v.character, mask, cv, v.preset);
    return l;
  });
}

/** The evolving atmosphere bed: long notes that re-articulate only at large visual changes, while
 *  the Image Synth lanes transform the held sound continuously along the scan. */
export function atmosphereLayer(ctx: SonicContext, key: string, name: string): LayerOutput | null {
  const cv = ctx.curve(fullMask, { strip: 2, smoothing: 0.7 });
  const l = layer(key, name, 'drone', ctx.origin === 'image' ? 'imageAtmos' : 'panorama', { color: '#8fa3b8', mix: { volume: -6, reverb: 0.55, delay: 0.05 } });
  const pitches = allowedPitches(l.pitch, ctx.ps.key, ctx.ps.scale, ctx.ps.customScale);
  const per = scaleIntervals(ctx.ps.scale, ctx.ps.customScale).length;
  const at = (k: keyof Curve, t: number) => { const a = cv[k] as Float32Array; const x = c01(t / ctx.beats) * (cv.n - 1); const i = Math.floor(x); return i >= cv.n - 1 ? a[cv.n - 1] : a[i] + (a[i + 1] - a[i]) * (x - i); };
  const ev = c01(ctx.shape.evolution);
  const thr = 0.6 - ev * 0.35;
  const maxSpan = Math.max(16, (64 - ev * 48) * 4);
  const minSpan = Math.min(maxSpan, 8 + (1 - ev) * 8);
  const spans: [number, number][] = [];
  let a = 0;
  for (let b = 4; b < ctx.beats; b += 2) {
    const change = Math.abs(at('brightness', b) - at('brightness', a)) * 2 + Math.abs(at('saturation', b) - at('saturation', a)) + Math.abs(at('texture', b) - at('texture', a)) + at('variation', b);
    if ((b - a >= minSpan && change > thr) || b - a >= maxSpan) { spans.push([a, b]); a = b; }
  }
  spans.push([a, ctx.beats]);
  const notes: NoteEvent[] = [];
  let k = 0;
  for (const [s0, s1] of spans) {
    const bright = at('brightness', (s0 + s1) / 2);
    const vel = 0.42 + at('saturation', s0) * 0.3;
    if (ctx.shape.structure >= 0.3) {
      // tonal: the key's root, with a fifth above (and an octave when the image is busy)
      const oct = bright < 0.25 ? 0 : bright > 0.6 ? 2 : 1;
      const root = per * oct;
      const degs = [root, root + (per >= 7 ? 4 : Math.round(per * 0.6))];
      if (at('texture', s0) > 0.4) degs.push(root + per);
      degs.forEach((d, j) => notes.push({ id: `${key}_${k++}`, start: s0 + j * 0.02, dur: s1 - s0, midi: mapY(0, pitches, d), vel: vel * (j ? 0.75 : 1), origin: ctx.origin, pitchY: 0, stepOffset: d || undefined }));
    } else {
      // image-led: the pitch sits where the light sits
      const y = c01(at('centroid', s0));
      const py = pitches.length > 1 ? Math.round(y * 0.6 * (pitches.length - 1)) / (pitches.length - 1) : 0.5;
      notes.push({ id: `${key}_${k++}`, start: s0, dur: s1 - s0, midi: mapY(py, pitches), vel, origin: ctx.origin, pitchY: py });
      notes.push({ id: `${key}_${k++}`, start: s0 + 0.02, dur: s1 - s0, midi: mapY(py, pitches, 4), vel: vel * 0.7, origin: ctx.origin, pitchY: py, stepOffset: 4 });
    }
  }
  l.notes = notes.filter((n) => n.start < ctx.beats);
  voiceSound(ctx, l, 'drone', fullMask, cv, 'Subterranean Drone');
  return l;
}

/** The rhythm layer, by rhythm mode:
 *   free    — pitched accents at salient visual events (starts, junctions, extrema, boundaries)
 *   texture — micro-events at the peaks of the column edge profile (IDM / glitch textures)
 *   metric  — the conventional sixteenth-grid drum engine (explicit opt-in) */
export function rhythmLayer(ctx: SonicContext, key: string, metricKey: string): LayerOutput | null {
  const cv = ctx.curve(fullMask, { strip: 0.5, smoothing: 0.3 });
  const f = regionFeatures(ctx.grid, fullMask, cv);
  const dmod = densityMod(ctx.shape.synthMap, cv, ctx.shape.evolution, f.summary);
  const d = c01(ctx.density);
  if (ctx.shape.rhythm === 'metric') {
    const l = layer(metricKey, 'Image texture → drum kit (metric)', 'percussion', ctx.origin === 'image' ? 'imageTexture' : 'panorama', { color: '#e07a6a' });
    l.notes = generateRole({
      curve: cv, role: 'percussion', track: l, settings: ctx.ps, beats: ctx.beats, harmony: ctx.harmony, rng: rng(hash32(`${ctx.seed}:${metricKey}`)),
      params: { density: d, threshold: 0.35, polyphony: 4, quantize: 4, rhythm: 'metric' }, origin: ctx.origin, idPrefix: metricKey,
    }).notes;
    return l;
  }
  if (ctx.shape.rhythm === 'texture') {
    const ev = textureEvents(ctx.grid);
    const gap = 1 / 32 + (1 - d) * 0.45;
    const timed = timedEvents(ev, ctx.segs, ctx.beats, (t) => gap / dmod(t));
    if (!timed.length) return null;
    const l = layer(key, 'Image texture → micro-events', 'texture', ctx.origin === 'image' ? 'imageTexture' : 'panorama', { color: '#9ad0c9', mix: { volume: -9, reverb: 0.25, delay: 0.2 } });
    l.patch = instrument('Microclicks');
    const KIND: Record<string, number> = { accent: 0, grain: 1, pulse: 2, click: 3 };
    l.notes = timed.map((e, k) => {
      const base = Math.round(48 + e.y * 44);
      const midi = base - (base % 4) + (KIND[e.kind] ?? 3);
      return { id: `${key}_${k}`, start: e.t, dur: 1 / 16, midi, vel: c01(0.3 + 0.6 * e.strength + (e.kind === 'accent' ? 0.1 : 0)), origin: ctx.origin, src: [e.x, e.y] } as NoteEvent;
    });
    l.automation = [];
    if (ctx.shape.synth === 'image') l.automation = synthLanes(cv, ctx.shape.synthMap.filter((m) => ['cutoff', 'pan', 'reverbSend', 'resonance', 'richness'].includes(m.target)), 'texture', f, ctx.shape.evolution, ctx.beats, `${key}_tex`, ctx.origin);
    return l;
  }
  const ev = visualEvents(ctx.grid, ctx.set, d);
  const timed = timedEvents(ev, ctx.segs, ctx.beats, (t) => (0.12 + (1 - d) * 0.6) / dmod(t));
  if (!timed.length) return null;
  const l = layer(key, 'Visual events → accents (free time)', 'melody', ctx.origin === 'image' ? 'imageTexture' : 'panorama', { pitch: voicePitch(ctx.shape, 45, 96), color: '#e07a6a', mix: { volume: -9, reverb: 0.4, delay: 0.25 } });
  const pitches = allowedPitches(l.pitch, ctx.ps.key, ctx.ps.scale, ctx.ps.customScale);
  const n = pitches.length;
  const DUR: Record<string, number> = { boundary: 2.5, start: 1, junction: 0.4, extremum: 0.8 };
  l.notes = timed.map((e, k) => {
    const next = timed[k + 1]?.t ?? ctx.beats;
    const py = n > 1 ? Math.round(e.y * (n - 1)) / (n - 1) : 0.5;
    return { id: `${key}_${k}`, start: e.t, dur: Math.max(0.1, Math.min(next - e.t, DUR[e.kind] ?? 1)), midi: mapY(py, pitches), vel: c01(0.25 + 0.6 * e.strength), origin: ctx.origin, pitchY: py, src: [e.x, e.y], timbre: e.kind === 'boundary' ? 0.3 : 0.7 } as NoteEvent;
  });
  voiceSound(ctx, l, 'pluck', fullMask, cv, 'Digital Mallet');
  return l;
}
