import { describe, expect, test } from 'vitest';
import { compose, defaultComposition, STYLE_IDS, blendByBars } from '../../src/interpret/composer';
import type { CompositionSettings, NoteEvent, StyleId } from '../../src/core/types';
import { brayCurtis, mean, onsetHistogram, testProject } from './helpers';

const ps = testProject().settings;
const run = (patch: Partial<CompositionSettings>) => compose({ comp: { ...defaultComposition(), bars: 32, ...patch }, settings: ps });
const all = (r: ReturnType<typeof run>) => r.layers.flatMap((l) => l.notes);

function profile(notes: NoteEvent[]) {
  return {
    hist: onsetHistogram(notes),
    density: notes.length / 128,
    meanDur: mean(notes.map((n) => n.dur)),
    offGrid: notes.filter((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) > 1e-3).length / Math.max(1, notes.length),
  };
}

describe('generative composer', () => {
  test('Example G: identical inputs + seed → identical event data', () => {
    for (const style of STYLE_IDS) expect(run({ style, seed: 11 })).toEqual(run({ style, seed: 11 }));
  });

  test('Example E: Ambient, Motorik and IDM are structurally different from the same input', () => {
    const a = profile(all(run({ style: 'ambient', seed: 5 })));
    const m = profile(all(run({ style: 'motorik', seed: 5 })));
    const i = profile(all(run({ style: 'idm', seed: 5 })));
    // ambient: sparse and long; motorik: dense steady grid; idm: irregular subdivisions
    expect(a.meanDur).toBeGreaterThan(m.meanDur * 3);
    expect(m.density).toBeGreaterThan(a.density * 3);
    expect(i.offGrid).toBeGreaterThan(m.offGrid + 0.05);
    expect(brayCurtis(m.hist, i.hist)).toBeGreaterThan(0.12);
    expect(brayCurtis(a.hist, m.hist)).toBeGreaterThan(0.12);
  });

  test('every style produces its own distinct layer set and rhythmic fingerprint', () => {
    const prints = new Map<StyleId, string>();
    for (const style of STYLE_IDS) {
      const r = run({ style, seed: 3 });
      expect(r.layers.length, style).toBeGreaterThan(1);
      expect(all(r).length, style).toBeGreaterThan(8);
      prints.set(style, r.layers.map((l) => l.role).sort().join(',') + profile(all(r)).hist.map((x) => x.toFixed(2)).join());
    }
    expect(new Set(prints.values()).size).toBe(STYLE_IDS.length);
  });

  test('Example F: different seeds vary the music but keep the style and length', () => {
    const a = run({ style: 'motorik', seed: 1 });
    const b = run({ style: 'motorik', seed: 2 });
    expect(JSON.stringify(all(a))).not.toEqual(JSON.stringify(all(b)));
    expect(a.layers.map((l) => l.key)).toEqual(b.layers.map((l) => l.key));
    // the motorik drum pulse survives a seed change
    const kicks = (r: typeof a) => r.layers.find((l) => l.key === 'gen:drums')!.notes.filter((n) => n.midi === 36 && n.start < 16).map((n) => n.start);
    expect(kicks(a).slice(0, 2)).toEqual(kicks(b).slice(0, 2));
  });

  test('layers keep independent rhythmic identities (pattern lengths)', () => {
    const r = run({ style: 'idm', seed: 4, irregularity: 0.8 });
    const lens = r.layers.map((l) => l.rhythm?.length);
    expect(new Set(lens).size).toBeGreaterThan(2);
  });

  test('time signature changes the generated rhythm, not just the label', () => {
    const four = compose({ comp: { ...defaultComposition(), style: 'motorik', bars: 8 }, settings: ps });
    const seven = compose({ comp: { ...defaultComposition(), style: 'motorik', bars: 8 }, settings: { ...ps, timeSig: '7/8' } });
    const k4 = four.layers.find((l) => l.key === 'gen:drums')!.notes.filter((n) => n.midi === 36 && n.start < 4).map((n) => n.start);
    const k7 = seven.layers.find((l) => l.key === 'gen:drums')!.notes.filter((n) => n.midi === 36 && n.start < 3.5).map((n) => n.start);
    expect(k4).toEqual([0, 1, 2, 3]);
    expect(k7).toEqual([0, 1, 2]); // 2+2+3 eighths
  });

  test('an eight-minute piece is not one loop repeated: phrases evolve', () => {
    const r = run({ style: 'motorik', bars: 240, seed: 8, mutation: 0.6, evolution: 0.8 });
    const arp = r.layers.find((l) => l.key === 'gen:arp')!.notes;
    const phrase = (k: number) => arp.filter((n) => n.start >= k * 16 && n.start < (k + 1) * 16).map((n) => `${(n.start - k * 16).toFixed(2)}:${n.midi}`).join();
    const distinct = new Set(Array.from({ length: 60 }, (_, k) => phrase(k)).filter(Boolean));
    expect(distinct.size).toBeGreaterThan(10);
    expect(r.sections.length).toBeGreaterThanOrEqual(4);
    expect(r.layers.some((l) => l.automation.length > 0)).toBe(true);
  });

  test('every generative control changes the result', () => {
    const base = { style: 'idm' as const, seed: 21 };
    const ref = JSON.stringify(all(run(base)));
    for (const [k, v] of [['complexity', 0.95], ['variation', 0.05], ['density', 0.95], ['repetition', 0.05], ['probability', 0.3], ['tension', 0.95], ['irregularity', 0.95], ['range', 0.95], ['register', 0.1], ['mutation', 0.95], ['evolution', 0.05]] as const) {
      expect(JSON.stringify(all(run({ ...base, [k]: v }))), k).not.toEqual(ref);
    }
  });

  test('locks: harmony lock keeps chords; melody lock keeps the melody', () => {
    const first = run({ style: 'cinematic', seed: 1 });
    const prev = new Map(first.layers.map((l) => [l.key, { notes: l.notes, rhythm: l.rhythm! }]));
    const locked = compose({ comp: { ...defaultComposition(), bars: 32, style: 'cinematic', seed: 2, locks: { ...defaultComposition().locks, harmony: true, melody: true } }, settings: ps, previous: prev, previousHarmony: first.harmony });
    expect(locked.harmony).toEqual(first.harmony);
    expect(locked.layers.find((l) => l.key === 'gen:melody')!.notes.map((n) => n.midi)).toEqual(first.layers.find((l) => l.key === 'gen:melody')!.notes.map((n) => n.midi));
  });

  test('variation amount blends old and new material bar by bar', () => {
    const old = Array.from({ length: 16 }, (_, i) => ({ id: `o${i}`, start: i, dur: 0.5, midi: 60, vel: 0.5, origin: 'generated' as const }));
    const nu = old.map((n) => ({ ...n, id: `n${n.start}`, midi: 72 }));
    expect(blendByBars(old, nu, 0, 4, 1).every((n) => n.midi === 60)).toBe(true);
    expect(blendByBars(old, nu, 1, 4, 1).every((n) => n.midi === 72)).toBe(true);
    const half = blendByBars(old, nu, 0.5, 4, 1);
    expect(half.some((n) => n.midi === 60) && half.some((n) => n.midi === 72)).toBe(true);
  });

  test('abstract/atonal bypasses the scale when asked', () => {
    const r = run({ style: 'atonal', seed: 2, bypassScale: true });
    const pcs = new Set(all(r).filter((n) => n.midi > 40).map((n) => n.midi % 12));
    expect(pcs.size).toBeGreaterThan(7);
  });
});
