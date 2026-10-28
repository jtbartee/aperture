// Musical acceptance tests (brief Phase 10, A–K) and the Musical Intelligence Engine's contracts.
// These measure the note data; the e2e "musical" group renders and measures the audio.

import { describe, expect, test } from 'vitest';
import type { ChordSlot, HarmonyBehavior, NoteEvent, Project, ProjectSettings, ScaleId, StyleId, TimeSigId } from '../../src/core/types';
import { compose, defaultComposition, STYLES, STYLE_IDS } from '../../src/interpret/composer';
import { chordSymbol, diatonicChord, stableDegree, voiceChord } from '../../src/theory/chords';
import { chordIsHonest, generateProgression, parseChordSequence, retargetSlots, type ProgressionType } from '../../src/theory/progression';
import { adaptNotes, choosePitch, explain, musicalContext, romanNumeral, slotAt } from '../../src/theory/context';
import { SCALE_IDS, pcName, pitchClasses, scaleIntervals } from '../../src/theory/scales';
import { barBeats, beatStrength } from '../../src/core/time';
import { rng } from '../../src/core/rng';
import { defaultOrbitalVoice, orbitalNotes } from '../../src/interpret/orbital';
import { defaultParticles, simulateParticles, soundingIndex } from '../../src/interpret/particles';
import { emptyTrack, trackFromLayer } from '../../src/interpret/layers';
import { defaultImageSettings } from '../../src/interpret/imageModes';
import { defaultPanoramaSettings, defaultRegions } from '../../src/interpret/panorama';
import { refreshSequencers, withoutSource, withoutSourceNotes } from '../../src/state/music';
import { normalizeProject } from '../../src/state/project';
import { parseMidi, projectToMidi } from '../../src/export/midi';
import { eventsInWindow } from '../../src/audio/schedule';
import { mean, stroke, testProject } from './helpers';

const pc = (m: number) => ((Math.round(m) % 12) + 12) % 12;
const mk = (key: number, scale: ScaleId, extra: Partial<ProjectSettings> = {}): ProjectSettings => ({ ...testProject().settings, key, scale, ...extra });
const run = (ps: ProjectSettings, style: StyleId, seed: number, behavior: HarmonyBehavior = 'strict', extra: Record<string, unknown> = {}, harmony: Record<string, unknown> = {}) =>
  compose({ comp: { ...defaultComposition(), style, seed, bars: 32, percussion: false, bypassScale: false, ...extra }, settings: ps, harmony: { behavior, ...harmony } });
const pitched = (r: ReturnType<typeof compose>) => r.layers.filter((l) => l.role !== 'percussion');
const layerOf = (r: ReturnType<typeof compose>, key: string) => r.layers.find((l) => l.key === `gen:${key}`);
const inScaleShare = (notes: NoteEvent[], pcs: number[]) => notes.filter((n) => pcs.includes(pc(n.midi))).length / Math.max(1, notes.length);
const chordAtSlots = (slots: ChordSlot[], b: number) => { let s = slots[0]; for (const x of slots) if (x.start <= b + 1e-6) s = x; return s; };
const strongOf = (ts: TimeSigId, b: number) => beatStrength(ts, ((b % barBeats(ts)) + barBeats(ts)) % barBeats(ts));

describe('A — C major, C → Am → F → G', () => {
  const ps = mk(0, 'major');
  const results = [1, 2, 3, 4, 5].map((seed) => run(ps, 'cinematic', seed, 'strict', {}, { progression: 'custom', sequence: 'C Am F G', rhythm: 1 }));
  test('the progression is named for what sounds', () => {
    expect(results[0].harmony.slice(0, 4).map((s) => chordSymbol(s.chord, (x) => pcName(x)))).toEqual(['C', 'Am', 'F', 'G']);
  });
  test('pads voice the chord (root and third present, nothing foreign)', () => {
    for (const r of results) {
      const pad = layerOf(r, 'pad')!.notes;
      for (const sl of r.harmony.slice(0, 8)) {
        const v = pad.filter((n) => n.start >= sl.start - 1e-6 && n.start < sl.start + 0.1).map((n) => pc(n.midi));
        if (!v.length) continue;
        expect(v.every((x) => sl.chord.pcs.includes(x))).toBe(true);
        expect(v).toContain(sl.chord.rootPc);
        expect(v.some((x) => x === pc(sl.chord.rootPc + 3) || x === pc(sl.chord.rootPc + 4))).toBe(true);
      }
    }
  });
  test('the bass plays each chord’s root as the chord arrives, and mostly chord tones', () => {
    for (const r of results) {
      const bass = layerOf(r, 'bass')!.notes;
      for (const sl of r.harmony.filter((s) => s.start < 120)) {
        const first = bass.find((n) => n.start >= sl.start - 1e-6 && n.start < sl.start + sl.dur);
        if (first) expect(pc(first.midi)).toBe(sl.bassPc);
      }
      const ct = bass.filter((n) => chordAtSlots(r.harmony, n.start).chord.pcs.includes(pc(n.midi))).length / bass.length;
      expect(ct).toBeGreaterThan(0.85);
    }
  });
  test('strong melodic positions are chord tones; non-chord tones move by step', () => {
    const strongCT: number[] = [], stepNCT: number[] = [];
    for (const r of results) {
      const mel = [...layerOf(r, 'melody')!.notes].sort((a, b) => a.start - b.start);
      const strong = mel.filter((n) => strongOf(ps.timeSig, n.start) >= 0.75);
      strongCT.push(strong.filter((n) => chordAtSlots(r.harmony, n.start).chord.pcs.includes(pc(n.midi))).length / Math.max(1, strong.length));
      const nct = mel.map((n, i) => ({ n, i })).filter(({ n }) => !chordAtSlots(r.harmony, n.start).chord.pcs.includes(pc(n.midi)));
      stepNCT.push(nct.filter(({ n, i }) => Math.abs((mel[i - 1]?.midi ?? 99) - n.midi) <= 2 || Math.abs((mel[i + 1]?.midi ?? 99) - n.midi) <= 2).length / Math.max(1, nct.length));
    }
    expect(Math.min(...strongCT)).toBeGreaterThanOrEqual(0.9);
    expect(mean(stepNCT)).toBeGreaterThan(0.85);
  });
  test('Strict: no out-of-scale pitch anywhere', () => {
    for (const r of results) for (const l of pitched(r)) expect(inScaleShare(l.notes, pitchClasses(0, 'major')), l.key).toBe(1);
  });
});

describe('B — D Dorian', () => {
  const ps = mk(2, 'dorian');
  test('the scale is D E F G A B C', () => {
    expect(scaleIntervals('dorian').map((i) => pcName(i + 2, 2, 'dorian'))).toEqual(['D', 'E', 'F', 'G', 'A', 'B', 'C']);
  });
  test('modal harmony: the colour chord (G, holding B) appears; no A major / A7 cadence, no C♯ anywhere', () => {
    let withB = 0, bInMelody = 0;
    for (const style of ['cinematic', 'ambientDub', 'motorik', 'ambient'] as StyleId[]) {
      for (const seed of [1, 2, 3]) {
        for (const behavior of ['strict', 'expressive'] as HarmonyBehavior[]) {
          const r = run(ps, style, seed, behavior);
          expect(r.harmony.every((s) => !s.chord.pcs.includes(1)), `${style} ${seed} ${behavior}`).toBe(true);
          expect(r.harmony.some((s) => s.chord.rootPc === 9 && s.chord.pcs.includes(1))).toBe(false);
          if (r.harmony.some((s) => s.chord.pcs.includes(11))) withB++;
          const mel = layerOf(r, 'melody')?.notes ?? [];
          bInMelody += mel.filter((n) => pc(n.midi) === 11).length;
          for (const l of pitched(r)) expect(inScaleShare(l.notes, pitchClasses(2, 'dorian')), `${style} ${l.key}`).toBe(1);
        }
      }
    }
    expect(withB).toBeGreaterThanOrEqual(18); // of 24 pieces
    expect(bInMelody).toBeGreaterThan(10);
  });
  test('cadences are the mode’s own (IV or ♭VII → i), never a borrowed dominant', () => {
    for (const type of ['tension', 'diatonic', 'modal'] as ProgressionType[]) {
      for (const behavior of ['strict', 'expressive'] as HarmonyBehavior[]) {
        const slots = generateProgression({ type, beats: 128, barBeats: 4, root: 2, scale: 'dorian', harmonicRhythm: 1, tension: 0.9, rng: rng(7), behavior });
        const ctx = musicalContext(ps, { slots });
        for (const s of slots.filter((x) => x.func === 'dominant')) expect(['IV', '♭VII', 'ii'], `${type} ${romanNumeral(ctx, s)}`).toContain(romanNumeral(ctx, s));
      }
    }
  });
});

describe('C — A minor pentatonic', () => {
  const ps = mk(9, 'minorPent');
  test('the scale is A C D E G', () => {
    expect(scaleIntervals('minorPent').map((i) => pcName(i + 9, 9, 'minorPent'))).toEqual(['A', 'C', 'D', 'E', 'G']);
  });
  test('Strict: every melodic and harmonic pitch is in the scale, across seeds and styles', () => {
    const pcs = pitchClasses(9, 'minorPent');
    for (const style of ['ambient', 'motorik', 'idm', 'cinematic', 'minimal', 'ambientDub'] as StyleId[]) {
      for (let seed = 1; seed <= 6; seed++) {
        const r = run(ps, style, seed);
        expect(r.harmony.every((s) => s.chord.pcs.every((x) => pcs.includes(x)))).toBe(true);
        for (const l of pitched(r)) expect(inScaleShare(l.notes, pcs), `${style}/${seed}/${l.key}`).toBe(1);
      }
    }
  });
  test('pentatonic chords are built from scale tones and named honestly', () => {
    const names = [0, 1, 2, 3, 4].map((d) => chordSymbol(diatonicChord(d, 9, 'minorPent', 4), (x) => pcName(x, 9, 'minorPent')));
    expect(names).toEqual(['Am7', 'C6', 'D7sus4', 'E(4ths)', 'Gsus2']);
  });
});

describe('D — F minor blues', () => {
  const ps = mk(5, 'minorBlues');
  const pcs = pitchClasses(5, 'minorBlues');
  test('the scale is F A♭ B♭ B C E♭', () => {
    expect(scaleIntervals('minorBlues').map((i) => pcName(i + 5, 5, 'minorBlues'))).toEqual(['F', 'A♭', 'B♭', 'B', 'C', 'E♭']);
  });
  test('Strict: chords from scale tones only; the blue note is never a chord root', () => {
    expect(stableDegree(3, 5, 'minorBlues')).toBe(false);
    for (const type of ['diatonic', 'modal', 'sparse', 'tension', 'circular'] as ProgressionType[]) {
      const slots = generateProgression({ type, beats: 96, barBeats: 4, root: 5, scale: 'minorBlues', harmonicRhythm: 1, tension: 0.6, rng: rng(3), behavior: 'strict' });
      for (const s of slots) {
        expect(s.chord.pcs.every((x) => pcs.includes(x)), `${type} ${chordSymbol(s.chord, (x) => pcName(x, 5, 'minorBlues'))}`).toBe(true);
        expect(s.chord.rootPc).not.toBe(11);
      }
    }
  });
  test('Expressive: i7–iv7–v7 blues changes, their outside tones flagged; melodies still keep to the blues scale', () => {
    const slots = generateProgression({ type: 'diatonic', beats: 48, barBeats: 4, root: 5, scale: 'minorBlues', harmonicRhythm: 1, tension: 0.6, rng: rng(3), behavior: 'expressive' });
    const names = slots.map((s) => chordSymbol(s.chord, (x) => pcName(x, 5, 'minorBlues')));
    expect(names.slice(0, 4)).toEqual(['Fm7', 'B♭m7', 'Fm7', 'B♭m7']);
    expect(slots.find((s) => s.chord.rootPc === 10)!.chord.outside).toEqual([1]);
    expect(slots.find((s) => s.chord.rootPc === 0)!.chord.outside).toEqual([7]);
    for (const seed of [1, 2, 3]) {
      const r = run(ps, 'ambientDub', seed, 'expressive', {}, { progression: 'diatonic' });
      expect(inScaleShare(layerOf(r, 'melody')!.notes, pcs)).toBe(1);
      for (const l of pitched(r)) for (const n of l.notes) expect(pcs.includes(pc(n.midi)) || chordAtSlots(r.harmony, n.start).chord.pcs.includes(pc(n.midi))).toBe(true);
    }
  });
});

describe('E — IDM in E minor', () => {
  const ps = mk(4, 'minor');
  const pcs = pitchClasses(4, 'minor');
  test('Strict and Expressive keep the scale’s harmony: no chromatic chord appears by accident', () => {
    for (const behavior of ['strict', 'expressive'] as HarmonyBehavior[]) {
      for (let seed = 1; seed <= 5; seed++) {
        const r = run(ps, 'idm', seed, behavior, { irregularity: 0.7 });
        // a borrowed leading-tone dominant (labelled) is the only Expressive exception
        expect(r.harmony.every((s) => s.chord.pcs.every((x) => pcs.includes(x)) || (behavior === 'expressive' && s.func === 'dominant' && s.chord.outside?.length)), `${behavior} ${seed}`).toBe(true);
        expect(inScaleShare(layerOf(r, 'melody')!.notes, pcs)).toBe(1);
      }
    }
  });
  test('Experimental: chromatic notes are passing tones and the tonic stays home', () => {
    let outside = 0, passing = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const r = run(ps, 'idm', seed, 'experimental', { tension: 0.8 });
      expect(r.harmony[0].chord.rootPc).toBe(4);
      expect(r.harmony.filter((s) => s.chord.rootPc === 4).length / r.harmony.length).toBeGreaterThan(0.2);
      const mel = [...layerOf(r, 'melody')!.notes].sort((a, b) => a.start - b.start);
      mel.forEach((n, i) => {
        if (pcs.includes(pc(n.midi))) return;
        outside++;
        if (Math.abs((mel[i - 1]?.midi ?? 99) - n.midi) <= 1 || Math.abs((mel[i + 1]?.midi ?? 99) - n.midi) <= 1) passing++;
      });
      for (const l of r.layers) for (const n of l.notes) expect(Number.isInteger(n.midi)).toBe(true);
    }
    expect(outside).toBeGreaterThan(0);
    expect(passing / outside).toBeGreaterThan(0.9);
  });
  test('rhythmically IDM: varied subdivisions, off-grid onsets, independent cycle lengths', () => {
    const r = run(ps, 'idm', 2, 'strict', { irregularity: 0.8 });
    const mel = layerOf(r, 'melody')!.notes;
    const iois = new Set(mel.slice(1).map((n, i) => (n.start - mel[i].start).toFixed(2)));
    expect(iois.size).toBeGreaterThanOrEqual(5);
    const offGrid = mel.filter((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) > 1e-3).length / mel.length;
    expect(offGrid).toBeGreaterThan(0.1);
    expect(new Set(r.layers.map((l) => l.rhythm?.length)).size).toBeGreaterThanOrEqual(3);
  });
});

/** D Dorian, 76 BPM, no drums: an Orbital voice with a repeating figure and particles replying. */
function ecosystem(behavior: HarmonyBehavior = 'strict', seed = 3): Project {
  const p = testProject();
  p.settings = { ...p.settings, key: 2, scale: 'dorian', bpm: 76, lengthBars: 16, timeSig: '4/4' };
  p.harmony = { ...p.harmony, behavior, slots: generateProgression({ type: 'modal', beats: 64, barBeats: 4, root: 2, scale: 'dorian', harmonicRhythm: 2, tension: 0.4, rng: rng(5), behavior }), author: 'harmony' };
  const lead = p.tracks[0];
  const pad = p.tracks[2];
  const mallet = emptyTrack('mallet', 'Mallet', 'melody', '#9ad0c9', 'Digital Mallet');
  mallet.pitch = { mode: 'scale', low: 62, high: 86 };
  p.tracks = [...p.tracks, mallet];
  const pts = Array.from({ length: 24 }, (_, i) => ({ x: i / 24, y: 0.35 + 0.25 * Math.sin((i / 24) * Math.PI * 4) }));
  p.orbital = { voices: [{ ...defaultOrbitalVoice(lead.id), strokes: [stroke(lead.id, pts, { kind: 'note', density: 2 }, 'orb_s')], pitch: 'guided', fill: true }], active: 'orb_1' };
  p.particles = { ...defaultParticles(), seed, bars: 16, count: 7, zones: [
    { id: 'z1', x: 0, y: 0, w: 0.55, h: 0.6, trackId: mallet.id, behavior: 'melody', repeat: 0.3 },
    { id: 'z2', x: 0.5, y: 0.35, w: 0.5, h: 0.65, trackId: pad.id, behavior: 'chord', repeat: 0.2 },
  ] };
  return refreshSequencers(p);
}

describe('F — Orbital + Particles as one ecosystem', () => {
  test('both play in one key: every pitch in D Dorian (Strict)', () => {
    const p = ecosystem();
    const notes = p.tracks.flatMap((t) => t.notes);
    expect(notes.filter((n) => n.origin === 'orbital').length).toBeGreaterThan(30);
    expect(notes.filter((n) => n.origin === 'particle').length).toBeGreaterThan(20);
    expect(inScaleShare(notes, pitchClasses(2, 'dorian'))).toBe(1);
  });
  test('the orbit follows the chords: strong positions are chord tones, every turn re-read', () => {
    const p = ecosystem();
    const ctx = musicalContext(p.settings, p.harmony);
    const orb = p.tracks[0].notes.filter((n) => n.origin === 'orbital');
    const strong = orb.filter((n) => strongOf('4/4', n.start) >= 0.75);
    expect(strong.filter((n) => slotAt(ctx, n.start).chord.pcs.includes(pc(n.midi))).length / strong.length).toBeGreaterThan(0.9);
    const turn = (r: number) => orb.filter((n) => n.start >= r * 16 && n.start < (r + 1) * 16).map((n) => n.midi);
    expect(turn(0).join()).not.toEqual(turn(1).join()); // chords changed between turns
    const shape = (xs: number[]) => xs.slice(1).map((x, i) => Math.sign(x - xs[i]));
    const a = shape(turn(0)), b = shape(turn(1));
    expect(a.filter((x, i) => x === b[i]).length / a.length).toBeGreaterThan(0.6); // the figure is recognisable
  });
  test('particles complement the orbit: no semitone clashes, little doubling, their own rhythm', () => {
    for (const seed of [3, 4, 5]) {
      const p = ecosystem('strict', seed);
      const orb = p.tracks.flatMap((t) => t.notes).filter((n) => n.origin === 'orbital');
      const par = p.tracks.flatMap((t) => t.notes).filter((n) => n.origin === 'particle');
      let pairs = 0, clash = 0, unison = 0;
      for (const n of par) for (const o of orb) if (o.start <= n.start + 1e-6 && o.start + o.dur > n.start + 1e-6) {
        pairs++;
        const iv = pc(n.midi - o.midi);
        if (iv === 1 || iv === 11) clash++;
        if (n.midi === o.midi) unison++;
      }
      if (process.env.REPORT) console.log(`F seed ${seed}: ${par.length} particle notes, ${pairs} overlaps with the orbit, semitone clashes ${(100 * clash / pairs).toFixed(1)} %, unisons ${(100 * unison / pairs).toFixed(1)} %`);
      expect(pairs).toBeGreaterThan(5);
      expect(clash / pairs).toBeLessThanOrEqual(0.05);
      expect(unison / pairs).toBeLessThan(0.2);
      const orbOn = new Set(orb.map((n) => n.start.toFixed(3)));
      expect(par.filter((n) => orbOn.has(n.start.toFixed(3))).length / par.length).toBeLessThan(0.6);
    }
  });
  test('music never steers the physics, and nothing overwrites anything else', () => {
    const p = ecosystem();
    const plain = simulateParticles(p.particles, p.tracks, p.settings);
    const musical = simulateParticles(p.particles, p.tracks, p.settings, { ctx: musicalContext(p.settings, p.harmony), sounding: soundingIndex(p.tracks) });
    expect(Array.from(musical.frames)).toEqual(Array.from(plain.frames));
    const again = refreshSequencers(p);
    expect(again.tracks.map((t) => t.notes)).toEqual(p.tracks.map((t) => t.notes)); // idempotent
    const ids = p.tracks.flatMap((t) => t.notes.map((n) => n.id));
    expect(new Set(ids).size).toBe(ids.length);
    // both feed the one schedule the engine, WAV render and MIDI use
    const w = eventsInWindow(p, 0, 64);
    expect(w.some((e) => e.note.origin === 'orbital') && w.some((e) => e.note.origin === 'particle')).toBe(true);
  });
});

describe('G — free-time ambient', () => {
  const ps = mk(9, 'minor');
  test('no drums, no grid, no steady pulse', () => {
    for (const seed of [1, 2, 3]) {
      const r = run(ps, 'ambient', seed, 'strict', { time: 'free', percussion: true });
      expect(r.layers.some((l) => l.role === 'percussion')).toBe(false);
      const on = r.layers.filter((l) => l.role === 'melody' || l.role === 'texture').flatMap((l) => l.notes.map((n) => n.start)).sort((a, b) => a - b);
      const offGrid = on.filter((b) => Math.abs(b * 2 - Math.round(b * 2)) > 0.02).length / on.length;
      expect(offGrid).toBeGreaterThan(0.75);
      const ioi = on.slice(1).map((b, i) => b - on[i]).filter((x) => x > 0.05);
      const m = mean(ioi);
      const cv = Math.sqrt(mean(ioi.map((x) => (x - m) ** 2))) / m;
      expect(cv).toBeGreaterThan(0.5);
      // chords and melody still move together: strong melody notes sit on the (warped) chord's tones
      for (const n of layerOf(r, 'melody')?.notes ?? []) expect(pitchClasses(9, 'minor')).toContain(pc(n.midi));
    }
  });
  test('the metric version of the same piece is on the grid (the difference is real)', () => {
    const r = run(ps, 'ambient', 1, 'strict');
    const on = layerOf(r, 'melody')!.notes.map((n) => n.start);
    expect(on.filter((b) => Math.abs(b * 2 - Math.round(b * 2)) > 0.02).length / on.length).toBeLessThan(0.1);
  });
});

describe('H — 5/4 and 7/8', () => {
  for (const ts of ['5/4', '7/8'] as TimeSigId[]) {
    test(`${ts}: phrases and harmony align to its bars; strong group starts take chord tones`, () => {
      const ps = mk(0, 'major', { timeSig: ts });
      const bb = barBeats(ts);
      for (const seed of [1, 2]) {
        const r = run(ps, 'cinematic', seed);
        expect(r.theme.span).toBeCloseTo(bb * STYLES.cinematic.grammar.bars, 6);
        for (const s of r.harmony) expect(Math.abs(s.start / (bb / 2) - Math.round(s.start / (bb / 2)))).toBeLessThan(1e-6);
        const mel = layerOf(r, 'melody')!.notes;
        const strong = mel.filter((n) => strongOf(ts, n.start) >= 0.75);
        expect(strong.length).toBeGreaterThan(5);
        expect(strong.filter((n) => chordAtSlots(r.harmony, n.start).chord.pcs.includes(pc(n.midi))).length / strong.length).toBeGreaterThanOrEqual(0.9);
      }
      const m = compose({ comp: { ...defaultComposition(), style: 'motorik', bars: 4, percussion: true }, settings: ps, harmony: { behavior: 'strict' } });
      const kicks = m.layers.find((l) => l.key === 'gen:drums')!.notes.filter((n) => n.midi === 36 && n.start < bb).map((n) => n.start);
      expect(kicks).toEqual(ts === '7/8' ? [0, 1, 2] : [0, 3]);
    });
  }
});

describe('I — removing, clearing and replacing a source (pure project operations)', () => {
  function withSources(): Project {
    const p = testProject();
    const asset = (id: string) => ({ assetId: id, name: `${id}.png`, mime: 'image/png', width: 10, height: 10, bytes: 100 });
    p.image = { asset: asset('img_A'), settings: defaultImageSettings() };
    p.panorama = { asset: asset('img_B'), settings: defaultPanoramaSettings(), regions: defaultRegions() };
    const gen = (id: string, generator: string, origin: NoteEvent['origin'], extra: NoteEvent[] = []) => {
      const t = emptyTrack(id, id, 'melody', '#fff');
      t.generator = generator;
      t.notes = [{ id: `${id}_1`, start: 0, dur: 1, midi: 62, vel: 0.6, origin, cid: 'c1', src: [0.1, 0.5] }, ...extra];
      t.automation = [{ id: `${id}_lane`, target: 'cutoff', origin: origin === 'image' ? 'image' : 'panorama', points: [{ beat: 0, value: 0.5 }] }];
      return t;
    };
    const lead = gen('img_lead', 'image:contour:lead', 'image');
    const field = gen('img_field', 'image:contour:field', 'image');
    const edited = gen('img_counter', 'image:contour:counter', 'image', [{ id: 'mine', start: 2, dur: 1, midi: 64, vel: 0.6, origin: 'user' }]);
    const pano = gen('pano_atmos', 'pano:atmos', 'panorama');
    p.tracks = [...p.tracks, lead, field, edited, pano];
    p.strokes = [stroke(p.tracks[0].id, [{ x: 0, y: 0.5 }, { x: 4, y: 0.6 }], {}, 'drawn')];
    p.orbital = { voices: [{ ...defaultOrbitalVoice('img_lead'), strokes: [] }], active: 'orb_1' };
    p.particles = { ...defaultParticles(), zones: [{ id: 'z', x: 0, y: 0, w: 1, h: 1, trackId: 'pano_atmos', behavior: 'melody' }] };
    p.modRoutes = [{ id: 'r1', source: 'brightness', trackId: 'img_lead', target: 'cutoff', amount: 1, smoothing: 0, from: 'image' }, { id: 'r2', source: 'edges', trackId: 'pano_atmos', target: 'pan', amount: 1, smoothing: 0, from: 'panorama' }];
    p.harmony = { ...p.harmony, author: 'image', slots: [{ start: 0, dur: 16, chord: diatonicChord(0, 0, 'major'), bassPc: 0 }] };
    return refreshSequencers(p);
  }
  /** a track without the notes the sequencers regenerate whenever the harmony changes */
  const own = (t: Project['tracks'][number] | undefined) => t && { ...t, notes: t.notes.filter((n) => n.origin !== 'particle' && n.origin !== 'orbital') };
  const json = (p: Project) => JSON.stringify(normalizeProject(JSON.parse(JSON.stringify(p))));

  test('remove with its layers: only the image’s material goes; everything unrelated is untouched', () => {
    const p = withSources();
    const r = withoutSource(p, 'image', false);
    expect(r.image).toBeUndefined();
    expect(r.panorama).toEqual(p.panorama);
    const ids = r.tracks.map((t) => t.id);
    expect(ids).not.toContain('img_field');
    expect(ids).toEqual(expect.arrayContaining([p.tracks[0].id, p.tracks[1].id, p.tracks[2].id, p.tracks[3].id, 'img_lead', 'img_counter', 'pano_atmos']));
    expect(r.tracks.find((t) => t.id === 'img_lead')!.notes.filter((n) => n.origin === 'image')).toEqual([]); // kept for its Orbital voice
    expect(r.tracks.find((t) => t.id === 'img_counter')!.notes.map((n) => n.id)).toEqual(['mine']);
    expect(own(r.tracks.find((t) => t.id === 'pano_atmos'))).toEqual(own(p.tracks.find((t) => t.id === 'pano_atmos')));
    expect(r.strokes).toEqual(p.strokes);
    expect(r.particles.zones).toEqual(p.particles.zones);
    expect(r.orbital.voices[0].trackId).toBe('img_lead');
    expect(r.modRoutes.map((x) => x.id)).toEqual(['r2']);
    expect(r.harmony.author).toBe('none');
    expect(r.tracks.every((t) => !t.generator?.startsWith('image:'))).toBe(true);
    expect(json(r)).not.toContain('img_A'); // no orphaned reference survives save → reopen
    expect(json(r)).toContain('img_B');
  });
  test('remove but keep the music: layers become independent editable tracks', () => {
    const r = withoutSource(withSources(), 'image', true);
    const kept = r.tracks.filter((t) => ['img_lead', 'img_field', 'img_counter'].includes(t.id));
    expect(kept.length).toBe(3);
    for (const t of kept) {
      expect(t.generator).toBeUndefined();
      expect(t.notes.every((n) => n.origin === 'user' && n.cid === undefined && n.src === undefined)).toBe(true);
    }
    expect(r.harmony.author).toBe('image'); // the kept music still needs its chords
    expect(json(r)).not.toContain('img_A');
  });
  test('clear generated notes keeps the picture, the layers and the user’s edits', () => {
    const p = withSources();
    const r = withoutSourceNotes(p, 'image');
    expect(r.image).toEqual(p.image);
    expect(r.tracks.find((t) => t.id === 'img_field')!.notes).toEqual([]);
    expect(r.tracks.find((t) => t.id === 'img_counter')!.notes.map((n) => n.id)).toEqual(['mine']);
    expect(own(r.tracks.find((t) => t.id === 'pano_atmos'))!.notes.length).toBe(1);
  });
  test('removing the panorama takes its regions with it and leaves the image alone', () => {
    const p = withSources();
    const r = withoutSource(p, 'panorama', false);
    expect(r.panorama).toBeUndefined();
    expect(r.image).toEqual(p.image);
    expect(r.tracks.find((t) => t.id === 'pano_atmos')).toBeTruthy(); // a particle zone plays it
    expect(json(r)).not.toContain('img_B');
  });
});

describe('J — determinism and export parity', () => {
  test('same project and seed → same musical decisions, for every style and behaviour', () => {
    for (const style of STYLE_IDS) for (const behavior of ['strict', 'experimental'] as HarmonyBehavior[]) {
      expect(run(mk(2, 'dorian'), style, 9, behavior)).toEqual(run(mk(2, 'dorian'), style, 9, behavior));
    }
    const notes = (p: Project) => p.tracks.map((t) => t.notes.map((n) => [n.start, n.dur, n.midi, n.vel, n.origin]));
    expect(notes(ecosystem())).toEqual(notes(ecosystem()));
  });
  test('MIDI carries exactly the note events playback schedules', () => {
    const p = ecosystem();
    const r = run(p.settings, 'ambientDub', 2, 'expressive');
    p.tracks = [...p.tracks, ...r.layers.map((l, i) => trackFromLayer(l, `g${i}`, '#fff', i))];
    const midi = parseMidi(projectToMidi(p));
    const total = midi.tracks.reduce((n, t) => n + t.notes.length, 0);
    const scheduled = eventsInWindow(p, 0, 1e6).length;
    expect(total).toBe(scheduled);
  });
});

describe('K — musical development: one theme, recognisably varied', () => {
  /** Units of the melody that restate the theme: same rhythm (≥ 60 % of onsets) and mostly the same
   *  contour (or its inversion) as an earlier unit. */
  function development(style: StyleId, seed: number) {
    const ps = mk(2, 'dorian');
    const r = run(ps, style, seed);
    const unit = STYLES[style].grammar.bars * 4;
    const mel = layerOf(r, 'melody')?.notes ?? [];
    const by = new Map<number, NoteEvent[]>();
    for (const n of mel) { const k = Math.floor(n.start / unit + 1e-9); (by.get(k) ?? by.set(k, []).get(k)!).push(n); }
    const units = [...by.values()].filter((u) => u.length >= 2).map((u) => ({
      on: new Set(u.map((n) => (((n.start % unit) + unit) % unit).toFixed(2))),
      shape: u.slice(1).map((n, i) => Math.sign(n.midi - u[i].midi)),
      pitches: u.map((n) => n.midi).join(','),
    }));
    let related = 0;
    units.forEach((u, i) => {
      if (!i) return;
      if (units.slice(0, i).some((v) => {
        const common = [...u.on].filter((x) => v.on.has(x)).length / Math.max(u.on.size, v.on.size);
        const len = Math.min(u.shape.length, v.shape.length);
        const same = u.shape.slice(0, len).filter((x, j) => x === v.shape[j]).length / Math.max(1, len);
        const inv = u.shape.slice(0, len).filter((x, j) => x === -v.shape[j]).length / Math.max(1, len);
        return common >= 0.6 && Math.max(same, inv) >= 0.6;
      })) related++;
    });
    return { units: units.length, recurrence: related / Math.max(1, units.length - 1), distinct: new Set(units.map((u) => u.pitches)).size / Math.max(1, units.length) };
  }
  for (const style of ['cinematic', 'ambientDub', 'motorik', 'idm'] as StyleId[]) {
    test(`${style}: the theme keeps returning, and keeps changing`, () => {
      const d = [1, 2, 3, 4, 5].map((s) => development(style, s));
      expect(mean(d.map((x) => x.recurrence))).toBeGreaterThan(0.55);
      expect(mean(d.map((x) => x.distinct))).toBeGreaterThan(0.35); // not one loop
    });
  }
});

describe('Musical Intelligence Engine contracts', () => {
  test('every scale transposes exactly through all twelve keys', () => {
    for (const scale of SCALE_IDS) {
      const iv = scaleIntervals(scale);
      for (let key = 0; key < 12; key++) {
        expect(pitchClasses(key, scale)).toEqual(iv.map((i) => (i + key) % 12).sort((a, b) => a - b));
        const a = generateProgression({ type: 'diatonic', beats: 32, barBeats: 4, root: 0, scale, harmonicRhythm: 1, tension: 0.5, rng: rng(4), behavior: 'strict' });
        const b = generateProgression({ type: 'diatonic', beats: 32, barBeats: 4, root: key, scale, harmonicRhythm: 1, tension: 0.5, rng: rng(4), behavior: 'strict' });
        expect(b.map((s) => s.chord.pcs.map((x) => (x - key + 12) % 12))).toEqual(a.map((s) => s.chord.pcs));
      }
    }
  });
  test('chords are honest in every scale: label, pitch classes and voicing agree, and stay in the scale', () => {
    for (const scale of SCALE_IDS) {
      const pcs = pitchClasses(0, scale);
      for (let d = 0; d < scaleIntervals(scale).length; d++) for (const size of [3, 4, 5]) {
        if (!stableDegree(d, 0, scale)) continue;
        const c = diatonicChord(d, 0, scale, size);
        expect(chordIsHonest(c), `${scale} ${d} ${size}`).toBe(true);
        expect(voiceChord(c, 48).every((m) => c.pcs.includes(pc(m)))).toBe(true);
        expect(c.pcs.every((x) => pcs.includes(x)), `${scale} ${d} ${size}`).toBe(true);
      }
    }
  });
  test('typed chord sequences: symbols are absolute, Roman numerals follow the scale', () => {
    const a = parseChordSequence('Dm7 G7 | Cmaj7 F#ø7 Bb/D', 0, 'major');
    expect(a.errors).toEqual([]);
    expect(a.chords.map((c) => chordSymbol(c.chord, (x) => pcName(x, 0, 'major')))).toEqual(['Dm7', 'G7', 'Cmaj7', 'F♯ø7', 'A♯']);
    expect(a.chords[4].bassPc).toBe(2);
    const r = parseChordSequence('i IV i bVII', 2, 'dorian');
    expect(r.chords.map((c) => chordSymbol(c.chord, (x) => pcName(x, 2, 'dorian')))).toEqual(['Dm', 'G', 'Dm', 'C']);
    expect(parseChordSequence('C Xyz', 0, 'major').errors).toEqual(['Xyz']);
  });
  test('explanations say why a note fits', () => {
    const d = musicalContext(mk(2, 'major'), { slots: [{ start: 0, dur: 8, chord: diatonicChord(0, 2, 'major'), bassPc: 2 }] });
    expect(explain(d, 66, 0)).toBe('F♯ — third of D major');
    const dor = musicalContext(mk(2, 'dorian'), { slots: [{ start: 0, dur: 8, chord: diatonicChord(0, 2, 'dorian'), bassPc: 2 }] });
    expect(explain(dor, 71, 0)).toBe('B — 6th degree of D Dorian — its colour tone, passing over D minor');
    expect(explain(dor, 61, 0)).toContain('outside D Dorian');
  });
  test('choosing a pitch avoids rubbing against what already sounds', () => {
    const ctx = musicalContext(mk(0, 'major'), { slots: [{ start: 0, dur: 8, chord: diatonicChord(0, 0, 'major'), bassPc: 0 }] });
    const free = choosePitch(ctx, { target: 65, lo: 60, hi: 72, beat: 1, mode: 'melody' });
    expect([64, 65]).toContain(free);
    const withE = choosePitch(ctx, { target: 65, lo: 60, hi: 72, beat: 1, mode: 'melody', avoid: [64] });
    expect([1, 11]).not.toContain(pc(withE - 64));
  });
  test('a key change transposes the timeline; a scale change rebuilds it on the same degrees', () => {
    const slots = generateProgression({ type: 'diatonic', beats: 32, barBeats: 4, root: 0, scale: 'major', harmonicRhythm: 1, tension: 0.5, rng: rng(2), behavior: 'strict' });
    const up = retargetSlots(slots, { key: 0, scale: 'major' }, { key: 2, scale: 'major' });
    expect(up.map((s) => s.chord.pcs.map((x) => (x + 10) % 12))).toEqual(slots.map((s) => s.chord.pcs));
    const dor = retargetSlots(slots, { key: 0, scale: 'major' }, { key: 0, scale: 'dorian' });
    expect(dor.map((s) => s.chord.degree)).toEqual(slots.map((s) => s.chord.degree));
    expect(dor.every((s) => s.chord.pcs.every((x) => pitchClasses(0, 'dorian').includes(x)))).toBe(true);
  });
  test('guided adaptation moves only exposed non-chord tones, by at most a few semitones', () => {
    const ctx = musicalContext(mk(0, 'major'), { slots: [{ start: 0, dur: 8, chord: diatonicChord(0, 0, 'major'), bassPc: 0 }] });
    const notes: NoteEvent[] = [{ id: 'a', start: 0, dur: 0.5, midi: 62, vel: 1, origin: 'user' }, { id: 'b', start: 1.5, dur: 0.5, midi: 62, vel: 1, origin: 'user' }];
    const out = adaptNotes(ctx, notes, 'guided', 0.5);
    expect([60, 64]).toContain(out[0].midi); // downbeat D → a chord tone
    expect(out[1].midi).toBe(62); // weak D stays a passing tone
  });
  test('legacy projects keep their behaviour: one scale-mapped orbit, the composer’s lock becomes the harmony lock', () => {
    const old: any = JSON.parse(JSON.stringify(testProject()));
    delete old.harmony;
    old.orbital = { bars: 2, direction: 'ccw', trackId: old.tracks[0].id, strokes: [] };
    old.composition.locks.harmony = true;
    delete old.composition.percussion; delete old.composition.time;
    const p = normalizeProject(old);
    expect(p.orbital.voices).toEqual([expect.objectContaining({ bars: 2, direction: 'ccw', trackId: old.tracks[0].id, pitch: 'scale', fill: false })]);
    expect(p.harmony.lock).toBe(true);
    expect(p.composition.percussion).toBe(true);
    expect(p.composition.time).toBe('metric');
    const legacyOrbit = orbitalNotes({ bars: 4, direction: 'cw', strokes: [stroke(p.tracks[0].id, [{ x: 0.1, y: 0.3 }, { x: 0.4, y: 0.7 }])] }, p.tracks[0], p.settings);
    expect(legacyOrbit.notes.every((n) => n.start < 16)).toBe(true); // one revolution, as before
  });
  test('percussion off removes drums from every style', () => {
    for (const style of STYLE_IDS) expect(run(mk(0, 'major'), style, 1).layers.some((l) => l.role === 'percussion')).toBe(false);
  });
});
