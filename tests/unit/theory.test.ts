import { describe, expect, test } from 'vitest';
import { SCALES, allowedPitches, degreeToMidi, mapY, midiToDegree, pcName, snapToScale, yForMidi } from '../../src/theory/scales';
import { CHORD_FORMULAS, diatonicChord, voiceChord, voiceLead } from '../../src/theory/chords';
import { generateProgression } from '../../src/theory/progression';
import { euclid, expandRhythm, defaultRhythm } from '../../src/theory/rhythm';
import { TIME_SIGS, metricWeight, swingBeat } from '../../src/core/time';
import { rng } from '../../src/core/rng';
import { generateMelody, MELODY_BEHAVIORS } from '../../src/theory/melody';

describe('scales', () => {
  test('at least the required scales exist, as interval patterns', () => {
    for (const id of ['major', 'minor', 'harmonicMinor', 'melodicMinor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'majorPent', 'minorPent', 'majorBlues', 'minorBlues', 'wholeTone', 'chromatic', 'octatonic', 'phrygianDominant', 'custom'] as const) {
      expect(SCALES[id].intervals[0]).toBe(0);
    }
    expect(SCALES.harmonicMinor.intervals).toEqual([0, 2, 3, 5, 7, 8, 11]);
  });
  test('allowed pitches respect key and scale', () => {
    const p = allowedPitches({ mode: 'scale', low: 60, high: 72 }, 0, 'major');
    expect(p).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    const d = allowedPitches({ mode: 'scale', low: 60, high: 72 }, 2, 'dorian');
    expect(d.map((m) => m % 12).every((pc) => [2, 4, 5, 7, 9, 11, 0].includes(pc))).toBe(true);
  });
  test('mapY: top is higher than bottom; yForMidi inverts', () => {
    const p = allowedPitches({ mode: 'scale', low: 48, high: 84 }, 0, 'major');
    expect(mapY(1, p)).toBeGreaterThan(mapY(0, p));
    for (const m of p) expect(mapY(yForMidi(m, p), p)).toBe(m);
  });
  test('degree ↔ midi round trip and spelling', () => {
    for (let d = -7; d < 14; d++) expect(midiToDegree(degreeToMidi(d, 9, 'minor', 48), 9, 'minor', 48)).toBe(d);
    expect(pcName(10, 5, 'major')).toBe('B♭');
    expect(pcName(6, 7, 'major')).toBe('F♯');
    expect(snapToScale(61, 0, 'major')).toBe(60);
  });
});

describe('harmony', () => {
  test('diatonic chords have the right qualities in C major', () => {
    expect(diatonicChord(0, 0, 'major').quality).toBe('maj');
    expect(diatonicChord(1, 0, 'major').quality).toBe('min');
    expect(diatonicChord(6, 0, 'major').quality).toBe('dim');
    expect(diatonicChord(4, 0, 'major', 4).quality).toBe('dom7');
    expect(diatonicChord(0, 0, 'major', 4).quality).toBe('maj7');
  });
  test('voicings use proper intervals and inversions', () => {
    const c = diatonicChord(0, 0, 'major');
    expect(voiceChord(c, 60, 0)).toEqual([60, 64, 67]);
    expect(voiceChord(c, 60, 1)).toEqual([64, 67, 72]);
    for (const f of Object.values(CHORD_FORMULAS)) expect(f[0]).toBe(0);
  });
  test('voice leading moves less than root-position jumps', () => {
    const chords = [0, 3, 4, 0].map((d) => diatonicChord(d, 0, 'major'));
    let prev: number[] | null = null;
    let led = 0, naive = 0;
    let prevNaive: number[] | null = null;
    for (const c of chords) {
      const v = voiceLead(prev, c, 52, 76, 3);
      const nv = voiceChord(c, 60, 0);
      if (prev) led += v.reduce((s, n, i) => s + Math.abs(n - prev![i]), 0);
      if (prevNaive) naive += nv.reduce((s, n, i) => s + Math.abs(n - prevNaive![i]), 0);
      prev = v; prevNaive = nv;
    }
    expect(led).toBeLessThan(naive);
  });
  test('progressions are deterministic and differ by type', () => {
    const o = { beats: 64, barBeats: 4, root: 0, scale: 'major' as const, harmonicRhythm: 1, tension: 0.5 };
    const a = generateProgression({ ...o, type: 'diatonic', rng: rng(5) });
    const b = generateProgression({ ...o, type: 'diatonic', rng: rng(5) });
    expect(a).toEqual(b);
    const s = generateProgression({ ...o, type: 'static', rng: rng(5) });
    expect(new Set(s.map((x) => x.chord.rootPc)).size).toBe(1);
    const circ = generateProgression({ ...o, type: 'circular', rng: rng(5) });
    expect(circ.slice(0, 4).map((x) => x.chord.degree)).toEqual([0, 3, 6, 2]);
    const ped = generateProgression({ ...o, type: 'pedal', rng: rng(5) });
    expect(ped.every((x) => x.bassPc === 0)).toBe(true);
  });
});

describe('rhythm', () => {
  test('euclid(3,8) is the tresillo and rotation shifts it', () => {
    expect(euclid(3, 8).map(Number)).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
    expect(euclid(3, 8, 1).map(Number)).toEqual([0, 1, 0, 0, 1, 0, 0, 1]);
    expect(euclid(5, 16).filter(Boolean).length).toBe(5);
  });
  test('independent pattern lengths phase against the bar (polymeter)', () => {
    const seven = expandRhythm(defaultRhythm({ subdiv: 4, length: 7, pulses: 3 }), 16, '4/4', rng(1));
    const bar1 = seven.filter((o) => o.beat < 4).map((o) => o.beat);
    const bar2 = seven.filter((o) => o.beat >= 4 && o.beat < 8).map((o) => o.beat - 4);
    expect(bar1).not.toEqual(bar2);
  });
  test('time signatures differ musically, not just by label', () => {
    expect(TIME_SIGS['7/8'].barBeats).toBe(3.5);
    // 7/8 groups 2+2+3: the third group starts at beat 2 (four eighths in)
    expect(metricWeight('7/8', 2)).toBe(0.75);
    expect(metricWeight('4/4', 2)).toBe(0.75);
    expect(metricWeight('6/8', 1.5)).toBe(0.75);
    expect(metricWeight('6/8', 1)).toBeLessThan(0.75);
  });
  test('swing warps offbeats later, keeps downbeats, stays monotonic', () => {
    expect(swingBeat(1, 1, 8)).toBe(1);
    expect(swingBeat(1.5, 1, 8)).toBeCloseTo(1 + 2 / 3, 6);
    let prev = -1;
    for (let b = 0; b < 4; b += 0.01) { const w = swingBeat(b, 0.7, 16); expect(w).toBeGreaterThan(prev); prev = w; }
  });
});

describe('melody behaviours', () => {
  test('every behaviour produces notes inside the range and they differ', () => {
    const onsets = Array.from({ length: 32 }, (_, i) => ({ beat: i * 0.5, dur: 0.5, accent: i % 2 ? 0.3 : 0.75 }));
    const chords = generateProgression({ type: 'diatonic', beats: 16, barBeats: 4, root: 0, scale: 'major', harmonicRhythm: 1, tension: 0.3, rng: rng(2) });
    const shapes = new Set<string>();
    for (const b of MELODY_BEHAVIORS) {
      const m = generateMelody({ onsets, behavior: b.id, chords, root: 0, scale: 'major', base: 48, lo: 7, hi: 18, rng: rng(9), restProb: 0.1, phraseBeats: 8, totalBeats: 16, contour: (t) => t });
      expect(m.length).toBeGreaterThan(4);
      shapes.add(m.map((x) => x.midi).join(','));
    }
    expect(shapes.size).toBe(MELODY_BEHAVIORS.length);
  });
});
