// Drawing → notes. Horizontal = time (beats), vertical = pitch row of the track's pitch mapping.
// Each stroke keeps its own brush settings and seed, so its notes can be re-derived exactly
// whenever the stroke is moved, resized or its brush is changed.

import type { AutomationLane, BrushSettings, NoteEvent, ProjectSettings, Stroke, Track } from '../core/types';
import { rng } from '../core/rng';
import { metricWeight, barBeats } from '../core/time';
import { allowedPitches, mapY } from '../theory/scales';

export function defaultBrush(partial: Partial<BrushSettings> = {}): BrushSettings {
  return {
    kind: 'note', size: 2, density: 4, duration: 1, velocity: 0.75, quantize: true, probability: 1,
    legato: 0.9, octave: 0, snap: true, articulation: 'normal', arpPattern: 'up', modTarget: 'cutoff', ...partial,
  };
}

type Pt = { x: number; y: number };

/** Resample a polyline so consecutive points are close in both axes. */
export function densify(points: Pt[], dx: number, dy: number): Pt[] {
  if (points.length < 2) return points.slice();
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x) / dx, Math.abs(b.y - a.y) / dy)));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Outline points for geometric shapes (drawn from two corner points). */
export function shapePoints(shape: Stroke['shape'], a: Pt, b: Pt): Pt[] {
  if (shape === 'rect') return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
  if (shape === 'ellipse') {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2;
    const ry = Math.abs(b.y - a.y) / 2;
    return Array.from({ length: 49 }, (_, i) => {
      const t = (i / 48) * Math.PI * 2 - Math.PI / 2;
      return { x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry };
    });
  }
  if (shape === 'line') return [a, b];
  return [a];
}

/** Catmull-Rom spline through control points (the curve tool). */
export function catmullRom(ctrl: Pt[], perSeg = 12): Pt[] {
  if (ctrl.length < 3) return ctrl.slice();
  const out: Pt[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    for (let k = 0; k < perSeg; k++) {
      const t = k / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}

function articulation(b: BrushSettings) {
  switch (b.articulation) {
    case 'staccato': return { gate: 0.4, vel: 1 };
    case 'accent': return { gate: 0.85, vel: 1.25 };
    case 'tenuto': return { gate: 1.05, vel: 0.95 };
    default: return { gate: 1, vel: 1 };
  }
}

export interface DerivedStroke { notes: NoteEvent[]; lane?: { target: AutomationLane['target']; points: { beat: number; value: number }[] } }

export function strokeToNotes(stroke: Stroke, track: Track, s: Pick<ProjectSettings, 'key' | 'scale' | 'customScale' | 'timeSig'>): DerivedStroke {
  const b = stroke.brush;
  const step = 1 / Math.max(1, b.density);
  const scaled = b.snap || track.pitch.mode === 'drums';
  const pitches = allowedPitches(scaled ? track.pitch : { ...track.pitch, mode: 'chromatic' }, s.key, s.scale, s.customScale);
  const rows = pitches.length;
  const perOct = track.pitch.mode === 'drums' ? 0 : pitches.filter((m) => m < pitches[0] + 12).length;
  const octSteps = b.octave * perOct;
  const r = rng(stroke.seed);
  const art = articulation(b);
  const bb = barBeats(s.timeSig);
  const pts = densify(stroke.points, step / 3, 0.5 / Math.max(2, rows));
  const rowOf = (y: number) => Math.round(Math.max(0, Math.min(1, y)) * (rows - 1));
  const yOfRow = (row: number) => (rows > 1 ? row / (rows - 1) : 0.5);
  const sizeVel = 0.75 + 0.25 * Math.min(1, b.size / 8);
  const notes: NoteEvent[] = [];
  let k = 0;
  const add = (start: number, dur: number, row: number, vel: number, stepOffset = 0) => {
    if (start < 0) return;
    if (b.probability < 1 && !r.chance(b.probability)) return;
    const y = yOfRow(Math.max(0, Math.min(rows - 1, row)));
    const off = stepOffset + octSteps;
    notes.push({
      id: `${stroke.id}_${k++}`,
      start,
      dur: Math.max(0.03, dur),
      midi: mapY(y, pitches, off),
      vel: Math.max(0.05, Math.min(1, vel * art.vel)),
      origin: 'drawn',
      pitchY: scaled ? y : undefined,
      stepOffset: scaled && off ? off : undefined,
      strokeId: stroke.id,
    });
  };
  const col = (x: number) => Math.floor(x / step + 1e-9);
  const startOf = (x: number) => (b.quantize ? col(x) * step : x);

  // column → rows touched (in drawing order)
  const columns = new Map<number, { rows: Set<number>; ys: number[]; x: number }>();
  for (const p of pts) {
    if (p.x < 0) continue;
    const c = col(p.x);
    let e = columns.get(c);
    if (!e) { e = { rows: new Set(), ys: [], x: p.x }; columns.set(c, e); }
    e.rows.add(rowOf(p.y));
    e.ys.push(p.y);
  }
  const cols = [...columns.keys()].sort((a, z) => a - z);
  const clusterHalf = b.size <= 2 ? 0 : Math.floor((b.size - 1) / 3);

  switch (b.kind) {
    case 'note': {
      for (const c of cols) {
        const e = columns.get(c)!;
        const rowSet = new Set<number>();
        for (const row of e.rows) for (let d = -clusterHalf; d <= clusterHalf; d++) rowSet.add(row + d * 2);
        for (const row of rowSet) add(startOf(e.x), b.duration * step * b.legato * art.gate, row, b.velocity * sizeVel);
      }
      break;
    }
    case 'legato': {
      let runRow = -1;
      let runStart = 0;
      let runEnd = 0;
      const flush = () => { if (runRow >= 0) add(runStart, (runEnd - runStart) * Math.max(0.5, b.legato) * art.gate, runRow, b.velocity * sizeVel); };
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const e = columns.get(c)!;
        const mean = e.ys.reduce((s, y) => s + y, 0) / e.ys.length;
        const row = rowOf(mean);
        const gap = i > 0 && c !== cols[i - 1] + 1;
        if (row !== runRow || gap) {
          flush();
          runRow = row;
          runStart = startOf(e.x);
        }
        runEnd = (b.quantize ? c * step : e.x) + step;
      }
      flush();
      break;
    }
    case 'arpeggio': {
      // per beat: the rows the stroke covers become the arpeggio's chord (single row → stacked scale thirds)
      const span = 1;
      const byBeat = new Map<number, Set<number>>();
      for (const c of cols) {
        const beat = Math.floor((c * step) / span);
        const set = byBeat.get(beat) ?? new Set<number>();
        columns.get(c)!.rows.forEach((row) => set.add(row));
        byBeat.set(beat, set);
      }
      for (const [beat, set] of [...byBeat.entries()].sort((a, z) => a[0] - z[0])) {
        const base = Math.min(...set);
        const tones: { row: number; off: number }[] = set.size >= 3
          ? [...set].sort((a, z) => a - z).slice(0, 6).map((row) => ({ row, off: 0 }))
          : [0, 2, 4, perOct || 7].map((off) => ({ row: base, off }));
        let seq = tones.map((_, i) => i);
        if (b.arpPattern === 'down') seq.reverse();
        if (b.arpPattern === 'updown') seq = [...seq, ...seq.slice(1, -1).reverse()];
        const n = Math.round(span / step);
        for (let i = 0; i < n; i++) {
          const idx = b.arpPattern === 'random' ? r.int(0, tones.length - 1) : seq[i % seq.length];
          const t = tones[idx];
          add(beat * span + i * step, step * b.legato * art.gate, t.row, b.velocity * (i === 0 ? 1 : 0.85), t.off);
        }
      }
      break;
    }
    case 'drone': {
      if (!pts.length) break;
      const xs = pts.map((p) => p.x);
      const x0 = startOf(Math.max(0, Math.min(...xs)));
      const x1 = Math.max(x0 + step * 4, b.quantize ? Math.ceil(Math.max(...xs) / step) * step : Math.max(...xs));
      const all = [...new Set(pts.map((p) => rowOf(p.y)))].sort((a, z) => a - z);
      // up to four rows: lowest, highest and evenly spaced between
      const pick = all.length <= 4 ? all : [0, 1, 2, 3].map((i) => all[Math.round((i / 3) * (all.length - 1))]);
      for (const row of [...new Set(pick)]) add(x0, (x1 - x0) * Math.max(1, b.legato), row, b.velocity * 0.7 * sizeVel);
      break;
    }
    case 'rhythm': {
      for (const c of cols) {
        const e = columns.get(c)!;
        const start = startOf(e.x);
        const mw = metricWeight(s.timeSig, ((start % bb) + bb) % bb);
        const spanY = Math.max(...e.ys) - Math.min(...e.ys);
        const row = rowOf(e.ys[0]);
        const vel = b.velocity * (0.6 + 0.4 * mw) * sizeVel;
        // a vertical scribble inside one step becomes a ratchet
        const ratchet = spanY > 0.12 ? Math.min(4, 1 + Math.floor(spanY / 0.12)) : 1;
        for (let j = 0; j < ratchet; j++) add(start + (j * step) / ratchet, (step / ratchet) * 0.6 * art.gate, row, vel * (1 - j * 0.12));
      }
      break;
    }
    case 'modulation': {
      const lanePts = pts.filter((p) => p.x >= 0).map((p) => ({ beat: p.x, value: Math.max(0, Math.min(1, p.y)) }));
      lanePts.sort((a, z) => a.beat - z.beat);
      return { notes: [], lane: { target: b.modTarget, points: thin(lanePts, 0.0625) } };
    }
  }
  return { notes, lane: undefined };
}

function thin(pts: { beat: number; value: number }[], minDx: number) {
  const out: typeof pts = [];
  for (const p of pts) if (!out.length || p.beat - out[out.length - 1].beat >= minDx) out.push(p);
  return out;
}

/** Merge a drawn modulation stroke into a lane: points inside the stroke's span are replaced. */
export function mergeLane(existing: { beat: number; value: number }[], incoming: { beat: number; value: number }[]) {
  if (!incoming.length) return existing;
  const a = incoming[0].beat;
  const z = incoming[incoming.length - 1].beat;
  return [...existing.filter((p) => p.beat < a || p.beat > z), ...incoming].sort((x, y) => x.beat - y.beat);
}
