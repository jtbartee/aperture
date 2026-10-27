import { describe, expect, test } from 'vitest';
import { PPQ, parseMidi, projectToMidi } from '../../src/export/midi';
import { compose, defaultComposition } from '../../src/interpret/composer';
import { trackFromLayer } from '../../src/interpret/layers';
import { swingBeat } from '../../src/core/time';
import { testProject } from './helpers';

describe('MIDI export', () => {
  test('Example H: exported notes match the internal score (pitch, timing, duration, velocity, track membership)', () => {
    const p = testProject();
    p.settings.bpm = 110;
    p.settings.timeSig = '7/8';
    p.settings.swing = 0.4;
    const r = compose({ comp: { ...defaultComposition(), style: 'motorik', bars: 8 }, settings: p.settings });
    p.tracks = r.layers.map((l, i) => trackFromLayer(l, `t${i}`, '#fff', i));
    const midi = parseMidi(projectToMidi(p));
    expect(midi.header.tempos[0].bpm).toBeCloseTo(110, 3);
    expect(midi.header.timeSignatures[0].timeSignature).toEqual([7, 8]);
    const withNotes = p.tracks.filter((t) => t.notes.length);
    expect(midi.tracks.length).toBe(withNotes.length);
    withNotes.forEach((t, i) => {
      const mt = midi.tracks[i];
      expect(mt.name).toBe(t.name);
      if (t.patch.engine === 'drums') expect(mt.channel).toBe(9);
      else expect(mt.channel).not.toBe(9);
      const want = [...t.notes].sort((a, b) => a.start - b.start || a.midi - b.midi).map((n) => {
        const s = Math.round(swingBeat(n.start, 0.4, 16) * PPQ);
        return `${n.midi}@${s}+${Math.max(1, Math.round(swingBeat(n.start + n.dur, 0.4, 16) * PPQ) - s)}v${Math.floor(n.vel * 127)}`;
      });
      const got = [...mt.notes].sort((a, b) => a.ticks - b.ticks || a.midi - b.midi).map((n) => `${n.midi}@${n.ticks}+${n.durationTicks}v${Math.floor(n.velocity * 127 + 1e-6)}`);
      expect(got).toEqual(want);
    });
  });

  test('loop-region export starts at zero and contains only that range', () => {
    const p = testProject();
    p.tracks[0].notes = [0, 4, 8, 12].map((b, i) => ({ id: `n${i}`, start: b, dur: 1, midi: 60 + i, vel: 0.8, origin: 'user' as const }));
    const midi = parseMidi(projectToMidi(p, { from: 4, to: 12 }));
    expect(midi.tracks[0].notes.map((n) => [n.midi, n.ticks])).toEqual([[61, 0], [62, 4 * PPQ]]);
  });
});
