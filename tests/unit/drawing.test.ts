import { describe, expect, test } from 'vitest';
import { strokeToNotes, shapePoints } from '../../src/interpret/strokes';
import { remapTrack } from '../../src/interpret/remap';
import { inScale } from '../../src/theory/scales';
import { stroke, testProject } from './helpers';

describe('drawing → music', () => {
  test('Example A: one ascending diagonal line → clearly ascending melody (legato and note brushes)', () => {
    const p = testProject();
    const lead = p.tracks[0];
    for (const kind of ['legato', 'note'] as const) {
      const s = stroke(lead.id, [{ x: 0, y: 0.1 }, { x: 8, y: 0.9 }], { kind, size: 1 });
      const notes = strokeToNotes(s, lead, p.settings).notes.sort((a, b) => a.start - b.start);
      expect(notes.length).toBeGreaterThan(6);
      for (let i = 1; i < notes.length; i++) expect(notes[i].midi).toBeGreaterThanOrEqual(notes[i - 1].midi);
      expect(notes[notes.length - 1].midi - notes[0].midi).toBeGreaterThan(8);
    }
  });

  test('Example B: regularly spaced dots → distinct notes at their positions, in the selected scale', () => {
    const p = testProject();
    p.settings.scale = 'dorian';
    p.settings.key = 2;
    const lead = p.tracks[0];
    const ys = [0.2, 0.4, 0.6, 0.8];
    const notes = ys.flatMap((y, i) => strokeToNotes({ ...stroke(lead.id, [{ x: i, y }], { kind: 'note', size: 1 }), shape: 'dot', id: `d${i}` }, lead, p.settings).notes);
    expect(notes.map((n) => n.start)).toEqual([0, 1, 2, 3]);
    expect(new Set(notes.map((n) => n.midi)).size).toBe(4);
    for (const n of notes) expect(inScale(n.midi, 2, 'dorian')).toBe(true);
    expect(notes.map((n) => n.midi)).toEqual([...notes.map((n) => n.midi)].sort((a, b) => a - b));
  });

  test('a horizontal line: repeated notes (note brush) vs one sustained note (legato brush)', () => {
    const p = testProject();
    const t = p.tracks[0];
    const pts = [{ x: 0, y: 0.5 }, { x: 4, y: 0.5 }];
    const rep = strokeToNotes(stroke(t.id, pts, { kind: 'note', size: 1, density: 4 }), t, p.settings).notes;
    const sus = strokeToNotes(stroke(t.id, pts, { kind: 'legato', size: 1 }), t, p.settings).notes;
    expect(rep.length).toBeGreaterThanOrEqual(16);
    expect(sus.length).toBe(1);
    expect(sus[0].dur).toBeGreaterThan(3);
  });

  test('brushes behave differently: drone sustains, arpeggio patterns, rhythm ratchets, thick brush clusters', () => {
    const p = testProject();
    const t = p.tracks[0];
    const rect = shapePoints('rect', { x: 0, y: 0.3 }, { x: 4, y: 0.6 });
    const drone = strokeToNotes(stroke(t.id, rect, { kind: 'drone' }), t, p.settings).notes;
    expect(drone.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...drone.map((n) => n.dur))).toBeGreaterThanOrEqual(4);
    const arp = strokeToNotes(stroke(t.id, [{ x: 0, y: 0.5 }, { x: 2, y: 0.5 }], { kind: 'arpeggio', density: 4 }), t, p.settings).notes;
    expect(new Set(arp.map((n) => n.midi)).size).toBeGreaterThanOrEqual(3);
    const zig = [{ x: 0, y: 0.2 }, { x: 0.05, y: 0.8 }, { x: 0.1, y: 0.2 }, { x: 0.15, y: 0.8 }];
    const rh = strokeToNotes(stroke(t.id, zig, { kind: 'rhythm', density: 4 }), t, p.settings).notes;
    expect(rh.length).toBeGreaterThan(1);
    const thin = strokeToNotes(stroke(t.id, [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], { kind: 'note', size: 1 }), t, p.settings).notes;
    const thick = strokeToNotes(stroke(t.id, [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], { kind: 'note', size: 8 }), t, p.settings).notes;
    expect(thick.length).toBeGreaterThan(thin.length);
  });

  test('modulation brush draws automation, not notes', () => {
    const p = testProject();
    const d = strokeToNotes(stroke(p.tracks[0].id, [{ x: 0, y: 0 }, { x: 4, y: 1 }], { kind: 'modulation', modTarget: 'cutoff' }), p.tracks[0], p.settings);
    expect(d.notes.length).toBe(0);
    expect(d.lane?.target).toBe('cutoff');
    expect(d.lane!.points[d.lane!.points.length - 1].value).toBeGreaterThan(d.lane!.points[0].value);
  });

  test('changing key/scale re-pitches derived notes without touching the drawing', () => {
    const p = testProject();
    const t = p.tracks[0];
    const s = stroke(t.id, [{ x: 0, y: 0.1 }, { x: 8, y: 0.9 }], { kind: 'note' });
    const notes = strokeToNotes(s, t, p.settings).notes;
    const before = structuredClone(s);
    const re = remapTrack({ ...t, notes }, { key: 1, scale: 'phrygian', customScale: [] });
    for (const n of re.notes) expect(inScale(n.midi, 1, 'phrygian')).toBe(true);
    expect(s).toEqual(before);
    // and back again restores the original pitches exactly
    const back = remapTrack(re, { key: 0, scale: 'major', customScale: [] });
    expect(back.notes.map((n) => n.midi)).toEqual(notes.map((n) => n.midi));
  });

  test('quantisation and probability are deterministic per stroke seed', () => {
    const p = testProject();
    const t = p.tracks[0];
    const s = stroke(t.id, [{ x: 0.07, y: 0.4 }, { x: 4.03, y: 0.6 }], { kind: 'note', probability: 0.5 });
    const a = strokeToNotes(s, t, p.settings).notes;
    const b = strokeToNotes(s, t, p.settings).notes;
    expect(a).toEqual(b);
    for (const n of a) expect((n.start * 4) % 1).toBeCloseTo(0, 6);
  });
});
