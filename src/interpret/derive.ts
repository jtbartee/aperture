import type { NoteEvent, Project } from '../core/types';
import { uid } from '../core/ids';
import { adaptNotes, musicalContext } from '../theory/context';
import { mergeLane, strokeToNotes } from './strokes';

/** Re-derive the notes of the given strokes (and drop notes of removed strokes). Pure. */
export function deriveStrokes(p: Project, strokeIds: Set<string>, removed: Set<string> = new Set()): Project {
  const touched = new Set([...strokeIds, ...removed]);
  const ctx = p.harmony ? musicalContext(p.settings, p.harmony) : undefined;
  const tracks = p.tracks.map((t) => {
    const mine = p.strokes.filter((s) => s.trackId === t.id && strokeIds.has(s.id));
    const keep = t.notes.filter((n) => !n.strokeId || !touched.has(n.strokeId));
    if (keep.length === t.notes.length && !mine.length) return t;
    let automation = t.automation;
    const add: NoteEvent[] = [];
    for (const s of mine) {
      const d = strokeToNotes(s, t, p.settings);
      const h = s.brush.harmony;
      add.push(...(ctx && t.pitch.mode !== 'drums' && (h === 'guided' || h === 'chord') ? adaptNotes(ctx, d.notes, h) : d.notes));
      if (d.lane) {
        const lane = automation.find((l) => l.target === d.lane!.target && l.origin === 'drawn');
        automation = lane
          ? automation.map((l) => (l === lane ? { ...l, points: mergeLane(l.points, d.lane!.points) } : l))
          : [...automation, { id: uid('lane'), target: d.lane.target, points: d.lane.points, origin: 'drawn' }];
      }
    }
    return { ...t, notes: [...keep, ...add].sort((a, b) => a.start - b.start), automation };
  });
  return { ...p, tracks };
}

export const deriveAll = (p: Project) => deriveStrokes(p, new Set(p.strokes.map((s) => s.id)));

/** Re-derive the strokes whose brush follows the harmony (after the harmony changed). */
export function deriveHarmonic(p: Project): Project {
  const ids = p.strokes.filter((s) => s.brush.harmony === 'guided' || s.brush.harmony === 'chord').map((s) => s.id);
  return ids.length ? deriveStrokes(p, new Set(ids)) : p;
}
