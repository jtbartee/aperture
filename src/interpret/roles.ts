// Feature curve → musical role. These rules are deterministic and explainable: each one says
// which image feature drives which musical decision. Curves are indexed by musical time
// (index 0 = start of the scan), whatever the scan direction or path.

import type { AutomationLane, ModTarget, NoteEvent, NoteOrigin, ProjectSettings, Role, Track } from '../core/types';
import type { Rng } from '../core/rng';
import { type Curve, type CurveKey, curveValue } from '../analysis/features';
import { barBeats, metricWeight } from '../core/time';
import { type ChordSlot, chordAt } from '../theory/progression';
import { voiceLead } from '../theory/chords';
import { allowedPitches, degreeToMidi, mapY, midiToDegree, inScale, scaleIntervals } from '../theory/scales';
import { degreeBase } from './remap';

export interface RoleParams {
  density: number; // 0..1
  threshold: number; // 0..1 event threshold
  polyphony: number; // max simultaneous notes
  quantize: number; // steps per beat (0 = free)
}

export interface RoleInput {
  curve: Curve;
  role: Role;
  track: Pick<Track, 'pitch'>;
  settings: ProjectSettings;
  beats: number;
  harmony: ChordSlot[];
  rng: Rng;
  params: RoleParams;
  origin: NoteOrigin;
  idPrefix: string;
  /** vertical extent of the region in image coordinates (0 bottom .. 1 top) for pitch normalisation */
  yRange?: [number, number];
}

export interface RoleOutput { notes: NoteEvent[]; automation: AutomationLane[] }

const c01 = (x: number) => Math.max(0, Math.min(1, x));

export function generateRole(i: RoleInput): RoleOutput {
  switch (i.role) {
    case 'melody': return melodyRole(i);
    case 'bass': return bassRole(i);
    case 'pad':
    case 'chords': return padRole(i);
    case 'drone': return droneRole(i);
    case 'arp': return arpRole(i);
    case 'percussion': return percRole(i);
    case 'texture': return textureRole(i);
  }
}

function mk(i: RoleInput) {
  let k = 0;
  const notes: NoteEvent[] = [];
  const pitches = allowedPitches(i.track.pitch, i.settings.key, i.settings.scale, i.settings.customScale);
  const base = degreeBase(i.track as Track);
  const add = (n: Omit<NoteEvent, 'id' | 'origin'>) => {
    if (n.start < 0 || n.start >= i.beats - 1e-6) return;
    notes.push({ ...n, dur: Math.max(0.05, Math.min(n.dur, i.beats - n.start)), vel: c01(n.vel), id: `${i.idPrefix}_${k++}`, origin: i.origin });
  };
  const byDegree = (degree: number) => degreeToMidi(degree, i.settings.key, i.settings.scale, base, i.settings.customScale);
  return { notes, pitches, base, add, byDegree };
}

const at = (cv: Curve, key: CurveKey, beat: number, beats: number) => curveValue(cv, key, beat / beats);

/** MELODY: onsets where edges/contrast/visual change cross the threshold; pitch follows the
 *  brightest row (or the brightness centroid) inside the region; contrast → velocity;
 *  smooth stretches → longer, legato notes. */
function melodyRole(i: RoleInput): RoleOutput {
  const ctx = mk(i);
  const { add, pitches } = ctx;
  const sub = i.params.quantize || (i.params.density > 0.55 ? 4 : 2);
  const step = 1 / sub;
  const [y0, y1] = i.yRange ?? [0, 1];
  const bb = barBeats(i.settings.timeSig);
  let last = -Infinity;
  const minGap = step * (1 + Math.round((1 - i.params.density) * 3));
  const onsets: { beat: number; y: number; vel: number }[] = [];
  for (let b = 0; b < i.beats; b += step) {
    const e = at(i.curve, 'edges', b, i.beats);
    const v = at(i.curve, 'variation', b, i.beats);
    const c = at(i.curve, 'contrast', b, i.beats);
    const mw = metricWeight(i.settings.timeSig, b % bb);
    const energy = (e * 1.2 + v * 1.4 + c * 0.5) * (0.6 + i.params.density * 0.9) + mw * 0.12;
    if (energy < i.params.threshold * 0.9 || b - last < minGap) continue;
    // pitch from the brightest row of the strip's profile, blended with the centroid
    const idx = Math.min(i.curve.n - 1, Math.round((b / i.beats) * (i.curve.n - 1)));
    const prof = i.curve.profile[idx];
    let yImg = i.curve.centroid[idx];
    if (prof) {
      let best = -1;
      let bestV = -1;
      for (let r = 0; r < prof.length; r++) if (prof[r] > bestV) { bestV = prof[r]; best = r; }
      if (best >= 0 && bestV > 0) yImg = yImg * 0.4 + (1 - (best + 0.5) / prof.length) * 0.6;
    }
    const y = c01((yImg - y0) / Math.max(0.05, y1 - y0));
    onsets.push({ beat: b, y, vel: 0.45 + c * 0.6 + mw * 0.1 });
    last = b;
  }
  onsets.forEach((o, k) => {
    const next = onsets[k + 1]?.beat ?? i.beats;
    const smooth = 1 - at(i.curve, 'texture', o.beat, i.beats);
    const dur = Math.min(next - o.beat, step * (1 + smooth * 6));
    // on strong beats, nudge a non-chord tone to the nearest chord tone (keeps pitchY for remapping)
    let off = 0;
    const slot = chordAt(i.harmony, o.beat);
    const midi = mapY(o.y, pitches);
    if (slot && metricWeight(i.settings.timeSig, o.beat % bb) >= 0.5 && !slot.chord.pcs.includes(midi % 12)) {
      if (slot.chord.pcs.includes(mapY(o.y, pitches, 1) % 12)) off = 1;
      else if (slot.chord.pcs.includes(mapY(o.y, pitches, -1) % 12)) off = -1;
    }
    add({ start: o.beat, dur: dur * 0.95, midi: mapY(o.y, pitches, off), vel: o.vel, pitchY: o.y, stepOffset: off || undefined });
  });
  return { notes: ctx.notes, automation: [] };
}

/** BASS: chord roots (degree-based) with a rhythm whose density follows the region's texture;
 *  smooth regions hold whole chords, busy regions pulse in eighths; brightness adds fifths/octaves. */
function bassRole(i: RoleInput): RoleOutput {
  const ctx = mk(i);
  const bb = barBeats(i.settings.timeSig);
  const n = scaleIntervals(i.settings.scale, i.settings.customScale).length;
  for (const slot of i.harmony) {
    const rootDeg = midiToDegree(ctx.base + ((slot.bassPc - ctx.base) % 12 + 12) % 12, i.settings.key, i.settings.scale, ctx.base, i.settings.customScale);
    const deg0 = rootDeg >= n ? rootDeg - n : rootDeg;
    for (let b = slot.start; b < slot.start + slot.dur - 1e-6; ) {
      const tex = at(i.curve, 'texture', b, i.beats) * 0.6 + at(i.curve, 'edges', b, i.beats) * 0.8;
      const busy = tex * (0.5 + i.params.density);
      const dur = busy > 0.55 ? 0.5 : busy > 0.3 ? 1 : busy > 0.12 ? 2 : Math.min(bb * 2, slot.start + slot.dur - b);
      const bright = at(i.curve, 'brightness', b, i.beats);
      const posInBar = b % bb;
      let deg = deg0;
      if (dur <= 1 && posInBar > 0 && i.rng.chance(bright * 0.5)) deg = deg0 + i.rng.pick([4, n, -3]);
      const vel = 0.6 + metricWeight(i.settings.timeSig, posInBar) * 0.3;
      if (!(dur <= 0.5 && posInBar % 1 !== 0 && i.rng.chance(0.35 * (1 - i.params.density)))) {
        ctx.add({ start: b, dur: dur * (dur <= 0.5 ? 0.7 : 0.95), midi: ctx.byDegree(deg), vel, degree: deg });
      }
      b += dur;
    }
  }
  return { notes: ctx.notes, automation: [] };
}

/** PAD / CHORDS: the shared harmony voiced with voice-leading in the track's range; chord size
 *  grows with saturation; strong visual change re-strikes the chord; brightness → velocity. */
function padRole(i: RoleInput): RoleOutput {
  const ctx = mk(i);
  let prev: number[] | null = null;
  const lo = i.track.pitch.low;
  const hi = i.track.pitch.high;
  const bb = barBeats(i.settings.timeSig);
  for (const slot of i.harmony) {
    const sat = at(i.curve, 'saturation', slot.start, i.beats);
    const size = Math.max(2, Math.min(i.params.polyphony, 3 + Math.round(sat * 2)));
    const voicing = voiceLead(prev, slot.chord, lo, hi, size);
    prev = voicing;
    // split the slot where the image changes sharply (re-articulation)
    const cuts = [slot.start];
    if (i.role === 'chords') {
      for (let b = slot.start + bb; b < slot.start + slot.dur - 1e-6; b += bb) cuts.push(b);
    } else {
      for (let b = slot.start + bb; b < slot.start + slot.dur - 1e-6; b += bb) if (at(i.curve, 'variation', b, i.beats) > 0.35 + i.params.threshold * 0.3) cuts.push(b);
    }
    cuts.forEach((c, k) => {
      const end = cuts[k + 1] ?? slot.start + slot.dur;
      const vel = 0.35 + at(i.curve, 'brightness', c, i.beats) * 0.45;
      const stab = i.role === 'chords' ? Math.min(end - c, 0.75 + at(i.curve, 'saturation', c, i.beats) * 1.5) : end - c;
      voicing.forEach((m, j) => {
        const d = inScale(m, i.settings.key, i.settings.scale, i.settings.customScale) ? midiToDegree(m, i.settings.key, i.settings.scale, ctx.base, i.settings.customScale) : undefined;
        ctx.add({ start: c + j * 0.01, dur: stab, midi: m, vel: vel * (j === 0 ? 1 : 0.85), degree: d });
      });
    });
  }
  return { notes: ctx.notes, automation: [] };
}

/** DRONE: tonic and fifth held for long spans; re-articulated only at big changes; darker regions
 *  sit an octave lower; brightness → filter automation. */
function droneRole(i: RoleInput): RoleOutput {
  const ctx = mk(i);
  const n = scaleIntervals(i.settings.scale, i.settings.customScale).length;
  const bb = barBeats(i.settings.timeSig);
  const minSpan = bb * 4;
  let start = 0;
  const spans: [number, number][] = [];
  for (let b = bb; b < i.beats; b += bb) {
    const change = at(i.curve, 'variation', b, i.beats) + Math.abs(at(i.curve, 'brightness', b, i.beats) - at(i.curve, 'brightness', start, i.beats));
    if ((b - start >= minSpan && change > 0.35) || b - start >= bb * 16) { spans.push([start, b]); start = b; }
  }
  spans.push([start, i.beats]);
  for (const [a, z] of spans) {
    const bright = at(i.curve, 'brightness', a, i.beats);
    const octave = bright < 0.25 ? 0 : bright > 0.6 ? 2 : 1;
    const root = n * octave;
    const fifth = root + (n >= 7 ? 4 : Math.round(n * 0.6));
    const vel = 0.4 + at(i.curve, 'saturation', a, i.beats) * 0.3;
    ctx.add({ start: a, dur: z - a, midi: ctx.byDegree(root), vel, degree: root });
    ctx.add({ start: a + 0.02, dur: z - a, midi: ctx.byDegree(fifth), vel: vel * 0.8, degree: fifth });
    if (at(i.curve, 'texture', a, i.beats) > 0.4) ctx.add({ start: a + 0.04, dur: z - a, midi: ctx.byDegree(root + n), vel: vel * 0.6, degree: root + n });
  }
  return { notes: ctx.notes, automation: [curveLane(i.curve, 'brightness', 'cutoff', i.beats, 0.15, 0.85)] };
}

/** ARP: the current chord arpeggiated at a rate set by texture (8ths → 16ths → triplets); vertical
 *  edges send it upward, horizontal edges make it rock up-down; quiet stretches rest. */
function arpRole(i: RoleInput): RoleOutput {
  const ctx = mk(i);
  const lo = i.track.pitch.low;
  const hi = i.track.pitch.high;
  let b = 0;
  let idx = 0;
  let dirUp = true;
  while (b < i.beats - 1e-6) {
    const tex = at(i.curve, 'texture', b, i.beats);
    const edges = at(i.curve, 'edges', b, i.beats);
    const rate = tex > 0.5 ? 4 : tex > 0.25 ? 3 : 2;
    const step = 1 / rate;
    const slot = chordAt(i.harmony, b);
    const tones = voiceLead(null, slot.chord, lo, hi, 4);
    const ext = [...tones, ...tones.map((m) => m + 12).filter((m) => m <= hi + 5)];
    if (edges * (0.6 + i.params.density) + tex * 0.3 > i.params.threshold * 0.5) {
      const vertical = at(i.curve, 'orientation', b, i.beats) > 0.5;
      if (vertical) idx = (idx + 1) % ext.length;
      else { idx += dirUp ? 1 : -1; if (idx >= ext.length - 1 || idx <= 0) dirUp = !dirUp; idx = Math.max(0, Math.min(ext.length - 1, idx)); }
      const m = ext[idx];
      const d = inScale(m, i.settings.key, i.settings.scale, i.settings.customScale) ? midiToDegree(m, i.settings.key, i.settings.scale, ctx.base, i.settings.customScale) : undefined;
      ctx.add({ start: b, dur: step * 0.8, midi: m, vel: 0.5 + at(i.curve, 'contrast', b, i.beats) * 0.4, degree: d });
    }
    b += step;
  }
  return { notes: ctx.notes, automation: [] };
}

/** PERCUSSION: a 16th-note grid; each step's voice is chosen from what the image is doing there:
 *  strong beat + contrast → kick, group off-beats with edges → snare/click, fine texture → hats,
 *  sudden change → noise burst / open hat, saturated vertical edges → metal. */
function percRole(i: RoleInput): RoleOutput {
  const ctx = mk(i);
  const bb = barBeats(i.settings.timeSig);
  const sub = i.params.quantize || 4;
  const step = 1 / sub;
  const d = i.params.density;
  for (let b = 0; b < i.beats - 1e-6; b += step) {
    const pos = ((b % bb) + bb) % bb;
    const mw = metricWeight(i.settings.timeSig, pos);
    const e = at(i.curve, 'edges', b, i.beats);
    const t = at(i.curve, 'texture', b, i.beats);
    const c = at(i.curve, 'contrast', b, i.beats);
    const v = at(i.curve, 'variation', b, i.beats);
    const s = at(i.curve, 'saturation', b, i.beats);
    const o = at(i.curve, 'orientation', b, i.beats);
    const hit = (midi: number, vel: number, dur = step * 0.5) => ctx.add({ start: b, dur, midi, vel });
    if (mw >= 0.75 && (c * 0.8 + e * 0.6 + d * 0.4) > i.params.threshold * 0.8) hit(36, 0.75 + c * 0.25);
    else if (mw >= 0.5 && pos > 0 && e * (0.6 + d) > i.params.threshold * 0.7 && i.rng.chance(0.55 + d * 0.3)) hit(o > 0.55 ? 38 : 37, 0.55 + e * 0.4);
    if (t * (0.5 + d) > i.params.threshold * 0.45 && i.rng.chance(0.35 + t * 0.5)) hit(42, 0.3 + t * 0.4 + (mw > 0.3 ? 0.1 : 0));
    if (v > 0.45 && i.rng.chance(v * 0.6)) hit(i.rng.chance(0.5) ? 39 : 46, 0.5 + v * 0.3, step * 2);
    if (s > 0.5 && o > 0.6 && mw < 0.5 && i.rng.chance(s * 0.25 * d)) hit(56, 0.45 + s * 0.3);
  }
  return { notes: ctx.notes, automation: [] };
}

/** TEXTURE: glitch micro-events wherever local variation or edges are high; hue chooses the
 *  event type (the glitch engine keys its four sounds on pitch class), brightness the register. */
function textureRole(i: RoleInput): RoleOutput {
  const ctx = mk(i);
  const step = 0.125;
  for (let b = 0; b < i.beats - 1e-6; b += step) {
    const v = at(i.curve, 'variation', b, i.beats);
    const e = at(i.curve, 'edges', b, i.beats);
    const p = (v * 1.2 + e * 0.6) * (0.3 + i.params.density) - i.params.threshold * 0.5;
    if (p <= 0 || !i.rng.chance(Math.min(0.9, p))) continue;
    const hue = at(i.curve, 'hue', b, i.beats);
    const bright = at(i.curve, 'brightness', b, i.beats);
    const midi = Math.round(i.track.pitch.low + bright * (i.track.pitch.high - i.track.pitch.low)) - (Math.round(i.track.pitch.low + bright * (i.track.pitch.high - i.track.pitch.low)) % 4) + Math.floor(hue * 4);
    const burst = v > 0.6 ? i.rng.int(2, 4) : 1;
    for (let k = 0; k < burst; k++) ctx.add({ start: b + (k * step) / burst, dur: step * 0.5, midi, vel: 0.4 + e * 0.5 });
  }
  return { notes: ctx.notes, automation: [] };
}

/** A curve sampled every half beat into an automation lane, rescaled to [lo, hi]. */
export function curveLane(cv: Curve, key: CurveKey, target: ModTarget, beats: number, lo = 0, hi = 1, invert = false, id?: string): AutomationLane {
  const points: { beat: number; value: number }[] = [];
  for (let b = 0; b <= beats + 1e-6; b += 0.5) {
    let v = curveValue(cv, key, b / beats);
    if (invert) v = 1 - v;
    points.push({ beat: b, value: lo + (hi - lo) * c01(v) });
  }
  return { id: id ?? `auto_${key}_${target}`, target, points, origin: 'image' };
}
