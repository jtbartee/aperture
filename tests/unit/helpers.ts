import type { NoteEvent, Project, Stroke } from '../../src/core/types';
import { newProject } from '../../src/state/project';
import { defaultBrush } from '../../src/interpret/strokes';

export function testProject(): Project {
  const p = newProject('test');
  p.settings.key = 0;
  p.settings.scale = 'major';
  return p;
}

export function stroke(trackId: string, points: { x: number; y: number }[], brush: Partial<Stroke['brush']> = {}, id = 's1'): Stroke {
  return { id, trackId, shape: 'freehand', brush: defaultBrush(brush), points, seed: 42 };
}

/** Onset histogram over 16 positions per bar (pitch-blind), normalised. */
export function onsetHistogram(notes: NoteEvent[], barBeats = 4, bins = 16): number[] {
  const h = new Array(bins).fill(0);
  for (const n of notes) h[Math.floor(((n.start % barBeats) / barBeats) * bins + 1e-6) % bins]++;
  const s = h.reduce((a, b) => a + b, 0) || 1;
  return h.map((x) => x / s);
}

/** Bray–Curtis distance between two histograms (0 identical … 1 disjoint). */
export function brayCurtis(a: number[], b: number[]): number {
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { num += Math.abs(a[i] - b[i]); den += a[i] + b[i]; }
  return den ? num / den : 0;
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
