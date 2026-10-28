// GENERATIVE COMPOSER. A piece is planned before a single note is written:
//   A. key, scale and harmonic behaviour come from the project (the shared musical context);
//   B. a progression or modal centre is chosen (style default, the harmony panel, or locked);
//   C. a principal motif — the theme — is invented (and a second one for contrasting sections);
//   D. each layer gets a musical role; E. each role its own rhythmic identity (pattern length,
//      subdivision, phase) so layers form polyrhythms rather than one grid;
//   F. complementary material is written against the harmony (bass on roots/pedals, pads voice-led,
//      arpeggios on real chord tones, the melody developing the theme);
//   G–I. phrases develop (sequence, fragmentation, inversion, augmentation, gradual substitution),
//      sections change intensity and texture, and cadences resolve, suspend or stay open by style.
// Every decision draws from seeded RNG streams forked per (layer, section, phrase), so the same
// inputs + seed reproduce identical events, and changing one setting does not reshuffle everything.
// A final harmonic fit enforces the behaviour (Strict: in-scale, chord tones on strong beats).

import type { AutomationLane, ChordColour, CompositionSettings, EffectSlot, HarmonySettings, Mix, NoteEvent, ProjectSettings, Role, RhythmSpec, StructureId, StyleId, Stroke } from '../core/types';
import { hash32, rng, type Rng } from '../core/rng';
import { TIME_SIGS, barBeats, beatStrength, metricWeight } from '../core/time';
import type { Curve } from '../analysis/features';
import { curveValue } from '../analysis/features';
import { type ChordSlot, type ProgressionType, chordAt, generateProgression } from '../theory/progression';
import { chordFromQuality, voiceLead } from '../theory/chords';
import { defaultRhythm, euclid, expandRhythm } from '../theory/rhythm';
import { degreeToMidi, midiToDegree, inScale, scaleIntervals } from '../theory/scales';
import { type MusicalContext, musicalContext, slotAt } from '../theory/context';
import { type Grammar, type Motif, chordAnchor, makeMotif, planPhrase, realiseUnit, substitute, displace, invert } from '../theory/motif';
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
  colour: ChordColour;
  phraseBars: number;
  /** layer → minimum section intensity at which it plays */
  layers: Partial<Record<LayerId, number>>;
  patches: Partial<Record<LayerId, string>>;
  /** melodic grammar of the theme */
  grammar: Grammar;
  /** share of melody statements left silent (negative space) */
  silence: number;
}

type LayerId = 'drums' | 'bass' | 'pad' | 'chords' | 'drone' | 'drone2' | 'arp' | 'melody' | 'texture';
const LAYER_ROLE: Record<LayerId, Role> = { drums: 'percussion', bass: 'bass', pad: 'pad', chords: 'chords', drone: 'drone', drone2: 'drone', arp: 'arp', melody: 'melody', texture: 'texture' };
const LAYER_NAME: Record<LayerId, string> = { drums: 'Drums', bass: 'Bass', pad: 'Pads', chords: 'Chords', drone: 'Drone', drone2: 'Drone (detuned)', arp: 'Arpeggio', melody: 'Melody', texture: 'Texture' };

const G = (g: Partial<Grammar> & Pick<Grammar, 'form'>): Grammar => ({ count: [3, 5], grids: [0.5], longest: 2, leap: 0.2, rest: 0.2, pickup: 0.2, bars: 1, ...g });

export const STYLES: Record<StyleId, StyleProfile> = {
  ambient: {
    label: 'Ambient', description: 'Slow harmonic motion, consonant drones, long tones, suspended harmonies, a gently developing motif and intentional negative space.',
    tempo: 72, swing: 0, progression: 'sparse', harmonicRhythm: 4, colour: 'added', phraseBars: 8,
    layers: { pad: 0, drone: 0, melody: 0.45, texture: 0.3 }, patches: { pad: 'Glassy Ambient Pad', drone: 'Dark Drone', melody: 'Bell / FM Tone', texture: 'Distant Chimes' },
    grammar: G({ form: 'drone', count: [2, 4], grids: [1, 1.5], longest: 6, leap: 0.15, rest: 0.4, pickup: 0.4, bars: 2 }), silence: 0.35,
  },
  ambientDub: {
    label: 'Ambient dub', description: 'Pedal tones, minor/modal harmony, spacious chord fragments, an independent bass line, sparse syncopation and delayed melodic fragments.',
    tempo: 76, swing: 0.15, progression: 'pedal', harmonicRhythm: 2, colour: 'sevenths', phraseBars: 4,
    layers: { drums: 0.25, bass: 0.2, chords: 0, pad: 0.55, melody: 0.7 }, patches: { bass: 'Deep Current', chords: 'Dusty Keys', pad: 'Faded Tape Pad', melody: 'Hollow Pulse' },
    grammar: G({ form: 'call', count: [2, 4], grids: [0.5, 0.75], longest: 1.5, leap: 0.25, rest: 0.5, pickup: 0.7 }), silence: 0.3,
  },
  motorik: {
    label: 'Krautrock / motorik', description: 'Repetition as a device: ostinatos, modal harmony, a sustained pulse, phase interactions, gradual note substitution and evolving timbre.',
    tempo: 126, swing: 0, progression: 'modal', harmonicRhythm: 4, colour: 'triads', phraseBars: 4,
    layers: { drums: 0, bass: 0.15, arp: 0.35, pad: 0.5, melody: 0.7 }, patches: { bass: 'Analog Mono Bass', arp: 'Soft Machinery', pad: 'Analog Haze', melody: 'Plucked Synth' },
    grammar: G({ form: 'cell', count: [4, 6], grids: [0.5], longest: 1, leap: 0.1, rest: 0.1, pickup: 0.1 }), silence: 0,
  },
  idm: {
    label: 'IDM / glitch', description: 'Complex subdivisions, changing rhythmic cycles, displacement, micro-events and unusual intervals — inside the selected harmony unless Experimental.',
    tempo: 104, swing: 0, progression: 'sparse', harmonicRhythm: 2, colour: 'sevenths', phraseBars: 4,
    layers: { drums: 0, texture: 0.15, bass: 0.3, melody: 0.4, chords: 0.6 }, patches: { bass: 'Night Bus Bass', melody: 'Digital Mallet', chords: 'Metallic Bloom', texture: 'Glitch Percussion' },
    grammar: G({ form: 'sentence', count: [4, 7], grids: [0.25, 0.2, 1 / 6], longest: 0.75, leap: 0.45, rest: 0.25, pickup: 0.6 }), silence: 0.1,
  },
  minimal: {
    label: 'Minimal electronic', description: 'Small melodic cells, repetitive figures, additive and subtractive rhythm, gradual phase variation and very slow harmonic development.',
    tempo: 122, swing: 0.05, progression: 'pedal', harmonicRhythm: 8, colour: 'added', phraseBars: 4,
    layers: { drums: 0, chords: 0.2, bass: 0.35, arp: 0.55, texture: 0.7 }, patches: { chords: 'Hollow Pulse', bass: 'Sub Bass', arp: 'Soft Arpeggio Synth', texture: 'Microclicks' },
    grammar: G({ form: 'cell', count: [3, 4], grids: [0.25, 0.5], longest: 0.5, leap: 0.15, rest: 0.2, pickup: 0.3 }), silence: 0,
  },
  drone: {
    label: 'Drone / experimental', description: 'Tonal centres held on fifths and octaves, selected extensions, restrained beating, minimal note changes and long-form spectral development.',
    tempo: 60, swing: 0, progression: 'static', harmonicRhythm: 16, colour: 'sus', phraseBars: 8,
    layers: { drone: 0, drone2: 0, pad: 0.4, texture: 0.25 }, patches: { drone: 'Subterranean Drone', drone2: 'Dark Drone', pad: 'Frozen Glass', texture: 'Microclicks' },
    grammar: G({ form: 'drone', count: [1, 2], grids: [2], longest: 8, leap: 0, rest: 0.5, pickup: 0.5, bars: 2 }), silence: 0.5,
  },
  cinematic: {
    label: 'Cinematic', description: 'A theme that is stated, developed and recalled; expanded harmony, register changes, contrast, dynamics and tension → release.',
    tempo: 92, swing: 0, progression: 'tension', harmonicRhythm: 2, colour: 'auto', phraseBars: 4,
    layers: { pad: 0, drone: 0, bass: 0.35, arp: 0.5, melody: 0.55, drums: 0.75 }, patches: { pad: 'Warm Analog Pad', drone: 'Dark Drone', bass: 'Sub Bass', arp: 'Plucked Synth', melody: 'Electric Keyboard' },
    grammar: G({ form: 'theme', count: [4, 6], grids: [0.5, 1], longest: 3, leap: 0.3, rest: 0.15, pickup: 0.35 }), silence: 0.05,
  },
  atonal: {
    label: 'Abstract / atonal', description: 'Deliberate pitch-class sets and their transformations, recurring intervals, fixed registers, clusters and structured rhythmic irregularity.',
    tempo: 84, swing: 0, progression: 'chromatic', harmonicRhythm: 2, colour: 'auto', phraseBars: 4,
    layers: { chords: 0, melody: 0.2, texture: 0.35, drums: 0.6 }, patches: { chords: 'Metallic Bloom', melody: 'Bell / FM Tone', texture: 'Glitch Percussion' },
    grammar: G({ form: 'sentence', count: [4, 6], grids: [0.25, 0.75, 1 / 3], longest: 2, leap: 0.6, rest: 0.3, pickup: 0.5 }), silence: 0.15,
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
    locks: { melody: false, harmony: false, rhythm: false, instruments: false, selected: true }, bypassScale: true, percussion: true, time: 'metric',
  };
}

/** The progression a style uses when the harmony panel is on Auto. Chromatic movement is only
 *  ever chosen automatically under Experimental (or for atonal pieces that bypass the scale). */
export function styleProgression(style: StyleId, h: Pick<HarmonySettings, 'behavior'>, c: Pick<CompositionSettings, 'tension' | 'bypassScale'>): ProgressionType {
  const p = STYLES[style].progression;
  if (style === 'idm' && h.behavior === 'experimental') return 'chromatic';
  if (style === 'atonal') return c.bypassScale || h.behavior === 'experimental' ? 'chromatic' : 'sparse';
  if (p === 'sparse' && c.tension > 0.7) return 'tension';
  return p;
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
  /** the pitch-class set form sequence for atonal pieces */
  sets: number[][];
  /** fixed register (MIDI octave base) per pitch class for atonal pieces */
  registers: number[];
  mc: MusicalContext;
  theme: Motif;
  theme2: Motif;
}

const c01 = (x: number) => Math.max(0, Math.min(1, x));
const mod12 = (x: number) => ((x % 12) + 12) % 12;

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

/** Controlled mutation of a remembered phrase: nudge pitches, drop or add notes, displace timing.
 *  Pitch nudges are scale steps; the harmonic fit afterwards puts strong positions back on chord tones. */
function mutate(p: Pattern, amount: number, r: Rng, ctx: Ctx, base: number, step: number, role: Role): Pattern {
  if (amount <= 0) return p;
  const out: Pattern = [];
  // harmony parts keep their pitches (they carry the chord); a bass may vary only off the beat
  const pitchFree = (n: NoteEvent) => role === 'melody' || role === 'texture' || (role === 'bass' && beatStrength(ctx.ps.timeSig, ((n.start % ctx.bb) + ctx.bb) % ctx.bb) < 0.75);
  for (const n of p) {
    const x = r();
    if (x < amount * 0.18) continue; // drop
    let m = { ...n };
    if (r() < amount * 0.45 && m.degree !== undefined && pitchFree(m)) {
      m.degree = m.degree + r.pick([-2, -1, 1, 2]);
      m.midi = degreeToMidi(m.degree, ctx.ps.key, ctx.ps.scale, base, ctx.ps.customScale);
    }
    if (r() < amount * 0.2) m = { ...m, start: Math.max(0, m.start + r.pick([-step, step])) };
    out.push(m);
    if (r() < amount * 0.12) {
      // add a passing note
      const extra = { ...m, start: m.start + step, dur: Math.min(m.dur, step), id: `${m.id}x` };
      if (extra.degree !== undefined && pitchFree(extra)) { extra.degree += r.pick([-1, 1]); extra.midi = degreeToMidi(extra.degree, ctx.ps.key, ctx.ps.scale, base, ctx.ps.customScale); }
      out.push(extra);
    }
  }
  return out;
}

const rootDegree = (slot: ChordSlot) => (slot.chord.degree >= 0 ? slot.chord.degree : 0);

/** The bass pitch class of a moment and, if the chord has one, its fifth (pitch-class arithmetic,
 *  so a pentatonic or blues scale never gets a "fifth" that is really its fourth step). */
function bassTones(slot: ChordSlot): { root: number; fifth: number | null; third: number | null; seventh: number | null } {
  const has = (iv: number) => slot.chord.pcs.includes(mod12(slot.chord.rootPc + iv));
  return {
    root: slot.bassPc,
    fifth: has(7) ? mod12(slot.chord.rootPc + 7) : null,
    third: has(4) ? mod12(slot.chord.rootPc + 4) : has(3) ? mod12(slot.chord.rootPc + 3) : null,
    seventh: has(10) ? mod12(slot.chord.rootPc + 10) : has(11) ? mod12(slot.chord.rootPc + 11) : null,
  };
}

/** A pitch of pitch class pc in [lo, hi], nearest to `near`. */
function place(pc: number, near: number, lo: number, hi: number): number {
  let best = lo + mod12(pc - lo);
  for (let m = best; m <= hi; m += 12) if (Math.abs(m - near) < Math.abs(best - near)) best = m;
  return best;
}

/** Phrase generators per layer. Each returns notes for [start, start + bars·bb). */
function genPhrase(id: LayerId, ctx: Ctx, sec: Section, start: number, bars: number, r: Rng, base: number, range: { low: number; high: number }, spec: RhythmSpec, ph: { k: number; pi: number }): Pattern {
  const phraseIdx = ph.pi;
  const { c, ps, bb } = ctx;
  const len = bars * bb;
  const end = start + len;
  const notes: Pattern = [];
  const degOf = (m: number) => (inScale(m, ps.key, ps.scale, ps.customScale) ? midiToDegree(m, ps.key, ps.scale, base, ps.customScale) : undefined);
  // probability thins events, never single tones of a chord: sustained harmony is exempt and a
  // chord stab is kept or dropped whole
  const sustained = id === 'pad' || id === 'drone' || id === 'drone2';
  const stab = new Map<number, boolean>();
  const add = (beat: number, dur: number, midi: number, vel: number, degree?: number) => {
    if (beat < start - 1e-9 || beat >= end - 1e-9) return;
    if (c.probability < 1 && vel < 0.9 && !sustained) {
      const k = Math.round(beat * 8);
      const keep = id === 'chords' ? stab.get(k) ?? (stab.set(k, r.chance(0.5 + c.probability * 0.5)), stab.get(k)!) : r.chance(0.5 + c.probability * 0.5);
      if (!keep) return;
    }
    notes.push({ id: '', start: beat, dur: Math.max(0.04, Math.min(dur, ctx.beats - beat)), midi, vel: c01(vel), origin: 'generated', degree });
  };
  const inten = intensityAt(ctx, sec, start);
  const style = c.style;
  const ts = ps.timeSig;
  const info = TIME_SIGS[ts];
  const stage = start / Math.max(1, ctx.beats);

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
          for (let b = 0; b < bb - 1e-9; b += 0.5) add(b0 + b, 0.1, 42, b % 1 ? 0.45 : 0.6);
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
          // atonal: a durational series (1, 2, 3, 5 sixteenths) permuted per bar — irregular but ordered
          const series = [1, 2, 3, 5].map((x) => x * 0.25 * (0.8 + c.irregularity * 0.4));
          const order = series.map((_, k) => series[(k + bar) % 4]);
          let b = 0, k = 0;
          while (b < bb - 1e-9) {
            if (r.chance(0.5 + inten * 0.3)) add(b0 + b, 0.1, [56, 37, 39][k % 3], 0.4 + r() * 0.4);
            b += order[k % 4]; k++;
          }
        }
      }
      break;
    }
    case 'bass': {
      if (style === 'motorik') {
        // eighth-note ostinato: root, octave, the chord's fifth — one position changes per phrase
        const cell = [0, 0, 12, 0, 0, 7, 12, 0];
        const r2 = rng(hash32(`bassCell:${c.seed}`));
        for (let k = 0; k < phraseIdx; k++) if (r2.chance(0.3 + c.complexity * 0.4)) cell[r2.int(1, 7)] = r2.pick([0, 7, 12, 10]);
        for (let b = start, i = 0; b < end - 1e-9; b += 0.5, i++) {
          const t = bassTones(chordAt(ctx.harmony, b));
          const iv = cell[i % cell.length];
          const pc = iv === 7 ? t.fifth ?? t.root : iv === 10 ? t.seventh ?? t.root : t.root;
          const m = place(pc, range.low + 7, range.low, range.high) + (iv === 12 ? 12 : 0);
          add(b, 0.42, Math.min(range.high + 12, m), b % 1 ? 0.6 : 0.85, degOf(m));
        }
      } else if (style === 'ambient' || style === 'drone') {
        for (let b = start; b < end - 1e-9;) {
          const slot = chordAt(ctx.harmony, b);
          const m = place(slot.bassPc, range.low + 5, range.low, range.high);
          add(b, slot.start + slot.dur - b, m, 0.55, degOf(m));
          b = slot.start + slot.dur;
        }
      } else if (style === 'cinematic') {
        for (let b = start; b < end - 1e-9;) {
          const slot = chordAt(ctx.harmony, b);
          const m = place(slot.bassPc, range.low + 5, range.low, range.high);
          if (inten > 0.6) { add(b, 0.45, m, b % 1 ? 0.55 : 0.8, degOf(m)); b += 0.5; }
          else { const d = Math.min(bb * 2, slot.start + slot.dur - b); add(b, d, m, 0.65, degOf(m)); b += d; }
        }
      } else {
        // rhythm-spec driven: independent pattern length → the bass phases against the bar. A riff
        // of chord-tone choices is fixed per piece (identity) and follows each chord's root.
        const onsets = expandRhythm(spec, len, ts, r.fork('bass'), 0);
        const rr = rng(hash32(`bassRiff:${c.seed}:${style}`));
        const riff = Array.from({ length: 8 }, (_, k) => (k === 0 ? 'root' : rr.weighted(['root', 'fifth', 'octave', 'seventh', 'third'] as const, style === 'ambientDub' ? [3, 3, 2, 1.5, 0.5] : style === 'idm' ? [2, 2, 2, 1, 1 + c.irregularity] : [4, 2, 1, 0.2, 0.2])));
        let prev = place(chordAt(ctx.harmony, start).bassPc, range.low + 5, range.low, range.high);
        onsets.forEach((o, k) => {
          const b = start + o.beat;
          const slot = chordAt(ctx.harmony, b);
          const t = bassTones(slot);
          if (style === 'minimal' && o.accent >= 0.75 && r.chance(0.6)) return; // offbeat-led
          const choice = o.accent >= 0.75 ? 'root' : riff[k % riff.length];
          let pc = choice === 'fifth' ? t.fifth ?? t.root : choice === 'seventh' ? t.seventh ?? t.root : choice === 'third' ? t.third ?? t.root : t.root;
          let m = place(pc, prev, range.low, range.high);
          if (choice === 'octave') m = Math.min(range.high + 12, place(t.root, range.low + 5, range.low, range.high) + 12);
          // approach tone into a chord change (a scale step; chromatic only when Experimental)
          const nextB = start + (onsets[k + 1]?.beat ?? len);
          const nextSlot = chordAt(ctx.harmony, nextB);
          if (nextSlot !== slot && o.accent < 0.5 && r.chance(0.35)) {
            const target = place(nextSlot.bassPc, m, range.low, range.high);
            const step = ctx.mc.behavior === 'experimental' ? 1 : (() => { for (let s = 1; s <= 2; s++) if (inScale(target - s, ps.key, ps.scale, ps.customScale)) return s; return 0; })();
            if (step) { m = target - step; pc = mod12(m); }
          }
          const dur = style === 'ambientDub' ? Math.min(1.5, o.dur * 1.6) : o.dur * (style === 'minimal' ? 0.4 : 0.7);
          add(b, dur, m, 0.6 + o.accent * 0.35, degOf(m));
          prev = m;
        });
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
        // atonal: the current set form, verticalised in each pitch class's fixed register
        if (atonal) {
          const set = ctx.sets[Math.floor(a / bb) % ctx.sets.length];
          const v = set.map((pc) => ctx.registers[pc] + pc).filter((m) => m >= range.low - 12 && m <= range.high + 12);
          let b = a;
          const durs = [1.5, 0.75, 2.25, 1];
          let k = 0;
          while (b < z - 1e-9) {
            if (r.chance(0.5 + inten * 0.3)) v.forEach((m, j) => add(b + j * 0.02, Math.min(durs[k % 4], z - b), m, 0.45 + r() * 0.25));
            b += durs[k % 4]; k++;
          }
          continue;
        }
        const size = Math.max(2, Math.min(6, 3 + Math.round(c.complexity * 2 + (style === 'drone' ? 1 : 0))));
        const v = voiceLead(prev, slot.chord, range.low, range.high, size);
        prev = v;
        if (id === 'pad') {
          const vel = 0.3 + inten * 0.35;
          v.forEach((m, j) => add(a + j * 0.015, z - a, m, vel * (j ? 0.85 : 1), degOf(m)));
        } else if (style === 'ambientDub') {
          // spacious chord fragments: the upper tones only, off-beat skank stabs
          const frag = v.slice(-Math.max(2, Math.min(3, v.length - 1)));
          for (let b = a; b < z - 1e-9; b += 1) {
            const pos = ((b % bb) + bb) % bb;
            if (Math.floor(pos) % 2 === 1 || ts === '6/8' || ts === '9/8') frag.forEach((m) => add(b + 0.5 * (ts === '6/8' || ts === '9/8' ? 1 : 0), 0.22, m, 0.55, degOf(m)));
          }
        } else if (style === 'minimal') {
          // additive / subtractive: the pulse count grows and shrinks phrase by phrase
          const pulses = Math.max(2, Math.min(spec.length + 2, spec.pulses - 1 + Math.round(2 * Math.sin(phraseIdx * 0.8))));
          const hits = expandRhythm({ ...spec, length: spec.length + 3, pulses }, z - a, ts, r.fork(`cl${a}`), 0);
          for (const h of hits) v.slice(0, 3).forEach((m) => add(a + h.beat, 0.12, m, 0.4 + h.accent * 0.3, degOf(m)));
        } else if (style === 'idm') {
          // a rhythmic cycle of 5 or 7 sixteenths, displaced each bar: changing cycles, same harmony
          const cyc = euclid(3, c.irregularity > 0.5 ? 7 : 5, 0);
          for (let b = a, s = Math.floor(a * 4) % cyc.length; b < z - 1e-9; b += 0.25, s++) {
            if (!cyc[(s + Math.floor(b / bb)) % cyc.length]) continue;
            if (!r.chance(0.55 + inten * 0.35)) continue;
            const voices = v.slice(r.int(0, 1));
            voices.forEach((m, j) => add(b + j * r.pick([0, 0.02]), r.pick([0.2, 0.45, 0.9]), m, 0.45 + r() * 0.3, degOf(m)));
          }
        } else {
          for (let b = a; b < z - 1e-9; b += bb) v.forEach((m) => add(b, Math.min(bb, z - b) * 0.9, m, 0.45 + inten * 0.3, degOf(m)));
        }
      }
      break;
    }
    case 'drone':
    case 'drone2': {
      // tonal centre held on root + fifth (+ octave); the second drone adds a selected extension
      // (the 9th, or late in the piece the scale's colour tone) — restrained, slow change
      const slot = chordAt(ctx.harmony, start);
      const root = slot.bassPc;
      const fifth = inScale(root + 7, ps.key, ps.scale, ps.customScale) || slot.chord.pcs.includes(mod12(root + 7)) ? mod12(root + 7) : null;
      const lowRoot = place(root, range.low + 4, range.low, range.high);
      let tones: number[];
      if (id === 'drone') tones = [lowRoot, fifth !== null ? place(fifth, lowRoot + 7, lowRoot, range.high + 12) : lowRoot + 12];
      else {
        const ninth = mod12(root + 2);
        const colour = ctx.mc.characteristic.find((pc) => ctx.mc.pcs.includes(pc));
        const ext = stage > 0.5 && colour !== undefined && c.evolution > 0.4 ? colour : ctx.mc.pcs.includes(ninth) ? ninth : root;
        tones = [lowRoot + 12, place(ext, lowRoot + 14, lowRoot + 12, lowRoot + 26)];
      }
      tones.forEach((m, j) => add(start + j * 0.05, len, m, 0.45 + inten * 0.2, degOf(m)));
      break;
    }
    case 'arp': {
      const sub = style === 'motorik' ? 4 : style === 'cinematic' ? 2 : 4;
      const stepLen = 1 / sub;
      const patLen = Math.max(3, Math.min(16, spec.length));
      // the arpeggio's shape comes from the theme's contour (up/down), so it belongs to the piece;
      // motorik keeps a fixed ostinato and substitutes one step per phrase
      const signs = ctx.theme.notes.slice(1).map((n, k) => Math.sign(n.step - ctx.theme.notes[k].step) || 1);
      let pat: number[];
      if (style === 'motorik') {
        pat = [0, 1, 2, 3, 2, 1, 4, 2];
        const rs = rng(hash32(`arpSub:${c.seed}`));
        for (let k = 0; k < phraseIdx; k++) if (rs.chance(0.25 + c.mutation * 0.5)) pat[rs.int(0, 7)] = rs.int(0, 4);
      } else {
        pat = [0];
        for (let k = 1; k < patLen; k++) pat.push(Math.max(0, Math.min(5, pat[k - 1] + (signs[(k - 1) % Math.max(1, signs.length)] ?? 1))));
        if (style === 'idm') pat = pat.map((x, k) => (k % 3 === 2 ? x + 1 : x));
      }
      const phase = style === 'idm' ? Math.floor(phraseIdx * (1 + c.irregularity * 2)) : 0;
      for (let k = 0, b = start; b < end - 1e-9; k++, b += stepLen) {
        if (spec.probability < 1 && !r.chance(spec.probability)) continue;
        const slot = chordAt(ctx.harmony, b);
        const tones = voiceLead(null, slot.chord, range.low, range.high, 4);
        const ext = [...tones, ...tones.map((m) => m + 12)];
        const m = ext[pat[(k + phase) % pat.length] % ext.length];
        add(b, stepLen * 0.75, m, 0.45 + metricWeight(ts, ((b % bb) + bb) % bb) * 0.3, degOf(m));
      }
      break;
    }
    case 'melody': {
      melodyPhrase(ctx, sec, start, bars, r, base, range, ph, inten, add);
      break;
    }
    case 'texture': {
      const g = ctx.guide;
      if (style === 'ambient') {
        for (let b = start; b < end - 1e-9; b += 0.5) {
          if (!r.chance(0.05 + inten * 0.08)) continue;
          const slot = chordAt(ctx.harmony, b);
          const pc = r.pick(slot.chord.pcs.filter((x) => ctx.mc.pcs.includes(x)).length ? slot.chord.pcs.filter((x) => ctx.mc.pcs.includes(x)) : slot.chord.pcs);
          const midi = 72 + mod12(pc - 72) + 12 * r.int(0, 1);
          add(b, 3, midi, 0.25 + r() * 0.25, degOf(midi));
        }
      } else {
        // micro-events: pitched from the chord (Strict/Expressive) or the set (atonal); Experimental
        // adds chromatic neighbours of chord tones
        const step = style === 'idm' ? 0.125 : 0.25;
        for (let b = start; b < end - 1e-9; b += step) {
          const gt = g ? curveValue(g, 'texture', b / ctx.beats) : 0.5;
          const p = (style === 'drone' ? 0.03 : 0.08 + c.complexity * 0.12) * (0.5 + gt) * (0.5 + inten);
          if (!r.chance(p)) continue;
          const burst = style === 'idm' && r.chance(0.3) ? r.int(2, 4) : 1;
          let midi: number;
          if (ctx.atonal) {
            const set = ctx.sets[Math.floor(b / bb) % ctx.sets.length];
            const pc = r.pick(set);
            midi = ctx.registers[pc] + pc + 12;
          } else {
            const slot = chordAt(ctx.harmony, b);
            const pcs = slot.chord.pcs.filter((x) => ctx.mc.pcs.includes(x));
            const pc = r.pick(pcs.length ? pcs : ctx.mc.pcs);
            midi = place(pc, range.low + (range.high - range.low) * r(), range.low, range.high);
            if (ctx.mc.behavior === 'experimental' && r.chance(0.3)) midi += r.pick([-1, 1]);
          }
          for (let k = 0; k < burst; k++) add(b + (k * step) / burst, step * 0.4, midi, 0.35 + r() * 0.4, degOf(midi));
        }
      }
      break;
    }
  }
  return notes;
}

/** One phrase of the melody: the theme developed unit by unit on the current harmony. */
function melodyPhrase(ctx: Ctx, sec: Section, start: number, bars: number, r: Rng, base: number, range: { low: number; high: number }, ph: { k: number; pi: number }, inten: number,
  add: (beat: number, dur: number, midi: number, vel: number, degree?: number) => void) {
  const { c, ps, bb, style } = ctx;
  const g = style.grammar;
  const end = start + bars * bb;
  const theme = sec.variant === 1 && c.structure !== 'mutation' ? ctx.theme2 : ctx.theme;
  if (ctx.atonal) { atonalPhrase(ctx, theme, start, end, range, inten, add); return; }
  const n = scaleIntervals(ps.scale, ps.customScale).length;
  const span = Math.round(5 + c.range * 9);
  const reg = Math.round((c.register - 0.5) * n);
  const centre = midiToDegree(Math.round((range.low + range.high) / 2), ps.key, ps.scale, base, ps.customScale) + reg;
  // register movement: contrasting sections sit a little higher; the final section returns home
  const lift = sec.variant === 1 ? Math.round(n / 2) : 0;
  const lo = centre - Math.floor(span / 2) + lift, hi = centre + Math.ceil(span / 2) + lift;
  const units = Math.max(1, Math.round(bars / g.bars));
  const phraseIdx = g.form === 'cell' ? ph.pi : ph.k;
  const plan = planPhrase(g.form, theme, units, phraseIdx, r.fork('plan'), {
    stage: start / Math.max(1, ctx.beats), variant: sec.variant, mutation: c.mutation, grid: g.grids[0], expressive: ctx.mc.behavior !== 'strict',
  });
  let anchor = chordAnchor(ctx.mc, centre + lift - 1, start, base, lo + 1, hi - 2);
  plan.forEach((u, k) => {
    const uStart = start + k * g.bars * bb;
    if (uStart >= end - 1e-9) return;
    // intentional silence: some statements are left out (never the cadence), more often at low intensity
    if (u.cadence === 'none' && k > 0 && r.chance(style.silence * (1.3 - inten))) return;
    let m = u.motif;
    // literal repetition vs development; variation adds a substitution; IDM displaces the rhythm
    if (u.cadence === 'none' && k > 0 && r.chance(c.repetition * 0.35)) m = theme;
    if (r.chance(c.variation * 0.3)) m = substitute(m, r);
    if (c.style === 'idm' && phraseIdx % 2 === 1) m = displace(m, g.grids[0] * (1 + Math.round(c.irregularity * 2)));
    if (sec.variant === 1 && c.style === 'cinematic' && k === 0) m = invert(m);
    // the anchor is a chord tone chosen so the whole statement fits the range (contour intact)
    const mn = Math.min(0, ...m.notes.map((x) => x.step)), mx = Math.max(0, ...m.notes.map((x) => x.step));
    const aLo = lo - mn, aHi = hi - mx;
    anchor = chordAnchor(ctx.mc, anchor + u.shift, uStart, base, Math.min(aLo, aHi), Math.max(aLo, aHi));
    const notes = realiseUnit(ctx.mc, { motif: m, start: uStart, anchor, base, lo, hi, cadence: u.cadence, vel: 0.55 + inten * 0.3, chromatic: c.tension * 0.5, rng: r, end });
    for (const x of notes) {
      const dur = c.style === 'ambient' || c.style === 'drone' ? Math.max(x.dur, 1.5) : x.dur * (c.style === 'motorik' ? 0.8 : 0.92);
      add(x.beat, dur, x.midi, x.vel, x.degree);
    }
  });
}

/** Atonal melody: the theme's rhythm and contour, its pitches drawn in order from the current
 *  pitch-class set form, each pitch class in its fixed register (registral invariance). */
function atonalPhrase(ctx: Ctx, theme: Motif, start: number, end: number, range: { low: number; high: number }, inten: number,
  add: (beat: number, dur: number, midi: number, vel: number, degree?: number) => void) {
  const { bb, style } = ctx;
  const units = Math.max(1, Math.round((end - start) / (style.grammar.bars * bb)));
  for (let k = 0; k < units; k++) {
    const uStart = start + k * style.grammar.bars * bb;
    const set = ctx.sets[(Math.floor(uStart / bb) + k) % ctx.sets.length];
    const m = k % 2 ? invert(theme) : theme;
    for (const nt of m.notes) {
      const b = uStart + nt.at;
      if (b >= end - 1e-9) continue;
      const idx = ((nt.step % set.length) + set.length) % set.length;
      const pc = set[idx];
      let midi = ctx.registers[pc] + pc + 12;
      while (midi > range.high) midi -= 12;
      while (midi < range.low) midi += 12;
      add(b, nt.dur, midi, 0.5 + inten * 0.3 + (nt.at === 0 ? 0.1 : 0));
    }
  }
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
  /** the project's harmony settings (behaviour, progression choice, colour, chord sequence) */
  harmony?: Partial<HarmonySettings>;
}

export interface ComposeResult { layers: LayerOutput[]; harmony: ChordSlot[]; sections: Section[]; bpm: number; theme: Motif }

/** Pitch-class set forms for atonal pieces: one set class, transposed and inverted in a seeded
 *  order, so the same intervals keep returning in new positions. */
function atonalSets(r: Rng): number[][] {
  const classes = [[0, 1, 4, 6], [0, 1, 3, 7], [0, 1, 4], [0, 2, 6], [0, 1, 5, 6], [0, 3, 4, 7], [0, 1, 2, 6]];
  const set = r.pick(classes);
  return Array.from({ length: 6 }, (_, k) => {
    const t = (k * r.pick([5, 7, 11, 1])) % 12;
    const inv = k % 2 === 1;
    return set.map((x) => mod12((inv ? -x : x) + t));
  });
}

export function compose(input: ComposeInput): ComposeResult {
  const { comp: c, settings: ps } = input;
  const style = STYLES[c.style];
  const hs = input.harmony ?? {};
  const behavior = hs.behavior ?? 'strict';
  const bb = barBeats(ps.timeSig);
  const beats = Math.max(4, Math.round(c.bars)) * bb;
  const R = rng(hash32(`compose:${c.seed}:${c.style}`));
  const sections = planSections(c, bb, R.fork('sections'));
  const n = scaleIntervals(ps.scale, ps.customScale).length;
  const atonal = c.style === 'atonal' && c.bypassScale;
  const progression: ProgressionType = !hs.progression || hs.progression === 'auto' ? styleProgression(c.style, { behavior }, c) : hs.progression;
  let harmony = input.previousHarmony?.length && c.locks.harmony
    ? input.previousHarmony
    : generateProgression({
      type: progression, beats, barBeats: bb, root: ps.key, scale: ps.scale, custom: ps.customScale,
      harmonicRhythm: hs.rhythm && hs.rhythm > 0 ? hs.rhythm : Math.max(0.5, style.harmonicRhythm * (1.3 - c.complexity * 0.6)), tension: c.tension,
      chordSize: hs.colour && hs.colour !== 'auto' ? undefined : style.colour === 'auto' ? (c.complexity > 0.66 ? 4 : 3) : undefined,
      colour: hs.colour && hs.colour !== 'auto' ? hs.colour : style.colour, behavior, sequence: hs.sequence,
      rng: R.fork(`harmony:${hs.seed ?? 1}`),
      guide: input.guide ? (t) => ({ degree: Math.round(curveValue(input.guide!, 'hue', t) * n) % n, strength: curveValue(input.guide!, 'saturation', t) }) : undefined,
    });
  if (atonal) harmony = harmony.map((s) => ({ ...s, chord: chordFromQuality(s.chord.rootPc, 'cluster', -1), func: 'chromatic' as const }));
  const rowR = R.fork('row');
  const sets = atonalSets(rowR);
  const registers = Array.from({ length: 12 }, () => 12 * rowR.int(4, 5));
  const mc = musicalContext(ps, { behavior, slots: harmony }, sections.map((s) => ({ start: s.start, end: s.start + s.bars * bb, name: s.name })));
  const theme = makeMotif(R.fork('theme'), style.grammar, bb);
  const theme2 = makeMotif(R.fork('theme2'), { ...style.grammar, count: [Math.max(1, style.grammar.count[0] - 1), style.grammar.count[1]], leap: Math.min(1, style.grammar.leap + 0.2) }, bb);
  const ctx: Ctx = { c, ps, style, bb, beats, harmony, sections, guide: input.guide, atonal, sets, registers, mc, theme, theme2 };

  const layers: LayerOutput[] = [];
  for (const [lid, threshold] of Object.entries(style.layers) as [LayerId, number][]) {
    if (lid === 'drums' && (!c.percussion || c.time === 'free')) continue;
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
        for (let pb = 0, k = 0; pb < sec.bars; pb += phraseBars, pi++, k++) {
          const bars = Math.min(phraseBars, sec.bars - pb);
          const start = sec.start + pb * bb;
          const inten = intensityAt(ctx, sec, start);
          // layers enter by section intensity; the first layer always plays
          if (inten < threshold * (1.1 - c.complexity * 0.3) && threshold > 0) continue;
          const pr = R.fork(`${key}:${pi}`);
          const mem = memory.get(sec.variant);
          // the melody develops its theme itself; other layers recall remembered phrases
          const reuse = mem && role !== 'melody' && pr.chance(c.repetition * (1 - c.variation * 0.5)) && role !== 'pad' && role !== 'drone';
          let pattern: Pattern;
          if (reuse && mem) {
            const rd = rootDegree(chordAt(harmony, start));
            const shifted = shiftPattern(mem.pattern, start - mem.at, role === 'percussion' || role === 'texture' ? 0 : rd - mem.rootDeg, ctx, base, `${key}_${pi}`)
              .filter((x) => x.start < start + bars * bb - 1e-9);
            const progress = pi / Math.max(1, Math.ceil(c.bars / phraseBars));
            pattern = mutate(shifted, c.mutation * (0.25 + c.evolution * progress), pr.fork('mut'), ctx, base, 1 / spec.subdiv, role);
          } else {
            pattern = genPhrase(lid, ctx, sec, start, bars, pr, base, range, spec, { k, pi });
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
      if (role !== 'percussion' && !(atonal && role !== 'pad')) notes = fitToHarmony(notes, role, ctx, base);
    }
    notes = notes.filter((x) => x.start < beats - 1e-9).sort((a, z) => a.start - z.start || a.midi - z.midi).map((x, k) => ({ ...x, id: `${key}_${k}` }));
    const patchName = style.patches[lid] ?? undefined;
    const patch = patchName ? instrument(patchName) : undefined;
    if (lid === 'drone2' && patch) { patch.osc1.detune += 7; patch.osc2.detune -= 7; }
    const out = layer(key, `${LAYER_NAME[lid]}`, role, sourceFor(role), {
      patch, pitch: role === 'percussion' ? { mode: 'drums', low: 36, high: 56 } : atonal || behavior === 'experimental' && role === 'texture' ? { mode: 'chromatic', low: range.low, high: range.high } : { ...range, mode: 'scale' },
      notes, rhythm: spec, automation: evolutionLanes(lid, ctx, R.fork(`auto:${key}`)), fx: styleFx(lid, c.style), mix: styleMix(lid, c.style),
    });
    layers.push(out);
  }
  if (c.time === 'free') {
    const w = freeTimeWarp(beats, R.fork('breath'), c.irregularity);
    for (const l of layers) l.notes = l.notes.map((x) => warpNote(x, w, l.role, R)).filter((x) => x.start < beats - 1e-9).sort((a, z) => a.start - z.start || a.midi - z.midi);
    harmony = harmony.map((s) => { const a = w(s.start), z = w(s.start + s.dur); return { ...s, start: a, dur: z - a }; });
  }
  return { layers, harmony, sections, bpm: style.tempo, theme };
}

/** The final harmonic fit, by behaviour. Strict: every pitched note in the scale (harmony parts may
 *  also voice their chord's flagged outside tones), melody downbeats on chord tones. Expressive:
 *  in-scale except the chord's own tones. Experimental: untouched. Pitches move to the nearest
 *  allowed tone, so contours survive. */
function fitToHarmony(notes: NoteEvent[], role: Role, ctx: Ctx, base: number): NoteEvent[] {
  const mc = ctx.mc;
  if (mc.behavior === 'experimental') return notes;
  const { ps } = ctx;
  const harmonyPart = role === 'pad' || role === 'chords' || role === 'drone' || role === 'bass' || role === 'arp';
  const chordPart = role === 'pad' || role === 'chords' || role === 'arp';
  const arrived = new Set<ChordSlot>();
  return [...notes].sort((a, b) => a.start - b.start).map((x) => {
    const slot = slotAt(mc, x.start);
    const allowed = harmonyPart ? [...new Set([...mc.pcs, ...slot.chord.pcs])] : mc.pcs;
    let m = x.midi;
    const pcsChord = slot.chord.pcs.filter((pc) => mc.pcs.includes(pc) || harmonyPart);
    const w = beatStrength(ps.timeSig, ((x.start % ctx.bb) + ctx.bb) % ctx.bb);
    // the bass's first note under a new chord is its bass note; pads, chord stabs and arpeggios
    // play chord tones; strong beats of the bass and (Strict) the melody land on chord tones
    const first = role === 'bass' && !arrived.has(slot) && x.start < slot.start + Math.min(slot.dur, ctx.bb) - 1e-6;
    if (role === 'bass') arrived.add(slot);
    if (first && mod12(m) !== slot.bassPc) {
      const mm = place(slot.bassPc, m, Math.round(m) - 7, Math.round(m) + 7);
      return { ...x, midi: mm, degree: inScale(mm, ps.key, ps.scale, ps.customScale) ? midiToDegree(mm, ps.key, ps.scale, base, ps.customScale) : undefined };
    }
    const needChord = (chordPart || (role === 'bass' && w >= 0.75) || (role === 'melody' && mc.behavior === 'strict' && w >= 0.75)) && pcsChord.length;
    const ok = (mm: number) => allowed.includes(mod12(mm)) && (!needChord || pcsChord.includes(mod12(mm)));
    if (ok(m) && Number.isInteger(m)) return x;
    for (let d = 1; d <= 6; d++) {
      if (ok(Math.round(m) - d)) { m = Math.round(m) - d; break; }
      if (ok(Math.round(m) + d)) { m = Math.round(m) + d; break; }
    }
    const degree = inScale(m, ps.key, ps.scale, ps.customScale) ? midiToDegree(m, ps.key, ps.scale, base, ps.customScale) : undefined;
    return { ...x, midi: m, degree };
  });
}

/** Free time: one shared "breath" for the whole piece — stretches of slightly different speed
 *  (rubato) whose boundaries fall at irregular places — so no layer sits on a grid or a pulse,
 *  while chords and melody still move together. */
function freeTimeWarp(beats: number, r: Rng, irregularity: number): (b: number) => number {
  const pts: [number, number][] = [[0, 0]];
  let x = 0, y = 0;
  while (x < beats) {
    const seg = 1.3 + r() * 3.4;
    const rate = 0.6 + r() * (0.7 + irregularity * 0.5);
    x += seg; y += seg * rate;
    pts.push([x, y]);
  }
  const raw = (b: number) => {
    let i = 1;
    while (i < pts.length - 1 && pts[i][0] < b) i++;
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const f = x1 > x0 ? (b - x0) / (x1 - x0) : 0;
    return y0 + (y1 - y0) * f;
  };
  const scale = beats / Math.max(1e-6, raw(beats));
  return (b: number) => Math.max(0, raw(b) * scale);
}

function warpNote(x: NoteEvent, w: (b: number) => number, role: Role, r: Rng): NoteEvent {
  const a = w(x.start), z = w(x.start + x.dur);
  // melodic and textural events breathe a little more than the harmony around them
  const jitter = role === 'melody' || role === 'texture' || role === 'arp' ? (r() - 0.5) * 0.24 : 0;
  return { ...x, start: Math.max(0, a + jitter), dur: Math.max(0.05, z - a) };
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
  if (style === 'ambientDub' && lid === 'melody') return [fxSlot('delay', { time: 0.59, feedback: 0.55, wet: 0.38 }, id('echo'))];
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
  if (style === 'ambientDub' && lid === 'melody') return { delay: 0.45, reverb: 0.3 };
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

