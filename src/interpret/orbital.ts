// ORBITAL SEQUENCER: drawing in polar space. Angle = time around the circle (one revolution =
// `bars`), radius = pitch (rim = high). Strokes are converted into ordinary strokes and pass
// through the same stroke→note converter as the canvas, so brushes, editing and export are shared.

import type { AutomationLane, OrbitalSource, ProjectSettings, Stroke, Track } from '../core/types';
import { barBeats } from '../core/time';
import { strokeToNotes } from './strokes';

export function orbitalToLinear(s: Stroke, o: OrbitalSource, ps: Pick<ProjectSettings, 'timeSig'>): Stroke {
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

export function orbitalNotes(o: OrbitalSource, track: Track, ps: ProjectSettings) {
  const notes = o.strokes.flatMap((s) => strokeToNotes(orbitalToLinear({ ...s, trackId: track.id }, o, ps), track, ps).notes)
    .map((n) => ({ ...n, origin: 'orbital' as const }));
  // angular position also drives stereo position: the circle maps onto the stereo field
  const beats = o.bars * barBeats(ps.timeSig);
  const pan: AutomationLane | null = o.strokes.length
    ? { id: 'orbital_pan', target: 'pan', origin: 'generated', points: Array.from({ length: 33 }, (_, i) => ({ beat: (i / 32) * beats, value: 0.5 + 0.35 * Math.sin((i / 32) * Math.PI * 2) })) }
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
