// ORBITAL SEQUENCER: drawing in polar space. Angle = time around the circle (one revolution =
// `bars`), radius = pitch (rim = high). Strokes are converted into ordinary strokes and pass
// through the same stroke→note converter as the canvas, so brushes, editing and export are shared.
//
// Several voices can orbit at once, each with its own layer, revolution length and direction.
// A voice can repeat its revolution through the whole project; each turn re-reads the shared
// harmony at the moment a note sounds, so the same drawn figure adapts when the chords change:
//   scale     — radius → scale rows (the original mapping; the figure never changes)
//   guided    — strong positions and long notes move to the nearest chord tone, others stay put
//   chord     — every note is the chord tone nearest its radius
//   chromatic — radius → semitones, no key

import type { AutomationLane, NoteEvent, OrbitalVoice, ProjectSettings, Stroke, Track } from '../core/types';
import { barBeats } from '../core/time';
import { type MusicalContext, adaptNotes } from '../theory/context';
import { strokeToNotes } from './strokes';

type VoiceShape = Pick<OrbitalVoice, 'bars' | 'direction' | 'strokes'> & Partial<Pick<OrbitalVoice, 'pitch' | 'fill' | 'adapt' | 'trackId'>>;

export function defaultOrbitalVoice(trackId: string, id = 'orb_1'): OrbitalVoice {
  return { id, bars: 4, direction: 'cw', trackId, strokes: [], pitch: 'guided', fill: true, adapt: 0.7 };
}

export function orbitalToLinear(s: Stroke, o: Pick<OrbitalVoice, 'bars' | 'direction'>, ps: Pick<ProjectSettings, 'timeSig'>): Stroke {
  const beats = o.bars * barBeats(ps.timeSig);
  // unwrap the angle so a stroke drawn across 12 o'clock stays continuous
  let prev = -1;
  let turns = 0;
  const pts = s.points.map((p) => {
    let a = o.direction === 'cw' ? p.x : 1 - p.x;
    if (prev >= 0 && a - prev < -0.5) turns++;
    if (prev >= 0 && a - prev > 0.5) turns--;
    prev = a;
    a += turns;
    return { x: (((a % 1) + 1) % 1) * beats, y: p.y };
  });
  return { ...s, points: pts };
}

/** Notes of one voice. With a musical context and a total length, the revolution repeats and each
 *  repetition is fitted to the harmony sounding at that time. */
export function orbitalNotes(o: VoiceShape, track: Track, ps: ProjectSettings, ctx?: MusicalContext, totalBeats?: number) {
  const beats = o.bars * barBeats(ps.timeSig);
  const one = o.strokes.flatMap((s) => strokeToNotes(orbitalToLinear({ ...s, trackId: track.id }, o, ps), track, ps).notes)
    .map((n) => ({ ...n, origin: 'orbital' as const }));
  const reps = o.fill && totalBeats && totalBeats > beats ? Math.ceil(totalBeats / beats - 1e-6) : 1;
  const end = reps > 1 ? totalBeats! : Infinity;
  const drums = track.pitch.mode === 'drums';
  const mode = drums ? 'scale' : o.pitch ?? 'scale';
  const lo = Math.min(track.pitch.low, track.pitch.high), hi = Math.max(track.pitch.low, track.pitch.high);
  let notes: NoteEvent[] = [];
  for (let r = 0; r < reps; r++) {
    for (const n of one) {
      const start = n.start + r * beats;
      if (start >= end - 1e-9) continue;
      const midi = mode === 'chromatic' && n.pitchY !== undefined ? Math.round(lo + n.pitchY * (hi - lo)) : n.midi;
      notes.push({ ...n, id: `${n.id}_r${r}`, start, midi });
    }
  }
  if (ctx && (mode === 'chord' || mode === 'guided')) notes = adaptNotes(ctx, notes, mode, o.adapt ?? 0.7);
  // angular position also drives stereo position: the circle maps onto the stereo field
  const total = reps * beats;
  const pan: AutomationLane | null = o.strokes.length
    ? { id: 'orbital_pan', target: 'pan', origin: 'generated', points: Array.from({ length: 32 * reps + 1 }, (_, i) => ({ beat: (i / 32) * beats, value: 0.5 + 0.35 * Math.sin((i / 32) * Math.PI * 2) })).filter((p) => p.beat <= total + 1e-6) }
    : null;
  return { notes, pan };
}

/** Polar ↔ unit-square helpers for the circular canvas. */
export function polarFromXY(x: number, y: number): { angle: number; radius: number } {
  const dx = x - 0.5;
  const dy = y - 0.5;
  let a = Math.atan2(dx, -dy) / (2 * Math.PI);
  if (a < 0) a += 1;
  return { angle: a, radius: Math.min(1, Math.hypot(dx, dy) / 0.5) };
}

export function xyFromPolar(angle: number, radius: number): { x: number; y: number } {
  const t = angle * 2 * Math.PI;
  return { x: 0.5 + Math.sin(t) * radius * 0.5, y: 0.5 - Math.cos(t) * radius * 0.5 };
}
