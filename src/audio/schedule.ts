// Pure scheduling logic shared by the live engine, offline render and MIDI export:
// which notes start inside a window of (performed, i.e. swung) beats.

import type { NoteEvent, Project, Track } from '../core/types';
import { swingBeat } from '../core/time';
import { audible } from './graph-audible';

export interface Scheduled { track: Track; note: NoteEvent; beat: number; endBeat: number }

interface SortedNotes { swing: number; grid: number; notes: NoteEvent[]; perf: Float64Array; perfEnd: Float64Array }
const cache = new WeakMap<NoteEvent[], SortedNotes>();

/** Notes sorted by performed start time (cached per notes array identity + swing). */
export function performedNotes(notes: NoteEvent[], swing: number, grid: 8 | 16): SortedNotes {
  const c = cache.get(notes);
  if (c && c.swing === swing && c.grid === grid) return c;
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
  const perf = new Float64Array(sorted.length);
  const perfEnd = new Float64Array(sorted.length);
  sorted.forEach((n, i) => {
    perf[i] = swingBeat(n.start, swing, grid);
    perfEnd[i] = Math.max(perf[i] + 0.01, swingBeat(n.start + n.dur, swing, grid));
  });
  const out = { swing, grid, notes: sorted, perf, perfEnd };
  cache.set(notes, out);
  return out;
}

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < x - 1e-9) lo = m + 1; else hi = m;
  }
  return lo;
}

/** Every audible note whose performed start lies in [from, to). */
export function eventsInWindow(p: Project, from: number, to: number, only?: Set<string>): Scheduled[] {
  const out: Scheduled[] = [];
  const anySolo = p.tracks.some((t) => t.mix.solo);
  for (const t of p.tracks) {
    if (only ? !only.has(t.id) : !audible(t, anySolo)) continue;
    const s = performedNotes(t.notes, p.settings.swing, p.settings.swingGrid);
    for (let i = lowerBound(s.perf, from); i < s.notes.length && s.perf[i] < to - 1e-9; i++) {
      out.push({ track: t, note: s.notes[i], beat: s.perf[i], endBeat: s.perfEnd[i] });
    }
  }
  return out.sort((a, b) => a.beat - b.beat);
}

/** Notes already sounding at `at` (started earlier, still held) — re-triggered when playback
 *  starts or seeks mid-note so long drones are not silent until their next onset. */
export function chaseNotes(p: Project, at: number, only?: Set<string>, minRemain = 0.5): Scheduled[] {
  const out: Scheduled[] = [];
  const anySolo = p.tracks.some((t) => t.mix.solo);
  for (const t of p.tracks) {
    if (only ? !only.has(t.id) : !audible(t, anySolo)) continue;
    const s = performedNotes(t.notes, p.settings.swing, p.settings.swingGrid);
    for (let i = 0; i < s.notes.length && s.perf[i] < at - 1e-9; i++) {
      if (s.perfEnd[i] - at >= minRemain) out.push({ track: t, note: s.notes[i], beat: at, endBeat: s.perfEnd[i] });
    }
  }
  return out;
}

export function lastNoteEnd(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const n of t.notes) end = Math.max(end, n.start + n.dur);
  return end;
}
