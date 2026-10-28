// GENERATIVE COMPOSER. A piece is planned before it is written:
//   structure → sections (intensity, which layers play) → shared harmony →
//   per-layer phrases, each with its own rhythmic identity (pattern length, subdivision,
//   phase), remembered and mutated so long pieces develop instead of looping.
// Every decision draws from seeded RNG streams forked per (layer, section, phrase), so the same
// inputs + seed reproduce identical events, and changing one setting does not reshuffle everything.

import type { AutomationLane, CompositionSettings, EffectSlot, Mix, NoteEvent, ProjectSettings, Role, RhythmSpec, StructureId, StyleId, Stroke } from '../core/types';
import { hash32, rng, type Rng } from '../core/rng';
import { TIME_SIGS, barBeats, metricWeight } from '../core/time';
import type { Curve } from '../analysis/features';
import { curveValue } from '../analysis/features';
import { type ChordSlot, type ProgressionType, chordAt, generateProgression } from '../theory/progression';
import { chordFromQuality, voiceLead } from '../theory/chords';
import { generateMelody, type MelodyBehavior } from '../theory/melody';
import { defaultRhythm, euclid, expandRhythm } from '../theory/rhythm';
import { degreeToMidi, midiToDegree, inScale, scaleIntervals } from '../theory/scales';
import { instrument } from '../audio/patches';
import { fxSlot, layer, type LayerOutput, ROLE_RANGE } from './layers';

export interface Section { name: string; start: number; bars: number; intensity: number; variant: number }

interface StyleProfile {
  label: string;
  description: string;
  tempo: number;
  swing: number;
  progression: ProgressionType;
  harmonicRhythm: number;
  phraseBars: number;
  /** layer → minimum section intensity at which it plays */
  layers: Partial<Record<LayerId, number>>;
  patches: Partial<Record<LayerId, string>>;
  melody: MelodyBehavior[];
}

type LayerId = 'drums' | 'bass' | 'pad' | 'chords' | 'drone' | 'drone2' | 'arp' | 'melody' | 'texture';
const LAYER_ROLE: Record<LayerId, Role> = { drums: 'percussion', bass: 'bass', pad: 'pad', chords: 'chords', drone: 'drone', drone2: 'drone', arp: 'arp', melody: 'melody', texture: 'texture' };
const LAYER_NAME: Record<LayerId, string> = { drums: 'Drums', bass: 'Bass', pad: 'Pads', chords: 'Chords', drone: 'Drone', drone2: 'Drone (detuned)', arp: 'Arpeggio', melody: 'Melody', texture: 'Texture' };

export const STYLES: Record<StyleId, StyleProfile> = {
  ambient: {
    label: 'Ambient', description: 'Slow evolution, long notes, sparse melody, soft attacks, spacious harmony and sustained drones.',
    tempo: 72, swing: 0, progression: 'sparse', harmonicRhythm: 4, phraseBars: 8,
    layers: { pad: 0, drone: 0, melody: 0.45, texture: 0.3 }, patches: { pad: 'Glassy Ambient Pad', drone: 'Dark Drone', melody: 'Bell / FM Tone', texture: 'Distant Chimes' },
    melody: ['contour', 'stepwise', 'drone'],
  },
  ambientDub: {
    label: 'Ambient dub', description: 'Minimal repeating motifs, warm bass, filtered chord stabs drenched in echo, sparse one-drop pulse.',
    tempo: 76, swing: 0.15, progression: 'pedal', harmonicRhythm: 2, phraseBars: 4,
    layers: { drums: 0.25, bass: 0.2, chords: 0, pad: 0.55, melody: 0.7 }, patches: { bass: 'Deep Current', chords: 'Dusty Keys', pad: 'Faded Tape Pad', melody: 'Hollow Pulse' },
    melody: ['minimal', 'motif'],
  },
  motorik: {
    label: 'Krautrock / motorik', description: 'Steady forward pulse, locked eighth-note bass, evolving arpeggios, minimal chord movement, gradual timbral change.',
    tempo: 126, swing: 0, progression: 'modal', harmonicRhythm: 4, phraseBars: 4,
    layers: { drums: 0, bass: 0.15, arp: 0.35, pad: 0.5, melody: 0.7 }, patches: { bass: 'Analog Mono Bass', arp: 'Soft Machinery', pad: 'Analog Haze', melody: 'Plucked Synth' },
    melody: ['minimal', 'motif'],
  },
  idm: {
    label: 'IDM / glitch', description: 'Irregular placement, changing subdivisions, stutters, polymetric layers and unusual intervals.',
    tempo: 104, swing: 0, progression: 'chromatic', harmonicRhythm: 2, phraseBars: 4,
    layers: { drums: 0, texture: 0.15, bass: 0.3, melody: 0.4, chords: 0.6 }, patches: { bass: 'Night Bus Bass', melody: 'Digital Mallet', chords: 'Metallic Bloom', texture: 'Glitch Percussion' },
    melody: ['leaping', 'chromatic', 'motif'],
  },
  minimal: {
    label: 'Minimal electronic', description: 'Short pulses, small clusters, precise placement, repetition with slow pattern mutation.',
    tempo: 122, swing: 0.05, progression: 'pedal', harmonicRhythm: 8, phraseBars: 4,
    layers: { drums: 0, chords: 0.2, bass: 0.35, arp: 0.55, texture: 0.7 }, patches: { chords: 'Hollow Pulse', bass: 'Sub Bass', arp: 'Soft Arpeggio Synth', texture: 'Microclicks' },
    melody: ['minimal'],
  },
  drone: {
    label: 'Drone / experimental', description: 'Sustained structures, very slow movement, beating oscillators, micro-events and long-form transformation.',
    tempo: 60, swing: 0, progression: 'static', harmonicRhythm: 16, phraseBars: 8,
    layers: { drone: 0, drone2: 0, pad: 0.4, texture: 0.25 }, patches: { drone: 'Subterranean Drone', drone2: 'Dark Drone', pad: 'Frozen Glass', texture: 'Microclicks' },
    melody: ['drone'],
  },
  cinematic: {
    label: 'Cinematic', description: 'Contrasting sections, tension and release, atmospheric transitions and controlled build-ups.',
    tempo: 92, swing: 0, progression: 'tension', harmonicRhythm: 2, phraseBars: 4,
    layers: { pad: 0, drone: 0, bass: 0.35, arp: 0.5, melody: 0.55, drums: 0.75 }, patches: { pad: 'Warm Analog Pad', drone: 'Dark Drone', bass: 'Sub Bass', arp: 'Plucked Synth', melody: 'Electric Keyboard' },
    melody: ['motif', 'callResponse'],
  },
  atonal: {
    label: 'Abstract / atonal', description: 'Chromatic clusters, irregular intervals and non-traditional harmony — controlled, not random.',
    tempo: 84, swing: 0, progression: 'chromatic', harmonicRhythm: 2, phraseBars: 4,
    layers: { chords: 0, melody: 0.2, texture: 0.35, drums: 0.6 }, patches: { chords: 'Metallic Bloom', melody: 'Bell / FM Tone', texture: 'Glitch Percussion' },
    melody: ['leaping', 'chromatic'],
  },
};

export const STYLE_IDS = Object.keys(STYLES) as StyleId[];

export const STRUCTURES: { id: StructureId; label: string }[] = [
  { id: 'arc', label: 'Intro → Development → Variation → Outro' },
  { id: 'aba', label: 'A → B → A' },
  { id: 'continuous', label: 'Slowly evolving continuous texture' },
  { id: 'mutation', label: 'Repeating motif, progressive mutation' },
  { id: 'contrast', label: 'Multiple contrasting sections' },
];

export function defaultComposition(): CompositionSettings {
  return {
    style: 'ambient', structure: 'arc', source: 'none', bars: 32, seed: 1, complexity: 0.5, variation: 0.5, density: 0.5,
    repetition: 0.6, probability: 0.85, tension: 0.4, irregularity: 0.3, range: 0.5, register: 0.5, mutation: 0.35, evolution: 0.5,
    locks: { melody: false, harmony: false, rhythm: false, instruments: false, selected: true }, bypassScale: true,
  };
}

export function planSections(c: CompositionSettings, bb: number, r: Rng): Section[] {
  const bars = Math.max(4, Math.round(c.bars));
  const plan: { name: string; frac: number; intensity: number; variant: number }[] = (() => {
    switch (c.structure) {
      case 'aba': return [{ name: 'A', frac: 0.38, intensity: 0.6, variant: 0 }, { name: 'B', frac: 0.3, intensity: 0.85, variant: 1 }, { name: 'A′', frac: 0.32, intensity: 0.65, variant: 0 }];
      case 'continuous': return [{ name: 'Continuum', frac: 1, intensity: 0.6, variant: 0 }];
      case 'mutation': {
        const k = Math.max(2, Math.round(bars / 8));
        return Array.from({ length: k }, (_, i) => ({ name: `Mutation ${i + 1}`, frac: 1 / k, intensity: 0.45 + 0.5 * (i / Math.max(1, k - 1)), variant: 0 }));
      }
      case 'contrast': {
        const k = Math.max(2, Math.round(bars / 8));
        return Array.from({ length: k }, (_, i) => ({ name: i % 2 ? 'Contrast' : 'Statement', frac: 1 / k, intensity: i % 2 ? 0.35 + r() * 0.15 : 0.75 + r() * 0.2, variant: i % 2 }));
      }
      default: return [{ name: 'Intro', frac: 0.15, intensity: 0.35, variant: 0 }, { name: 'Development', frac: 0.35, intensity: 0.7, variant: 0 }, { name: 'Variation', frac: 0.35, intensity: 0.92, variant: 1 }, { name: 'Outro', frac: 0.15, intensity: 0.4, variant: 0 }];
    }
  })();
  const out: Section[] = [];
  let at = 0;
  plan.forEach((p, i) => {
    const len = i === plan.length - 1 ? bars - at : Math.max(1, Math.round(p.frac * bars));
    if (len <= 0) return;
    out.push({ name: p.name, start: at * bb, bars: len, intensity: Math.min(1, p.intensity * (0.7 + c.density * 0.6)), variant: p.variant });
    at += len;
  });
  return out;
}

/** Drawing as a guide curve: stroke density → "edges/texture", mean height → contour/brightness. */
export function drawingCurve(strokes: Stroke[], beats: number, steps = 128): Curve {
  const mk = () => new Float32Array(steps);
  const cv: Curve = { n: steps, brightness: mk(), saturation: mk(), hue: mk(), hueStrength: mk(), contrast: mk(), edges: mk(), texture: mk(), variation: mk(), centroid: mk(), orientation: mk(), periodicity: mk(), profile: [] };
  const sums = new Float32Array(steps), cnt = new Float32Array(steps);
  for (const s of strokes) for (const p of s.points) {
    const j = Math.max(0, Math.min(steps - 1, Math.floor((p.x / Math.max(1, beats)) * steps)));
    sums[j] += p.y; cnt[j]++;
  }
  let prev = 0.5;
  const maxCnt = Math.max(1, ...cnt);
  for (let j = 0; j < steps; j++) {
    const y = cnt[j] ? sums[j] / cnt[j] : prev;
    prev = y;
    cv.centroid[j] = y; cv.brightness[j] = y;
    cv.edges[j] = cnt[j] / maxCnt; cv.texture[j] = cv.edges[j];
    cv.saturation[j] = 0.4; cv.hue[j] = y; cv.contrast[j] = cv.edges[j] * 0.6;
    cv.variation[j] = j ? Math.min(1, Math.abs(cv.centroid[j] - cv.centroid[j - 1]) * 4) : 0;
    cv.orientation[j] = 0.5;
    cv.profile.push(new Float32Array(1));
  }
  return cv;
}

interface Ctx {
  c: CompositionSettings;
  ps: ProjectSettings;
  style: StyleProfile;
  bb: number;
  beats: number;
  harmony: ChordSlot[];
  sections: Section[];
  guide?: Curve;
  atonal: boolean;
  row: number[];
}

const c01 = (x: number) => Math.max(0, Math.min(1, x));

function intensityAt(ctx: Ctx, sec: Section, beat: number): number {
  let i = sec.intensity;
  if (ctx.c.structure === 'continuous') i *= 0.75 + 0.25 * Math.sin((beat / ctx.beats) * Math.PI * 2 * (1 + ctx.c.evolution));
  if (ctx.guide) i *= 0.6 + 0.8 * curveValue(ctx.guide, 'edges', beat / ctx.beats);
  return c01(i);
}

type Pattern = NoteEvent[];

function shiftPattern(p: Pattern, dBeat: number, dDegree: number, ctx: Ctx, base: number, prefix: string): Pattern {
  return p.map((n, k) => {
    const out: NoteEvent = { ...n, id: `${prefix}_${k}`, start: n.start + dBeat };
    if (n.degree !== undefined && dDegree) {
      out.degree = n.degree + dDegree;
      out.midi = degreeToMidi(out.degree, ctx.ps.key, ctx.ps.scale, base, ctx.ps.customScale);
    }
    return out;
  });
}

/** Controlled mutation of a remembered phrase: nudge pitches, drop or add notes, displace timing. */
function mutate(p: Pattern, amount: number, r: Rng, ctx: Ctx, base: number, step: number): Pattern {
  if (amount <= 0) return p;
  const out: Pattern = [];
  for (const n of p) {
    const x = r();
    if (x < amount * 0.18) continue; // drop
    let m = { ...n };
    if (r() < amount * 0.45 && m.degree !== undefined) {
      m.degree = m.degree + r.pick([-2, -1, 1, 2]);
      m.midi = degreeToMidi(m.degree, ctx.ps.key, ctx.ps.scale, base, ctx.ps.customScale);
    }
    if (r() < amount * 0.2) m = { ...m, start: Math.max(0, m.start + r.pick([-step, step])) };
    out.push(m);
    if (r() < amount * 0.12) {
      // add a passing note
      const extra = { ...m, start: m.start + step, dur: Math.min(m.dur, step), id: `${m.id}x` };
      if (extra.degree !== undefined) { extra.degree += r.pick([-1, 1]); extra.midi = degreeToMidi(extra.degree, ctx.ps.key, ctx.ps.scale, base, ctx.ps.customScale); }
      out.push(extra);
    }
  }
  return out;
}

const rootDegree = (slot: ChordSlot) => (slot.chord.degree >= 0 ? slot.chord.degree : 0);

/** Phrase generators per layer. Each returns notes for [start, start + bars·bb). */
function genPhrase(id: LayerId, ctx: Ctx, sec: Section, start: number, bars: number, r: Rng, base: number, range: { low: number; high: number }, spec: RhythmSpec): Pattern {
  const { c, ps, bb } = ctx;
  const len = bars * bb;
  const end = start + len;
  const notes: Pattern = [];
  const deg = (d: number) => degreeToMidi(d, ps.key, ps.scale, base, ps.customScale);
  const n = scaleIntervals(ps.scale, ps.customScale).length;
  const add = (beat: number, dur: number, midi: number, vel: number, degree?: number) => {
    if (beat < start - 1e-9 || beat >= end - 1e-9) return;
    if (c.probability < 1 && vel < 0.9 && !r.chance(0.5 + c.probability * 0.5)) return;
    notes.push({ id: '', start: beat, dur: Math.max(0.04, Math.min(dur, ctx.beats - beat)), midi, vel: c01(vel), origin: 'generated', degree });
  };
  const inten = intensityAt(ctx, sec, start);
  const style = c.style;
  const ts = ps.timeSig;
  const info = TIME_SIGS[ts];

  switch (id) {
    case 'drums': {
      for (let bar = 0; bar < bars; bar++) {
        const b0 = start + bar * bb;
        const groups: number[] = [];
        { let p = 0; for (const g of info.groups) { groups.push(p * info.pulse); p += g; } }
        const lastGroup = groups[groups.length - 1];
        if (style === 'motorik') {
          for (const g of groups) add(b0 + g, 0.2, 36, g === 0 ? 1 : 0.85);
          if (inten > 0.6) add(b0 + lastGroup + info.pulse * 0.5, 0.2, 36, 0.6);
          for (let k = 1; k < groups.length; k += 2) add(b0 + groups[k], 0.2, 38, 0.8);
          if (groups.length === 1 || ts === '3/4') add(b0 + info.pulse * 2, 0.2, 38, 0.75);
          for (let b = 0; b < bb - 1e-9; b += 0.5) add(b0 + b, 0.1, b % 1 ? 42 : 42, b % 1 ? 0.45 : 0.6);
          if (inten > 0.75 && bar % 2 === 1) add(b0 + bb - 0.5, 0.4, 46, 0.5);
        } else if (style === 'ambientDub') {
          // one-drop: kick + rim together in the middle of the bar, echoing hats
          const mid = groups[Math.floor(groups.length / 2)] ?? bb / 2;
          add(b0 + mid, 0.3, 36, 0.85);
          add(b0 + mid, 0.1, 37, 0.7);
          const hats = expandRhythm({ ...spec, subdiv: 4 }, bb, ts, r.fork(`dubhat${bar}`), 0);
          for (const h of hats) add(b0 + h.beat, 0.08, 42, 0.3 + h.accent * 0.25);
          if (r.chance(0.2 + inten * 0.3)) add(b0 + bb - 0.25, 0.3, 39, 0.5);
        } else if (style === 'idm') {
          // changing subdivision per bar, polymetric euclid voices, ratchets
          const sub = r.weighted([4, 3, 6, 8], [3, 2, 1.5, 1 + c.irregularity * 2]);
          const steps = Math.round(bb * sub);
          const kick = euclid(r.int(2, 4), Math.min(steps, 16), r.int(0, 3));
          const snr = euclid(r.int(1, 3), Math.min(steps, 13), r.int(1, 6));
          for (let s = 0; s < steps; s++) {
            const b = b0 + s / sub;
            if (kick[s % kick.length]) add(b, 0.15, 36, 0.8 + r() * 0.2);
            if (snr[s % snr.length] && !kick[s % kick.length]) add(b, 0.12, r.chance(0.5) ? 38 : 37, 0.6 + r() * 0.3);
            if (r.chance(0.12 + c.irregularity * 0.2)) {
              const rat = r.pick([2, 3, 4]);
              for (let k = 0; k < rat; k++) add(b + k / sub / rat, 0.05, r.pick([42, 37, 56]), 0.5 - k * 0.08);
            }
          }
          const hats = expandRhythm({ ...spec }, bb, ts, r.fork(`idmhat${bar}`), 0);
          for (const h of hats) add(b0 + h.beat, 0.05, 42, 0.25 + h.accent * 0.3);
        } else if (style === 'minimal') {
          for (const g of groups) add(b0 + g, 0.15, 36, 0.65);
          const clicks = expandRhythm({ ...spec, rotation: spec.rotation + Math.floor((start / bb + bar) / 4) }, bb, ts, r.fork(`click${bar}`), 0);
          for (const h of clicks) add(b0 + h.beat, 0.05, 37, 0.45 + h.accent * 0.3);
          for (let b = 0.25; b < bb; b += 0.25) if (r.chance(inten * 0.6)) add(b0 + b, 0.04, 42, 0.25 + metricWeight(ts, b) * 0.2);
        } else if (style === 'cinematic') {
          for (const g of groups) { add(b0 + g, 0.4, 36, 0.9); add(b0 + g, 0.6, 56, 0.4); }
          if (bar === bars - 1) for (let k = 0; k < 8; k++) add(b0 + bb - 1 + k / 8, 0.08, 38, 0.3 + k * 0.08);
        } else {
          // atonal: irregular partitions of the bar
          let b = 0;
          while (b < bb - 1e-9) {
            const d = r.pick([0.25, 0.5, 0.75, 1.25]) * (0.8 + c.irregularity);
            if (r.chance(0.5 + inten * 0.3)) add(b0 + b, 0.1, r.pick([56, 37, 39]), 0.4 + r() * 0.4);
            b += d;
          }
        }
      }
      break;
    }
    case 'bass': {
      for (let b = start; b < end - 1e-9; ) {
        const slot = chordAt(ctx.harmony, b);
        const rd = rootDegree(slot);
        if (style === 'motorik') {
          const d = r.chance(0.12 * (1 + c.complexity)) && b % 1 ? rd + n : rd;
          add(b, 0.42, deg(d), b % 1 ? 0.6 : 0.85, d);
          b += 0.5;
        } else if (style === 'ambient' || style === 'drone') {
          add(b, slot.start + slot.dur - b, deg(rd), 0.55, rd);
          b = slot.start + slot.dur;
        } else if (style === 'cinematic') {
          if (inten > 0.6) { add(b, 0.45, deg(rd), b % 1 ? 0.55 : 0.8, rd); b += 0.5; }
          else { add(b, Math.min(bb * 2, slot.start + slot.dur - b), deg(rd), 0.65, rd); b += Math.min(bb * 2, slot.start + slot.dur - b); }
        } else break;
      }
      if (style === 'ambientDub' || style === 'idm' || style === 'minimal') {
        // rhythm-spec driven: independent pattern length → the bass phases against the bar
        const onsets = expandRhythm(spec, len, ts, r.fork('bass'), 0);
        let prevDeg = 0;
        for (const o of onsets) {
          const b = start + o.beat;
          const rd = rootDegree(chordAt(ctx.harmony, b));
          let d = rd;
          if (style === 'idm') d = rd + r.weighted([0, n, 4, -3, n + 4], [3, 2, 2, 1, c.irregularity * 2]);
          else if (style === 'ambientDub') d = o.accent >= 0.75 ? rd : rd + r.weighted([0, 4, 2, n], [3, 2, 1, 1]);
          if (style === 'minimal' && o.accent >= 0.75 && r.chance(0.6)) continue; // offbeat-led
          const dur = style === 'ambientDub' ? Math.min(1.5, o.dur * 1.6) : o.dur * (style === 'minimal' ? 0.4 : 0.7);
          add(b, dur, deg(d), 0.6 + o.accent * 0.35, d);
          prevDeg = d;
        }
        void prevDeg;
      }
      break;
    }
    case 'pad':
    case 'chords': {
      const atonal = ctx.atonal;
      let prev: number[] | null = null;
      for (const slot of ctx.harmony) {
        if (slot.start + slot.dur <= start || slot.start >= end) continue;
        const a = Math.max(start, slot.start);
        const z = Math.min(end, slot.start + slot.dur);
        const chord = atonal ? chordFromQuality(ctx.row[Math.floor(a / bb) % 12], r.pick(['cluster', 'quartal', 'maj7s11'] as const), -1) : slot.chord;
        const size = Math.max(2, Math.min(6, 3 + Math.round(c.complexity * 2 + (style === 'drone' ? 1 : 0))));
        const v = voiceLead(prev, chord, range.low, range.high, size);
        prev = v;
        const dIdx = (m: number) => (!atonal && inScale(m, ps.key, ps.scale, ps.customScale) ? midiToDegree(m, ps.key, ps.scale, base, ps.customScale) : undefined);
        if (id === 'pad') {
          const vel = 0.3 + inten * 0.35;
          v.forEach((m, j) => add(a + j * 0.015, z - a, m, vel * (j ? 0.85 : 1), dIdx(m)));
        } else if (style === 'ambientDub') {
          // off-beat skank stabs
          for (let b = a; b < z - 1e-9; b += 1) {
            const pos = ((b % bb) + bb) % bb;
            if (Math.floor(pos) % 2 === 1 || ts === '6/8' || ts === '9/8') v.forEach((m) => add(b + 0.5 * (ts === '6/8' || ts === '9/8' ? 1 : 0), 0.22, m, 0.55, dIdx(m)));
          }
        } else if (style === 'minimal') {
          const hits = expandRhythm({ ...spec, length: spec.length + 3, pulses: Math.max(2, spec.pulses - 1) }, z - a, ts, r.fork(`cl${a}`), 0);
          for (const h of hits) v.slice(0, 3).forEach((m) => add(a + h.beat, 0.12, m, 0.4 + h.accent * 0.3, dIdx(m)));
        } else if (style === 'idm' || atonal) {
          let b = a;
          while (b < z - 1e-9) {
            if (r.chance(0.45 + inten * 0.3)) v.forEach((m, j) => add(b + j * r.pick([0, 0.02, 0.05]), r.pick([0.25, 0.5, 1.5]), m, 0.45 + r() * 0.3, dIdx(m)));
            b += r.pick([0.75, 1, 1.25, 1.5, 2]);
          }
        } else {
          for (let b = a; b < z - 1e-9; b += bb) v.forEach((m) => add(b, Math.min(bb, z - b) * 0.9, m, 0.45 + inten * 0.3, dIdx(m)));
        }
      }
      break;
    }
    case 'drone':
    case 'drone2': {
      const slot = chordAt(ctx.harmony, start);
      const rd = rootDegree(slot);
      const tones = id === 'drone' ? [rd, rd + (n >= 7 ? 4 : 3)] : [rd + n, rd + n + 2];
      tones.forEach((d, j) => add(start + j * 0.05, len, deg(d), 0.45 + inten * 0.2, d));
      break;
    }
    case 'arp': {
      const sub = style === 'motorik' ? 4 : style === 'cinematic' ? 2 : 4;
      const stepLen = 1 / sub;
      const patLen = Math.max(3, Math.min(16, spec.length));
      const pat = Array.from({ length: patLen }, (_, k) => (style === 'motorik' ? [0, 1, 2, 3, 2, 1, 4, 2][k % 8] : r.int(0, 4)));
      for (let k = 0, b = start; b < end - 1e-9; k++, b += stepLen) {
        if (spec.probability < 1 && !r.chance(spec.probability)) continue;
        const slot = chordAt(ctx.harmony, b);
        const tones = voiceLead(null, slot.chord, range.low, range.high, 4);
        const ext = [...tones, ...tones.map((m) => m + 12)];
        const m = ext[pat[k % patLen] % ext.length];
        const d = inScale(m, ps.key, ps.scale, ps.customScale) ? midiToDegree(m, ps.key, ps.scale, base, ps.customScale) : undefined;
        add(b, stepLen * 0.75, m, 0.45 + metricWeight(ts, ((b % bb) + bb) % bb) * 0.3, d);
      }
      break;
    }
    case 'melody': {
      const behaviors = ctx.style.melody;
      const behavior = ctx.guide && behaviors.includes('contour') ? 'contour' : behaviors[Math.min(behaviors.length - 1, Math.floor(c.complexity * behaviors.length))];
      const sub = style === 'ambient' || style === 'drone' ? 1 : style === 'idm' ? 4 : 2;
      const onsetSpec: RhythmSpec = style === 'idm' || style === 'atonal'
        ? { ...spec }
        : { subdiv: sub, length: Math.round(bb * sub), pulses: Math.max(1, Math.round(bb * sub * (0.25 + c.density * 0.5))), rotation: 0, probability: 1, ratchet: 0, humanize: spec.humanize };
      const onsets = expandRhythm(onsetSpec, len, ts, r.fork('mel'), 0).map((o) => ({ ...o, beat: o.beat + start }));
      const span = Math.round(5 + c.range * 9);
      const reg = Math.round((c.register - 0.5) * n);
      const mid = midiToDegree(Math.round((range.low + range.high) / 2), ps.key, ps.scale, base, ps.customScale) + reg;
      const mel = generateMelody({
        onsets, behavior, chords: ctx.harmony, root: ps.key, scale: ps.scale, custom: ps.customScale, base,
        lo: mid - Math.floor(span / 2), hi: mid + Math.ceil(span / 2), rng: r, restProb: style === 'ambient' ? 0.5 : 0.2 + (1 - c.density) * 0.3,
        phraseBeats: bb * 2, contour: ctx.guide ? (t) => curveValue(ctx.guide!, 'centroid', t) : undefined, totalBeats: ctx.beats, velocity: 0.55 + inten * 0.3,
      });
      for (const m of mel) {
        const dur = style === 'ambient' ? Math.max(m.dur, 2) : m.dur * (style === 'motorik' ? 0.6 : 0.85);
        if (ctx.atonal) {
          const pc = ctx.row[(m.degree ?? 0) % 12 < 0 ? 0 : (m.degree ?? 0) % 12];
          const midi = range.low + 12 + ((pc - range.low % 12 + 12) % 12) + 12 * r.int(-1, 1);
          add(m.beat, dur, midi, m.vel);
        } else add(m.beat, dur, m.midi, m.vel, m.degree);
      }
      break;
    }
    case 'texture': {
      const g = ctx.guide;
      if (style === 'ambient') {
        for (let b = start; b < end - 1e-9; b += 0.5) {
          if (!r.chance(0.05 + inten * 0.08)) continue;
          const slot = chordAt(ctx.harmony, b);
          const pc = r.pick(slot.chord.pcs);
          const midi = 72 + ((pc - 72 % 12 + 12) % 12) + 12 * r.int(0, 1);
          add(b, 3, midi, 0.25 + r() * 0.25, inScale(midi, ps.key, ps.scale, ps.customScale) ? midiToDegree(midi, ps.key, ps.scale, base, ps.customScale) : undefined);
        }
      } else {
        const step = style === 'idm' ? 0.125 : 0.25;
        for (let b = start; b < end - 1e-9; b += step) {
          const gt = g ? curveValue(g, 'texture', b / ctx.beats) : 0.5;
          const p = (style === 'drone' ? 0.03 : 0.08 + c.complexity * 0.12) * (0.5 + gt) * (0.5 + inten);
          if (!r.chance(p)) continue;
          const burst = style === 'idm' && r.chance(0.3) ? r.int(2, 4) : 1;
          const midi = r.int(range.low, range.high);
          for (let k = 0; k < burst; k++) add(b + (k * step) / burst, step * 0.4, midi, 0.35 + r() * 0.4);
        }
      }
      break;
    }
  }
  return notes;
}

function layerRhythm(id: LayerId, c: CompositionSettings, style: StyleId): RhythmSpec {
  const irr = c.irregularity;
  const d = c.density;
  switch (id) {
    case 'bass':
      if (style === 'idm') return defaultRhythm({ subdiv: 4, length: irr > 0.5 ? 7 : 11, pulses: Math.max(2, Math.round(3 + d * 3)), rotation: Math.round(irr * 3), humanize: 0.2 });
      if (style === 'ambientDub') return defaultRhythm({ subdiv: 4, length: 16, pulses: Math.max(2, Math.round(3 + d * 3)), rotation: 2, humanize: 0.3 });
      if (style === 'minimal') return defaultRhythm({ subdiv: 4, length: 16, pulses: Math.max(2, Math.round(4 + d * 4)), rotation: 1 + Math.round(irr * 2), humanize: 0 });
      return defaultRhythm({ subdiv: 2, length: 8, pulses: 8 });
    case 'drums':
      if (style === 'idm') return defaultRhythm({ subdiv: 4, length: irr > 0.5 ? 13 : 5, pulses: Math.max(2, Math.round(2 + d * 6)), rotation: 1, humanize: 0.15 });
      if (style === 'minimal') return defaultRhythm({ subdiv: 4, length: 16, pulses: Math.max(3, Math.round(3 + d * 4)), rotation: 0 });
      return defaultRhythm({ subdiv: 4, length: 16, pulses: Math.max(2, Math.round(3 + d * 6)), rotation: 2, humanize: 0.25 });
    case 'arp':
      return defaultRhythm({ subdiv: 4, length: style === 'motorik' ? 8 : 6 + Math.round(irr * 4), pulses: 8, probability: 0.75 + d * 0.25 });
    case 'chords':
      return defaultRhythm({ subdiv: 4, length: 16 - Math.round(irr * 4), pulses: Math.max(2, Math.round(3 + d * 3)), rotation: 3 });
    case 'melody':
      return defaultRhythm({ subdiv: 4, length: style === 'idm' ? 5 + Math.round(irr * 4) : 16, pulses: Math.max(2, Math.round(2 + d * 5)), rotation: Math.round(irr * 2), humanize: 0.2 });
    default:
      return defaultRhythm({ subdiv: 4, length: 16, pulses: 4 });
  }
}

export interface ComposeInput {
  comp: CompositionSettings;
  settings: ProjectSettings;
  guide?: Curve;
  /** previously generated layers (for locks) keyed by generator key */
  previous?: Map<string, { notes: NoteEvent[]; rhythm: RhythmSpec }>;
  previousHarmony?: ChordSlot[];
  /** regenerate only this key */
  only?: string;
  /** user-edited rhythm specs per key — used instead of the style default */
  rhythms?: Map<string, RhythmSpec>;
}

export interface ComposeResult { layers: LayerOutput[]; harmony: ChordSlot[]; sections: Section[]; bpm: number }

export function compose(input: ComposeInput): ComposeResult {
  const { comp: c, settings: ps } = input;
  const style = STYLES[c.style];
  const bb = barBeats(ps.timeSig);
  const beats = Math.max(4, Math.round(c.bars)) * bb;
  const R = rng(hash32(`compose:${c.seed}:${c.style}`));
  const sections = planSections(c, bb, R.fork('sections'));
  const n = scaleIntervals(ps.scale, ps.customScale).length;
  const harmony = input.previousHarmony && c.locks.harmony
    ? input.previousHarmony
    : generateProgression({
      type: c.tension > 0.7 && style.progression === 'sparse' ? 'tension' : style.progression,
      beats, barBeats: bb, root: ps.key, scale: ps.scale, custom: ps.customScale,
      harmonicRhythm: Math.max(0.5, style.harmonicRhythm * (1.3 - c.complexity * 0.6)), tension: c.tension,
      chordSize: c.complexity > 0.66 ? 4 : 3, rng: R.fork('harmony'),
      guide: input.guide ? (t) => ({ degree: Math.round(curveValue(input.guide!, 'hue', t) * n) % n, strength: curveValue(input.guide!, 'saturation', t) }) : undefined,
    });
  const rowR = R.fork('row');
  const row = Array.from({ length: 12 }, (_, i) => i);
  for (let i = 11; i > 0; i--) { const j = rowR.int(0, i); [row[i], row[j]] = [row[j], row[i]]; }
  const ctx: Ctx = { c, ps, style, bb, beats, harmony, sections, guide: input.guide, atonal: c.style === 'atonal' && c.bypassScale, row };

  const layers: LayerOutput[] = [];
  for (const [lid, threshold] of Object.entries(style.layers) as [LayerId, number][]) {
    const key = `gen:${lid}`;
    if (input.only && input.only !== key) continue;
    const role = LAYER_ROLE[lid];
    const range = { ...ROLE_RANGE[role] };
    if (role === 'melody' || role === 'pad' || role === 'arp' || role === 'chords') {
      const shift = Math.round((c.register - 0.5) * 12);
      range.low += shift; range.high += shift;
    }
    const base = 12 * Math.floor(range.low / 12);
    const spec = input.rhythms?.get(key) ?? layerRhythm(lid, c, c.style);
    const prev = input.previous?.get(key);
    const keepWhole = (lid === 'melody' && c.locks.melody && prev);
    let notes: NoteEvent[] = [];
    if (keepWhole) {
      notes = prev.notes;
    } else {
      const memory = new Map<number, { pattern: Pattern; at: number; rootDeg: number }>();
      let pi = 0;
      for (const sec of sections) {
        const phraseBars = style.phraseBars;
        for (let pb = 0; pb < sec.bars; pb += phraseBars, pi++) {
          const bars = Math.min(phraseBars, sec.bars - pb);
          const start = sec.start + pb * bb;
          const inten = intensityAt(ctx, sec, start);
          // layers enter by section intensity; the first layer always plays
          if (inten < threshold * (1.1 - c.complexity * 0.3) && threshold > 0) continue;
          const pr = R.fork(`${key}:${pi}`);
          const mem = memory.get(sec.variant);
          const reuse = mem && pr.chance(c.repetition * (1 - c.variation * 0.5)) && role !== 'pad' && role !== 'drone';
          let pattern: Pattern;
          if (reuse && mem) {
            const rd = rootDegree(chordAt(harmony, start));
            const shifted = shiftPattern(mem.pattern, start - mem.at, role === 'percussion' || role === 'texture' ? 0 : rd - mem.rootDeg, ctx, base, `${key}_${pi}`)
              .filter((x) => x.start < start + bars * bb - 1e-9);
            const progress = pi / Math.max(1, Math.ceil(c.bars / phraseBars));
            pattern = mutate(shifted, c.mutation * (0.25 + c.evolution * progress), pr.fork('mut'), ctx, base, 1 / spec.subdiv);
          } else {
            pattern = genPhrase(lid, ctx, sec, start, bars, pr, base, range, spec);
            memory.set(sec.variant, { pattern, at: start, rootDeg: rootDegree(chordAt(harmony, start)) });
          }
          notes.push(...pattern);
        }
      }
      // rhythm lock: keep previous onsets, take pitches from the new material
      if (c.locks.rhythm && prev && prev.notes.length && notes.length) {
        const fresh = notes;
        notes = prev.notes.map((o, k) => {
          const src = fresh[k % fresh.length];
          return { ...o, midi: src.midi, degree: src.degree };
        });
      }
    }
    notes = notes.filter((x) => x.start < beats - 1e-9).sort((a, z) => a.start - z.start || a.midi - z.midi).map((x, k) => ({ ...x, id: `${key}_${k}` }));
    const patchName = style.patches[lid] ?? undefined;
    const patch = patchName ? instrument(patchName) : undefined;
    if (lid === 'drone2' && patch) { patch.osc1.detune += 7; patch.osc2.detune -= 7; }
    const out = layer(key, `${LAYER_NAME[lid]}`, role, sourceFor(role), {
      patch, pitch: role === 'percussion' ? { mode: 'drums', low: 36, high: 56 } : ctx.atonal ? { mode: 'chromatic', low: range.low, high: range.high } : { ...range, mode: role === 'texture' ? 'chromatic' : 'scale' },
      notes, rhythm: spec, automation: evolutionLanes(lid, ctx, R.fork(`auto:${key}`)), fx: styleFx(lid, c.style), mix: styleMix(lid, c.style),
    });
    layers.push(out);
  }
  return { layers, harmony, sections, bpm: style.tempo };
}

function sourceFor(role: Role) {
  switch (role) {
    case 'melody': case 'arp': return 'genMelody' as const;
    case 'pad': case 'chords': case 'drone': return 'genChords' as const;
    case 'bass': return 'genBass' as const;
    case 'percussion': return 'genPerc' as const;
    default: return 'genTexture' as const;
  }
}

function styleFx(lid: LayerId, style: StyleId): EffectSlot[] | undefined {
  const id = (t: string) => `fx_gen_${lid}_${t}`;
  if (style === 'ambientDub' && lid === 'chords') return [fxSlot('filter', { mode: 1, cutoff: 600, res: 2 }, id('hp')), fxSlot('delay', { time: 0.6, feedback: 0.62, wet: 0.45 }, id('echo'))];
  if (style === 'ambientDub' && lid === 'drums') return [fxSlot('pingpong', { time: 0.4, feedback: 0.4, wet: 0.18 }, id('pp'))];
  if ((style === 'ambient' || style === 'drone') && (lid === 'pad' || lid === 'drone')) return [fxSlot('atmosSweep', {}, id('sweep'))];
  if (style === 'motorik' && lid === 'arp') return [fxSlot('filter', { cutoff: 1400, res: 4 }, id('lp')), fxSlot('delay', { time: 0.357, feedback: 0.3, wet: 0.2 }, id('dl'))];
  if (style === 'idm' && lid === 'texture') return [fxSlot('bitcrusher', { bits: 6, wet: 0.5 }, id('bc'))];
  if (style === 'idm' && lid === 'melody') return [fxSlot('pingpong', { time: 0.18, feedback: 0.35, wet: 0.25 }, id('pp'))];
  if (style === 'cinematic' && lid === 'pad') return [fxSlot('chorus', {}, id('ch')), fxSlot('reverb', { decay: 6, wet: 0.3 }, id('rv'))];
  return undefined;
}

function styleMix(lid: LayerId, style: StyleId): Partial<Mix> | undefined {
  if (style === 'ambientDub' && lid === 'chords') return { delay: 0.5, reverb: 0.3, volume: -9 };
  if (style === 'ambientDub' && lid === 'drums') return { delay: 0.25, volume: -6 };
  if (lid === 'drone2') return { pan: 0.3, volume: -11 };
  if (lid === 'drone') return { pan: -0.2 };
  return undefined;
}

/** Long-form transformation lanes: the timbre evolves over the whole piece at the evolution rate. */
function evolutionLanes(lid: LayerId, ctx: Ctx, r: Rng): AutomationLane[] {
  const { c, beats } = ctx;
  const lanes: AutomationLane[] = [];
  const walk = (lo: number, hi: number, every: number, drift: number) => {
    const pts: { beat: number; value: number }[] = [];
    let v = (lo + hi) / 2;
    for (let b = 0; b <= beats + 1e-6; b += every) {
      v = Math.max(lo, Math.min(hi, v + (r() - 0.5) * drift * (0.3 + c.evolution)));
      pts.push({ beat: b, value: v });
    }
    return pts;
  };
  const style = c.style;
  if (style === 'motorik' && (lid === 'arp' || lid === 'pad')) {
    // gradual opening over the piece, with slow phrase-level waves
    const pts = [];
    for (let b = 0; b <= beats; b += 2) pts.push({ beat: b, value: 0.35 + 0.5 * Math.pow(b / beats, 1 - c.evolution * 0.5) + Math.sin(b / 16) * 0.05 });
    lanes.push({ id: `evo_${lid}_cutoff`, target: 'cutoff', points: pts, origin: 'generated' });
  } else if ((style === 'ambient' || style === 'drone') && (lid === 'pad' || lid === 'drone' || lid === 'drone2')) {
    lanes.push({ id: `evo_${lid}_cutoff`, target: 'cutoff', points: walk(0.35, 0.9, 4, 0.25), origin: 'generated' });
    lanes.push({ id: `evo_${lid}_pan`, target: 'pan', points: walk(0.2, 0.8, 8, 0.4), origin: 'generated' });
  } else if (style === 'ambientDub' && lid === 'chords') {
    // echo throws: delay send spikes at phrase ends
    const pts = [];
    for (let b = 0; b <= beats; b += 1) pts.push({ beat: b, value: ((b + 1) % (ctx.bb * 4)) < 1.01 && r.chance(0.6) ? 1 : 0.35 });
    lanes.push({ id: `evo_${lid}_dly`, target: 'delaySend', points: pts, origin: 'generated' });
  } else if (style === 'cinematic' && lid === 'pad') {
    const pts = ctx.sections.flatMap((s) => [{ beat: s.start, value: 0.5 + s.intensity * 0.4 }, { beat: s.start + s.bars * ctx.bb - 0.01, value: 0.55 + s.intensity * 0.45 }]);
    lanes.push({ id: `evo_${lid}_vol`, target: 'volume', points: pts, origin: 'generated' });
  } else if (style === 'idm' && lid === 'texture') {
    lanes.push({ id: `evo_${lid}_crush`, target: 'crush', points: walk(0.1, 0.9, 2, 0.6), origin: 'generated' });
  }
  return lanes;
}

/** Bar-wise blend of old and regenerated notes: `variation` = share of bars taken from the new take. */
export function blendByBars(oldNotes: NoteEvent[], newNotes: NoteEvent[], variation: number, bb: number, seed: number): NoteEvent[] {
  if (variation >= 0.999 || !oldNotes.length) return newNotes;
  if (variation <= 0.001) return oldNotes;
  const r = rng(hash32(`blend:${seed}`));
  const last = Math.max(...oldNotes.map((n) => n.start), ...newNotes.map((n) => n.start), 0);
  const bars = Math.ceil((last + 1e-6) / bb) + 1;
  const takeNew = Array.from({ length: bars }, () => r() < variation);
  const barOf = (n: NoteEvent) => Math.floor(n.start / bb + 1e-9);
  return [...oldNotes.filter((n) => !takeNew[barOf(n)]), ...newNotes.filter((n) => takeNew[barOf(n)])].sort((a, z) => a.start - z.start);
}
