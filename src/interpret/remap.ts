// Key / scale / range changes re-pitch existing notes WITHOUT touching their sources:
//  - notes with pitchY (drawn, image, panorama) go back through the track's pitch mapping
//  - notes with a degree (theory-generated) are rebuilt from the scale
//  - other notes (free MIDI, chromatic brush) keep their absolute pitch.

import type { NoteEvent, Project, ProjectSettings, Track } from '../core/types';
import { allowedPitches, degreeToMidi, mapY } from '../theory/scales';

/** The C at or below the track's lowest note anchors degree 0 for generated material. */
export const degreeBase = (t: Pick<Track, 'pitch'>) => 12 * Math.floor(t.pitch.low / 12);

export function remapNote(n: NoteEvent, t: Track, s: Pick<ProjectSettings, 'key' | 'scale' | 'customScale'>, pitches: number[]): number {
  if (n.pitchY !== undefined) return mapY(n.pitchY, pitches, n.stepOffset ?? 0);
  if (n.degree !== undefined) return degreeToMidi(n.degree, s.key, s.scale, degreeBase(t), s.customScale);
  return n.midi;
}

export function remapTrack(t: Track, s: Pick<ProjectSettings, 'key' | 'scale' | 'customScale'>): Track {
  if (t.pitch.mode === 'drums') return t;
  const pitches = allowedPitches(t.pitch, s.key, s.scale, s.customScale);
  let changed = false;
  const notes = t.notes.map((n) => {
    const m = Math.max(0, Math.min(127, remapNote(n, t, s, pitches)));
    if (m === n.midi) return n;
    changed = true;
    return { ...n, midi: m };
  });
  return changed ? { ...t, notes } : t;
}

export function remapProject(p: Project): Project {
  return { ...p, tracks: p.tracks.map((t) => remapTrack(t, p.settings)) };
}
