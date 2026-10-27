// Standard MIDI export from the same event data the sequencer plays. Swing is applied exactly as
// the live scheduler applies it, so exported timing matches what was heard.

import { Midi } from '@tonejs/midi';
import type { Project, Role } from '../core/types';
import { TIME_SIGS, swingBeat } from '../core/time';

export const PPQ = 480;

const GM_PROGRAM: Record<Role, number> = { pad: 89, drone: 95, bass: 38, melody: 80, arp: 81, chords: 4, texture: 98, percussion: 0 };

export interface MidiExportOptions { from?: number; to?: number; includeMuted?: boolean; automation?: boolean }

export function projectToMidi(p: Project, o: MidiExportOptions = {}): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(p.settings.bpm);
  const ts = TIME_SIGS[p.settings.timeSig];
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [ts.num, ts.den], measures: 0 });
  midi.header.name = p.name;
  const from = o.from ?? 0;
  const to = o.to ?? Infinity;
  const tick = (beat: number) => Math.max(0, Math.round((swingBeat(beat, p.settings.swing, p.settings.swingGrid) - swingBeat(from, p.settings.swing, p.settings.swingGrid)) * PPQ));
  const anySolo = p.tracks.some((t) => t.mix.solo);
  let chan = 0;
  for (const t of p.tracks) {
    const audible = anySolo ? t.mix.solo : !t.mix.mute;
    if (!audible && !o.includeMuted) continue;
    const notes = t.notes.filter((n) => n.start >= from - 1e-9 && n.start < to - 1e-9);
    if (!notes.length) continue;
    const tr = midi.addTrack();
    tr.name = t.name;
    const drums = t.patch.engine === 'drums';
    if (drums) tr.channel = 9;
    else { if (chan === 9) chan++; tr.channel = chan % 16; chan++; if (chan === 9) chan++; }
    tr.instrument.number = drums ? 0 : GM_PROGRAM[t.role];
    for (const n of notes) {
      const start = tick(n.start);
      const end = tick(Math.min(n.start + n.dur, to));
      tr.addNote({ midi: Math.max(0, Math.min(127, n.midi)), ticks: start, durationTicks: Math.max(1, end - start), velocity: Math.max(0.01, Math.min(1, n.vel)) });
    }
    if (o.automation !== false) {
      for (const lane of t.automation) {
        const cc = lane.target === 'cutoff' ? 74 : lane.target === 'pan' ? 10 : lane.target === 'volume' ? 11 : null;
        if (cc === null) continue;
        let last = -1;
        for (const pt of lane.points) {
          if (pt.beat < from || pt.beat > to) continue;
          const v = Math.round(pt.value * 127);
          if (v === last) continue;
          last = v;
          tr.addCC({ number: cc, ticks: tick(pt.beat), value: v / 127 });
        }
      }
    }
  }
  return midi.toArray();
}

export function parseMidi(bytes: Uint8Array) {
  return new Midi(bytes);
}
