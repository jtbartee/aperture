// SONIFICATION CORE shared by the Image and Panorama workspaces.
//
// Contours → voices. Each contour is split into x-monotone pieces (a loop or a line that doubles
// back becomes simultaneous lines, a vertical run becomes a sweep or strum). Horizontal position is
// time, vertical position is pitch, edge strength is velocity, curvature is articulation, thickness
// is per-note timbre. Gaps between contours are silence. Nothing is placed on a metrical grid unless
// MUSICAL STRUCTURE asks for it.
//
// The four shaping controls do different jobs:
//   interpretation (Literal ↔ Musical) — gesture shaping: simplification, phrase segmentation,
//       note grouping, legato, harmonisation, loop arpeggiation. 0 = every visible bend.
//   structure — the pitch and time systems: <20 % with glide = microtonal, otherwise scale (or
//       chromatic) quantisation; above ~30 % onsets are pulled toward a grid; above 60 % long notes
//       lean to the image harmony's chord tones.
//   fidelity — how far any transformation may move material from its visual position: high values
//       disable register compression, octave folding and harmonisation and soften grid snapping.
//   density — how many contours speak and how finely a contour is read (note resolution).
//
// Event timing for free-time and texture rhythm is taken from image evidence: contour starts,
// junctions, extrema, abrupt column boundaries and peaks of the column edge profile. A uniform
// image produces no events.

import type { NoteEvent, NoteOrigin, PitchMapping, ProjectSettings, SonifyShape } from '../core/types';
import type { Rng } from '../core/rng';
import { type Contour, type ContourSet, catmullRom, monotonePieces, type Piece } from '../analysis/contours';
import type { FeatureGrid } from '../analysis/features';
import { EDGE_BINS } from '../analysis/features';
import { type ChordSlot, chordAt } from '../theory/progression';
import { allowedPitches, mapY } from '../theory/scales';
import { defaultSynthMap } from '../audio/imageSynth';

const c01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function defaultShape(): SonifyShape {
  return {
    fidelity: 0.65, structure: 0.35, evolution: 0.6, interpretation: 0.3,
    glide: false, scaleLock: true, rhythm: 'free', synth: 'image', synthMap: defaultSynthMap(),
  };
}

/** Behaviour that reproduces the pre-sonification engine for projects saved before it existed. */
export function legacyShape(): SonifyShape {
  return { ...defaultShape(), structure: 0.7, interpretation: 0.75, evolution: 0, rhythm: 'metric', synth: 'presets' };
}

// ------------------------------------------------------------------ time mapping

/** A stretch of the scan during which image x moves monotonically from x0 to x1 (beats t0→t1). */
export interface ScanSeg { t0: number; t1: number; x0: number; x1: number }

/** Monotone pieces of the scan path x(t). `pathX(j)` is the scan x at sample j of n. */
export function scanSegments(beats: number, n: number, pathX: (j: number) => number): ScanSeg[] {
  const out: ScanSeg[] = [];
  if (n < 2) return [{ t0: 0, t1: beats, x0: 0, x1: 1 }];
  let a = 0;
  let dir = 0;
  for (let j = 1; j < n; j++) {
    const d = Math.sign(pathX(j) - pathX(j - 1));
    if (!d) continue;
    if (dir && d !== dir) { out.push({ t0: (a / (n - 1)) * beats, t1: ((j - 1) / (n - 1)) * beats, x0: pathX(a), x1: pathX(j - 1) }); a = j - 1; }
    dir = d;
  }
  out.push({ t0: (a / (n - 1)) * beats, t1: beats, x0: pathX(a), x1: pathX(n - 1) });
  return out.filter((s) => Math.abs(s.x1 - s.x0) > 1e-6);
}

export interface Sample { t: number; x: number; y: number; s: number; k: number }

/** Sample a piece along time for one scan segment (may be empty if the segment never visits it). */
function pieceStream(p: Piece, seg: ScanSeg, res: number, aspect: number): Sample[] {
  const lo = Math.min(seg.x0, seg.x1), hi = Math.max(seg.x0, seg.x1);
  const px0 = p.pts[0].x, px1 = p.pts[p.pts.length - 1].x;
  const a = Math.max(lo, px0), b = Math.min(hi, px1);
  if (b - a < 1e-6) return [];
  const dense = catmullRom(p.pts, 0.0025, false, 1 / aspect);
  // enforce monotone x on the interpolated curve (Catmull–Rom can overshoot slightly)
  for (let i = 1; i < dense.length; i++) if (dense[i].x < dense[i - 1].x) dense[i] = { ...dense[i], x: dense[i - 1].x };
  const tOf = (x: number) => seg.t0 + ((x - seg.x0) / (seg.x1 - seg.x0)) * (seg.t1 - seg.t0);
  const n = Math.max(2, Math.ceil(Math.abs(tOf(b) - tOf(a)) / res) + 1);
  const out: Sample[] = [];
  let j = 0, v = 0;
  // walk left → right in x (linear time), reverse afterwards if the scan runs right → left
  for (let k = 0; k < n; k++) {
    const x = a + ((b - a) * k) / (n - 1);
    while (j < dense.length - 2 && dense[j + 1].x < x) j++;
    while (v < p.pts.length - 2 && p.pts[v + 1].x < x) v++;
    const d0 = dense[j], d1 = dense[j + 1] ?? d0;
    const f = d1.x > d0.x ? c01((x - d0.x) / (d1.x - d0.x)) : 0;
    const q0 = p.pts[v], q1 = p.pts[v + 1] ?? q0;
    const g = q1.x > q0.x ? c01((x - q0.x) / (q1.x - q0.x)) : 0;
    const at = (arr: number[]) => (arr[v] ?? 0) * (1 - g) + (arr[v + 1] ?? arr[v] ?? 0) * g;
    out.push({ t: tOf(x), x, y: d0.y + (d1.y - d0.y) * f, s: at(p.str), k: Math.abs(at(p.curv)) });
  }
  if (out[out.length - 1].t < out[0].t) out.reverse();
  return out;
}

// ------------------------------------------------------------------ pitch space

export interface PitchSpace { mapping: PitchMapping; pitches: number[]; key: number; quant: 'continuous' | 'steps'; glide: boolean; low: number; high: number }

export function pitchSpace(mapping: PitchMapping, ps: ProjectSettings, shape: SonifyShape): PitchSpace {
  const pitches = allowedPitches(mapping, ps.key, ps.scale, ps.customScale);
  return {
    mapping, pitches, key: ps.key, glide: shape.glide,
    quant: shape.glide && shape.structure < 0.2 ? 'continuous' : 'steps',
    low: Math.min(mapping.low, mapping.high), high: Math.max(mapping.low, mapping.high),
  };
}

/** Pitch track for a voice: chromatic rows when scale lock is off. */
export function voicePitch(shape: SonifyShape, low = 36, high = 93): PitchMapping {
  return { mode: shape.scaleLock ? 'scale' : 'chromatic', low, high };
}

const contP = (sp: PitchSpace, y: number) => sp.low + c01(y) * (sp.high - sp.low);

// ------------------------------------------------------------------ contour voices

export interface VoiceInput {
  contours: Contour[];
  shape: SonifyShape;
  density: number;
  ps: ProjectSettings;
  segs: ScanSeg[];
  pitch: PitchMapping;
  rng: Rng;
  idPrefix: string;
  origin: NoteOrigin;
  /** analysed image width / height, so curvature and vertical runs are judged in true proportion */
  aspect: number;
  harmony?: ChordSlot[];
  /** extra vertical compression centre (0..1) for this voice's register */
  center?: number;
  /** analysed image width in pixels (monotone-split tolerance) */
  pxWidth: number;
  /** sample spacing in beats (finer = more detail; long panoramas use coarser) */
  res?: number;
}

/** How many contours speak at a given density (salience-ranked input). */
export function contourCount(total: number, density: number): number {
  if (!total) return 0;
  return Math.max(1, Math.min(total, Math.ceil(total * (0.15 + 0.85 * Math.pow(c01(density), 1.2)))));
}

interface Draft { start: number; end: number; y: number; ys: number[]; s: number; k: number; x: number; bend?: [number, number][]; accent?: boolean; cid: string }

/** Notes for a set of contours (one musical voice). */
export function contourVoice(i: VoiceInput): NoteEvent[] {
  const sh = i.shape;
  const W = c01(sh.interpretation);
  const F = c01(sh.fidelity);
  const Q = c01(sh.structure);
  const sp = pitchSpace(i.pitch, i.ps, sh);
  const comp = lerp(0.62, 1, F); // register compression at low fidelity
  const center = i.center ?? 0.5;
  const yv = (y: number) => c01(center + (y - center) * comp);
  const res = i.res ?? 1 / 64;
  const minDur = Math.max(1 / 32, lerp(1 / 32, 0.5, W) * lerp(1.6, 0.6, c01(i.density)));
  const notes: NoteEvent[] = [];
  let k = 0;
  const id = () => `${i.idPrefix}_${k++}`;
  const qY = (y: number) => {
    // the y a quantised pitch corresponds to (keeps pitchY consistent with key remapping)
    const n = sp.pitches.length;
    return n > 1 ? Math.round(c01(y) * (n - 1)) / (n - 1) : 0.5;
  };
  const midiOf = (y: number) => mapY(y, sp.pitches);
  const perOct = Math.max(1, sp.pitches.filter((m) => m < sp.pitches[0] + 12).length);
  for (const c of i.contours) {
    const first = notes.length;
    // low fidelity: the seed may displace a whole contour by an octave (shape kept, register moved)
    const shift = F < 0.8 && i.rng.chance((0.8 - F) * 0.6) ? (i.rng.chance(0.5) ? 1 : -1) * perOct : 0;
    const intensity = c.intensity, thick = Math.round(c.thickness * 1000) / 1000;
    const arpeggiate = c.closed && W > 0.55;
    const pieces: Piece[] = arpeggiate
      ? [loopAsPiece(c)]
      : monotonePieces(c, 1.5 / Math.max(64, i.pxWidth));
    for (const p of pieces) {
      for (const seg of i.segs) {
        let S = pieceStream(p, seg, res, i.aspect);
        if (S.length < 2) continue;
        if (arpeggiate) S = loopTraversal(c, S);
        // vertical run: no horizontal extent — a sweep (literal) or a strum (musical)
        if (p.vertical || S[S.length - 1].t - S[0].t < 1 / 16) {
          const ys = p.pts.map((q) => q.y);
          const lo = Math.min(...ys), hi = Math.max(...ys);
          const t = S[0].t;
          const vel = 0.3 + 0.6 * intensity;
          if (hi - lo < 0.03) {
            // a tiny fragment: one short blip where it sits
            const y = yv((lo + hi) / 2);
            notes.push({ id: id(), start: t, dur: Math.max(1 / 16, S[S.length - 1].t - t), midi: midiOf(qY(y)), vel, origin: i.origin, pitchY: qY(y), timbre: thick, src: [p.pts[0].x, (lo + hi) / 2], cid: c.id });
          } else if (W < 0.5) {
            const y0 = yv(lo), y1 = yv(hi);
            const m0 = midiOf(y0);
            const dur = Math.max(0.25, (hi - lo) * 2);
            const bend: [number, number][] = sp.quant === 'continuous'
              ? [[0, contP(sp, y0) - m0], [dur * 0.8, contP(sp, y1) - m0]]
              : (() => {
                const cnt = Math.min(12, Math.max(2, Math.round((hi - lo) * sp.pitches.length)));
                return Array.from({ length: cnt }, (_, j): [number, number] => [(dur * 0.8 * j) / (cnt - 1), midiOf(qY(y0 + ((y1 - y0) * j) / (cnt - 1))) - m0]);
              })();
            if (sh.glide) notes.push({ id: id(), start: t, dur, midi: m0, vel, origin: i.origin, pitchY: qY(y0), bend, timbre: thick, src: [p.pts[0].x, lo], cid: c.id });
            else {
              const steps = Math.max(2, Math.min(8, Math.round((hi - lo) * 10)));
              for (let j = 0; j < steps; j++) {
                const yy = yv(lo + ((hi - lo) * j) / (steps - 1));
                notes.push({ id: id(), start: t + j * 0.04, dur: Math.max(0.1, dur - j * 0.04), midi: midiOf(qY(yy)), vel: vel * (1 - j * 0.05), origin: i.origin, pitchY: qY(yy), timbre: thick, src: [p.pts[0].x, lo + ((hi - lo) * j) / (steps - 1)], cid: c.id });
              }
            }
          } else {
            const tones = Math.max(2, Math.min(5, Math.round((hi - lo) * 12)));
            for (let j = 0; j < tones; j++) {
              const yy = yv(lo + ((hi - lo) * j) / (tones - 1));
              notes.push({ id: id(), start: t + j * 0.03, dur: 1, midi: midiOf(qY(yy)), vel: vel * (1 - j * 0.06), origin: i.origin, pitchY: qY(yy), timbre: thick, src: [p.pts[0].x, lo], cid: c.id });
            }
          }
          continue;
        }
        // musical simplification: Douglas–Peucker on (time, pitch)
        let Y = S.map((q) => q.y);
        if (W > 0.05) Y = simplifyTrack(S.map((q) => q.t), Y, (W * 1.2) / Math.max(1, sp.high - sp.low));
        const drafts = segmentNotes(S, Y, sp, { W, minDur, glide: sh.glide, cid: c.id, yv, qY, midiOf });
        for (const d of drafts) {
          const y = yv(d.y);
          const py = qY(y);
          const midi = midiOf(py);
          const len = d.end - d.start;
          const kN = c01(d.k * 6);
          const gate = lerp(lerp(0.96, 0.62, kN), 1.02, W);
          const vel = c01(0.18 + 0.62 * d.s + (d.accent ? 0.12 : 0));
          const n: NoteEvent = {
            id: id(), start: d.start, dur: Math.max(1 / 64, len * gate), midi, vel, origin: i.origin, pitchY: py,
            timbre: thick, src: [d.x, d.ys[0] ?? d.y], cid: c.id,
          };
          // bends are stored relative to the note's own pitch
          if (d.bend) n.bend = d.bend.map(([bt, bp]) => [bt, Math.round((bp - midi) * 1000) / 1000]);
          notes.push(n);
        }
      }
    }
    if (shift) for (let j = first; j < notes.length; j++) {
      const n = notes[j];
      n.stepOffset = (n.stepOffset ?? 0) + shift;
      n.midi = mapY(n.pitchY ?? 0.5, sp.pitches, n.stepOffset);
    }
  }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return shapeVoice(notes, i, sp, { W, F, Q });
}

/** A closed loop traversed in path order, its perimeter spread across its x-extent in time. */
function loopAsPiece(c: Contour): Piece {
  const xs = c.pts.map((p) => p.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  return { pts: [{ x: x0, y: c.pts[0].y }, { x: x1, y: c.pts[0].y }], str: [c.intensity, c.intensity], curv: [0, 0], vertical: x1 - x0 < 0.004 };
}

function loopTraversal(c: Contour, S: Sample[]): Sample[] {
  const dense = catmullRom(c.pts, 0.003, true);
  const t0 = S[0].t, t1 = S[S.length - 1].t;
  return S.map((q, k) => {
    const p = dense[Math.min(dense.length - 1, Math.floor((k / Math.max(1, S.length - 1)) * (dense.length - 1)))];
    return { t: t0 + ((t1 - t0) * k) / Math.max(1, S.length - 1), x: p.x, y: p.y, s: c.intensity, k: q.k };
  });
}

/** Simplify a sampled pitch track with Douglas–Peucker (time units scaled by `tScale`). */
function simplifyTrack(T: number[], Y: number[], tolY: number): number[] {
  const n = T.length;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const st: [number, number][] = [[0, n - 1]];
  while (st.length) {
    const [a, b] = st.pop()!;
    let best = -1, bd = tolY;
    for (let j = a + 1; j < b; j++) {
      const f = (T[j] - T[a]) / Math.max(1e-9, T[b] - T[a]);
      const d = Math.abs(Y[j] - (Y[a] + (Y[b] - Y[a]) * f));
      if (d > bd) { bd = d; best = j; }
    }
    if (best >= 0) { keep[best] = 1; st.push([a, best], [best, b]); }
  }
  const out = Y.slice();
  let a = 0;
  for (let j = 1; j < n; j++) {
    if (!keep[j]) continue;
    for (let m = a + 1; m < j; m++) out[m] = Y[a] + ((Y[j] - Y[a]) * (T[m] - T[a])) / Math.max(1e-9, T[j] - T[a]);
    a = j;
  }
  return out;
}

/** Split a sampled stream into note drafts: silence where the edge fades, new notes where the
 *  quantised pitch changes, sharp bends re-articulate, musical mode adds phrase breathing. */
function segmentNotes(S: Sample[], Y: number[], sp: PitchSpace, o: { W: number; minDur: number; glide: boolean; cid: string; yv: (y: number) => number; qY: (y: number) => number; midiOf: (y: number) => number }): Draft[] {
  const out: Draft[] = [];
  const kSharp = lerp(0.18, 0.4, o.W); // radians per px: articulation threshold
  const phraseMax = lerp(32, 4, o.W);
  const rest = 0.25 * o.W;
  let cur: Draft | null = null;
  let phraseStart = S[0].t;
  let lastDir = 0;
  const quant = (y: number) => o.midiOf(o.qY(o.yv(y)));
  const close = (t: number, breathe = false) => {
    if (!cur) return;
    cur.end = Math.max(cur.start + 1 / 64, t - (breathe ? rest : 0));
    out.push(cur);
    cur = null;
  };
  for (let j = 0; j < S.length; j++) {
    const q = S[j], y = Y[j];
    if (q.s < 0.06) { close(q.t); continue; } // the edge fades: silence
    const m = quant(y);
    const dir = j ? Math.sign(Y[j] - Y[j - 1]) : 0;
    const turning = o.W > 0.4 && dir && lastDir && dir !== lastDir; // melodic turning point
    if (dir) lastDir = dir;
    const sharp = q.k > kSharp;
    const long = q.t - phraseStart > phraseMax;
    if (cur) {
      const c: Draft = cur;
      const dur = q.t - c.start;
      const pitchMoved = !o.glide && m !== quant(c.y);
      if ((long || (turning && dur > 1 && o.W > 0.4)) && dur >= o.minDur) { close(q.t, true); phraseStart = q.t; }
      else if (sharp && dur >= o.minDur) { close(q.t); cur = { start: q.t, end: q.t, y, ys: [q.y], s: q.s, k: q.k, x: q.x, accent: true, cid: o.cid, bend: o.glide ? [] : undefined }; continue; }
      else if (pitchMoved && dur >= o.minDur) close(q.t);
    }
    if (!cur) {
      cur = { start: q.t, end: q.t, y, ys: [q.y], s: q.s, k: q.k, x: q.x, cid: o.cid, bend: o.glide ? [] : undefined };
      if (out.length && q.t - out[out.length - 1].end > 0.5) phraseStart = q.t;
    } else {
      const c: Draft = cur;
      c.s = Math.max(c.s * 0.97, q.s);
      c.k = Math.max(c.k, q.k);
    }
    if (o.glide && cur) {
      const c: Draft = cur;
      const rel = q.t - c.start;
      const p = sp.quant === 'continuous' ? contP(sp, o.yv(y)) : quant(y);
      const last = c.bend![c.bend!.length - 1];
      if (!last || rel - last[0] >= 1 / 16 || Math.abs(p - last[1]) > 0.08) {
        if (sp.quant !== 'continuous' && last && p !== last[1]) c.bend!.push([Math.max(last[0], rel - 1 / 48), last[1]]);
        if (c.bend!.length < 96) c.bend!.push([rel, p]);
      }
    }
  }
  close(S[S.length - 1].t);
  // musical grouping: merge drafts shorter than the grouping length into a neighbour
  if (o.W > 0.15) {
    for (let j = out.length - 1; j > 0; j--) {
      const a = out[j - 1], b = out[j];
      if (b.end - b.start < o.minDur && b.start - a.end < 1 / 16) { a.end = b.end; a.s = Math.max(a.s, b.s); out.splice(j, 1); }
    }
  }
  // glide bends are stored relative to the note's own start pitch later; drop empty bends
  for (const d of out) if (d.bend && d.bend.length < 2) d.bend = undefined;
  return out;
}

/** Structure / fidelity / interpretation transforms that act on finished notes. */
function shapeVoice(notes: NoteEvent[], i: VoiceInput, sp: PitchSpace, o: { W: number; F: number; Q: number }): NoteEvent[] {
  // rhythmic quantisation: pulled toward a grid by structure, softened by fidelity
  const qs = c01((o.Q - 0.3) / 0.5) * (1 - 0.55 * o.F);
  if (qs > 0) {
    const g = o.Q > 0.75 ? 0.5 : 0.25;
    for (const n of notes) {
      const s0 = n.start, e0 = n.start + n.dur;
      const s1 = s0 + (Math.round(s0 / g) * g - s0) * qs;
      const e1 = e0 + (Math.max(s1 + g * 0.5, Math.round(e0 / g) * g) - e0) * qs;
      n.start = Math.max(0, s1);
      n.dur = Math.max(1 / 64, e1 - n.start);
    }
  }
  // octave folding of wild leaps at low fidelity (as scale steps, so key changes still re-pitch)
  if (o.F < 0.4) {
    const per = Math.max(1, sp.pitches.filter((m) => m < sp.pitches[0] + 12).length);
    let prev: number | undefined;
    for (const n of notes) {
      if (prev !== undefined && Math.abs(n.midi - prev) > 12 && !n.bend) {
        const dir = n.midi > prev ? -1 : 1;
        n.stepOffset = (n.stepOffset ?? 0) + dir * per;
        n.midi = mapY(n.pitchY ?? 0.5, sp.pitches, n.stepOffset);
      }
      prev = n.midi;
    }
  }
  // harmonic gravity: long notes lean to the image harmony's chord tones
  if (o.Q >= 0.6 && i.harmony?.length) {
    for (const n of notes) {
      if (n.dur < 1 || n.bend || n.pitchY === undefined) continue;
      const slot = chordAt(i.harmony, n.start);
      if (!slot || slot.chord.pcs.includes(n.midi % 12)) continue;
      for (const off of [1, -1]) {
        const m = mapY(n.pitchY, sp.pitches, (n.stepOffset ?? 0) + off);
        if (slot.chord.pcs.includes(m % 12)) { n.stepOffset = (n.stepOffset ?? 0) + off; n.midi = m; break; }
      }
    }
  }
  // harmonisation (musical interpretation): a diatonic third below long phrase notes
  const h = o.W * (1 - 0.85 * o.F);
  const extra: NoteEvent[] = [];
  if (h > 0.05) {
    for (const n of notes) {
      if (n.dur < 1 || n.pitchY === undefined || !i.rng.chance(Math.min(0.9, h * 1.4))) continue;
      const off = (n.stepOffset ?? 0) - 2;
      extra.push({ ...n, id: `${n.id}h`, midi: mapY(n.pitchY, sp.pitches, off), stepOffset: off, vel: n.vel * 0.6, bend: undefined });
    }
  }
  return [...notes, ...extra].sort((a, b) => a.start - b.start || a.midi - b.midi);
}

// ------------------------------------------------------------------ visual events

export type EventKind = 'start' | 'junction' | 'boundary' | 'extremum' | 'click' | 'grain' | 'accent' | 'pulse';
export interface VisualEvent { x: number; y: number; strength: number; kind: EventKind }

/** Salient visual events for free-time sonification: contour beginnings, junctions, extrema and
 *  abrupt colour / brightness / texture boundaries between columns. Strengths are absolute, so a
 *  featureless image yields nothing. */
export function visualEvents(grid: FeatureGrid, set: ContourSet, density: number, contoursOnly = false): VisualEvent[] {
  const ev: VisualEvent[] = [];
  for (const c of set.contours) {
    const pieces = monotonePieces(c, 1.5 / Math.max(64, set.width));
    const lenF = Math.min(1, c.length / 160);
    for (const p of pieces) {
      ev.push({ x: p.pts[0].x, y: p.pts[0].y, strength: c.intensity * (0.45 + 0.55 * lenF), kind: 'start' });
      // local extrema with prominence
      for (let j = 1; j < p.pts.length - 1; j++) {
        const a = p.pts[j - 1].y, b = p.pts[j].y, d = p.pts[j + 1].y;
        if ((b > a && b > d) || (b < a && b < d)) {
          const prom = Math.min(Math.abs(b - a), Math.abs(b - d));
          if (prom > 0.03) ev.push({ x: p.pts[j].x, y: b, strength: Math.min(1, prom * 6) * c.intensity, kind: 'extremum' });
        }
      }
    }
  }
  for (const j of set.junctions) ev.push({ x: j.x, y: j.y, strength: Math.min(1, 0.4 + 0.15 * j.degree), kind: 'junction' });
  if (contoursOnly) return thinEvents(ev, lerp(0.4, 0.08, c01(density)), lerp(0.03, 0.004, c01(density)));
  // column boundaries
  const C = grid.cols, R = grid.rows;
  const colL = new Float32Array(C), colS = new Float32Array(C), colT = new Float32Array(C), colHx = new Float32Array(C), colHy = new Float32Array(C);
  for (let c = 0; c < C; c++) {
    let L = 0, S = 0, T = 0, HX = 0, HY = 0, N = 0;
    for (let r = 0; r < R; r++) {
      const cell = r * C + c;
      const cnt = grid.count[cell];
      if (!cnt) continue;
      L += grid.lum[cell]; S += grid.sat[cell]; T += grid.grad[cell]; HX += grid.hueX[cell]; HY += grid.hueY[cell]; N += cnt;
    }
    if (!N) continue;
    colL[c] = L / N; colS[c] = S / N; colT[c] = Math.min(1, (T / N) * 6); colHx[c] = HX / N; colHy[c] = HY / N;
  }
  const kw = Math.max(1, Math.round(C / 96));
  const nov = new Float32Array(C);
  for (let c = kw; c < C - kw; c++) {
    let dL = 0, dS = 0, dT = 0, dHx = 0, dHy = 0;
    for (let d = 1; d <= kw; d++) {
      dL += colL[c + d - 1] - colL[c - d]; dS += colS[c + d - 1] - colS[c - d]; dT += colT[c + d - 1] - colT[c - d];
      dHx += colHx[c + d - 1] - colHx[c - d]; dHy += colHy[c + d - 1] - colHy[c - d];
    }
    nov[c] = (Math.abs(dL) * 1.6 + Math.abs(dS) + Math.abs(dT) * 0.8 + Math.hypot(dHx, dHy)) / kw;
  }
  for (let c = kw; c < C - kw; c++) {
    if (nov[c] < 0.08) continue;
    let peak = true;
    for (let d = -kw - 1; d <= kw + 1; d++) if (d && nov[c + d] > nov[c]) { peak = false; break; }
    if (!peak) continue;
    // y = the row where the boundary is sharpest
    let br = 0, bv = -1;
    for (let r = 0; r < R; r++) {
      const a = r * C + c - 1, b = r * C + c;
      const v = Math.abs((grid.lum[b] / Math.max(1, grid.count[b])) - (grid.lum[a] / Math.max(1, grid.count[a])));
      if (v > bv) { bv = v; br = r; }
    }
    ev.push({ x: c / C, y: 1 - (br + 0.5) / R, strength: Math.min(1, nov[c] * 2.5), kind: 'boundary' });
  }
  return thinEvents(ev, lerp(0.55, 0.12, c01(density)), lerp(0.05, 0.006, c01(density)));
}

/** Keep the strongest events above `floor`, at least `gap` apart in x. */
function thinEvents(ev: VisualEvent[], floor: number, gap: number): VisualEvent[] {
  const sorted = ev.filter((e) => e.strength >= floor).sort((a, b) => b.strength - a.strength);
  const kept: VisualEvent[] = [];
  for (const e of sorted) if (kept.every((k) => Math.abs(k.x - e.x) >= gap || Math.abs(k.y - e.y) > 0.25)) kept.push(e);
  return kept.sort((a, b) => a.x - b.x);
}

/** Micro-events for image-derived rhythmic texture: every peak of the column edge profile is an
 *  event candidate; its kind comes from what the image does there (vertical repetition → pulse,
 *  a jump far above the surroundings → accent, crowded peaks → grain, otherwise click). Placement
 *  is the image's own spacing — dense regions cluster, smooth regions stay sparse. */
export function textureEvents(grid: FeatureGrid): VisualEvent[] {
  const E = grid.colEdge, V = grid.colVEdge;
  const w = E.length;
  if (!w) return [];
  const sm = new Float32Array(w);
  for (let x = 0; x < w; x++) sm[x] = (E[Math.max(0, x - 1)] + 2 * E[x] + E[Math.min(w - 1, x + 1)]) / 4;
  const win = Math.max(8, Math.round(w / 40));
  const pre = new Float64Array(w + 1);
  for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + sm[x];
  const local = (x: number) => (pre[Math.min(w, x + win)] - pre[Math.max(0, x - win)]) / (Math.min(w, x + win) - Math.max(0, x - win));
  const peaks: number[] = [];
  for (let x = 1; x < w - 1; x++) {
    const v = sm[x];
    if (v < 0.035 || v < sm[x - 1] || v < sm[x + 1]) continue;
    if (v < local(x) * 1.15) continue;
    if (peaks.length && x - peaks[peaks.length - 1] < 2) continue;
    peaks.push(x);
  }
  const nb = EDGE_BINS.length;
  return peaks.map((x, k) => {
    const v = sm[x];
    const lm = local(x);
    const gc = Math.min(grid.cols - 1, Math.floor((x / w) * grid.cols));
    const vert = E[x] > 0 ? V[x] / E[x] : 0;
    let crowd = 0;
    for (let j = k - 6; j <= k + 6; j++) if (j >= 0 && j < peaks.length && Math.abs(peaks[j] - x) < win) crowd++;
    const kind: EventKind = vert > 0.55 && grid.period[gc] > 0.3 ? 'pulse' : v > lm * 2.2 && v > 0.12 ? 'accent' : crowd >= 9 ? 'grain' : 'click';
    // register: the row with the most edge activity in that column band
    let br = 0, bv = -1;
    for (let r = 0; r < grid.rows; r++) {
      const cell = r * grid.cols + gc;
      const f = grid.count[cell] ? grid.hist[cell * nb + 3] / grid.count[cell] : 0;
      if (f > bv) { bv = f; br = r; }
    }
    return { x: (x + 0.5) / w, y: 1 - (br + 0.5) / grid.rows, strength: Math.min(1, v / 0.35), kind };
  });
}

/** Map events to beats through the scan, thin them to a minimum spacing that density (and the
 *  density mapping) sets, and return them in time order. */
export function timedEvents(ev: VisualEvent[], segs: ScanSeg[], beats: number, minGap: (t01: number) => number): (VisualEvent & { t: number })[] {
  const timed: (VisualEvent & { t: number })[] = [];
  for (const e of ev) {
    for (const s of segs) {
      const lo = Math.min(s.x0, s.x1), hi = Math.max(s.x0, s.x1);
      if (e.x < lo || e.x > hi) continue;
      const t = s.t0 + ((e.x - s.x0) / (s.x1 - s.x0)) * (s.t1 - s.t0);
      if (t >= 0 && t < beats) timed.push({ ...e, t });
    }
  }
  const byStrength = [...timed].sort((a, b) => b.strength - a.strength);
  const kept: typeof timed = [];
  const occupied: number[] = [];
  for (const e of byStrength) {
    const g = minGap(e.t / beats);
    let ok = true;
    for (const t of occupied) if (Math.abs(t - e.t) < g) { ok = false; break; }
    if (ok) { kept.push(e); occupied.push(e.t); }
  }
  return kept.sort((a, b) => a.t - b.t);
}
