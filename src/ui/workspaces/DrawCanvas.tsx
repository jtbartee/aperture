import { useEffect, useRef } from 'react';
import { engine, selectedTrack, TOOL_SHAPE, useStore } from '../../state/store';
import type { NoteEvent, Stroke, Track } from '../../core/types';
import { barBeats, projectBeats, TIME_SIGS } from '../../core/time';
import { allowedPitches, DRUM_NAMES, mapY, midiName, yForMidi } from '../../theory/scales';
import { catmullRom, shapePoints } from '../../interpret/strokes';
import { hexA, useStageCanvas } from '../canvas';

const G = 48; // pitch gutter
const RT = 18; // bar ruler
type Pt = { x: number; y: number };

interface Drag {
  kind: 'draw' | 'shape' | 'pan' | 'erase' | 'marquee' | 'move' | 'resize' | 'moveNotes';
  start: Pt; cur: Pt; px0: number; py0: number; x00?: number;
  points?: Pt[]; pressure?: number[];
  origStrokes?: Stroke[]; origNotes?: NoteEvent[]; bbox?: { x0: number; x1: number; y0: number; y1: number };
  lastRow?: number;
}

export function strokeBBox(strokes: Stroke[]) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s.points) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  return { x0, x1, y0, y1 };
}

export function DrawCanvas() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const view = useRef({ x0: 0, ppb: 0 });
  const drag = useRef<Drag | null>(null);
  const curve = useRef<Pt[]>([]);
  const hover = useRef<Pt | null>(null);
  const space = useRef(false);
  const st = useStore.getState();
  const track = selectedTrack({ project, ui }) as Track | undefined;
  const total = projectBeats(project.settings);

  const { ref, size, invalidate } = useStageCanvas((ctx, w, h) => {
    const p = useStore.getState().project;
    const u = useStore.getState().ui;
    const tr = selectedTrack({ project: p, ui: u });
    if (!view.current.ppb) view.current.ppb = Math.max(4, (w - G - 12) / Math.max(1, projectBeats(p.settings)));
    const { x0, ppb } = view.current;
    const H = h - RT;
    const X = (b: number) => G + (b - x0) * ppb;
    const Y = (y: number) => RT + (1 - y) * H;
    ctx.fillStyle = '#101113';
    ctx.fillRect(0, 0, w, h);
    if (!tr) return;
    const pitches = allowedPitches(tr.pitch, p.settings.key, p.settings.scale, p.settings.customScale);
    const n = pitches.length;
    const rowH = H / Math.max(1, n - 1);
    // pitch rows
    for (let i = 0; i < n; i++) {
      const y = Y(n > 1 ? i / (n - 1) : 0.5);
      const tonic = tr.pitch.mode !== 'drums' && ((pitches[i] - p.settings.key) % 12 + 12) % 12 === 0;
      ctx.fillStyle = tonic ? 'rgba(224,164,88,0.07)' : i % 2 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0)';
      ctx.fillRect(G, y - rowH / 2, w - G, rowH);
      if (rowH >= 9 || tonic) {
        ctx.fillStyle = tonic ? '#e0a458' : '#6d6b66';
        ctx.font = '10px ui-monospace, monospace';
        ctx.textBaseline = 'middle';
        const label = tr.pitch.mode === 'drums' ? DRUM_NAMES[pitches[i]] ?? String(pitches[i]) : midiName(pitches[i], p.settings.key, p.settings.scale);
        if (rowH >= 9 || tonic) ctx.fillText(label, 4, y);
      }
    }
    // beat / bar grid
    const bb = barBeats(p.settings.timeSig);
    const pulse = TIME_SIGS[p.settings.timeSig].pulse;
    const q = 1 / Math.max(1, p.settings.quantize);
    const first = Math.floor(x0 / q) * q;
    for (let b = first; X(b) < w; b += q) {
      if (b < 0) continue;
      const isBar = Math.abs(b / bb - Math.round(b / bb)) < 1e-6;
      const isPulse = Math.abs(b / pulse - Math.round(b / pulse)) < 1e-6;
      if (!isBar && !isPulse && q * ppb < 8) continue;
      ctx.strokeStyle = isBar ? '#3a3e46' : isPulse ? '#25282d' : '#1a1c20';
      ctx.beginPath(); ctx.moveTo(Math.round(X(b)) + 0.5, RT); ctx.lineTo(Math.round(X(b)) + 0.5, h); ctx.stroke();
    }
    // ruler
    ctx.fillStyle = '#17181b';
    ctx.fillRect(G, 0, w - G, RT);
    const loop = p.settings.loop;
    if (loop.on) { ctx.fillStyle = 'rgba(111,183,214,0.25)'; ctx.fillRect(X(loop.start), 0, (loop.end - loop.start) * ppb, RT); }
    ctx.fillStyle = '#8b8984';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let bar = Math.max(0, Math.floor(x0 / bb)); X(bar * bb) < w; bar++) ctx.fillText(String(bar + 1), X(bar * bb) + 3, RT / 2);
    // project end
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    if (X(projectBeats(p.settings)) < w) ctx.fillRect(X(projectBeats(p.settings)), RT, w - X(projectBeats(p.settings)), H);
    ctx.fillStyle = '#121316';
    ctx.fillRect(0, 0, G, RT);

    // notes overlay (under strokes so the drawing stays readable)
    if (u.showNotes) {
      for (const t of p.tracks) {
        const mine = t.id === tr.id;
        const tp = t.id === tr.id ? pitches : allowedPitches(t.pitch, p.settings.key, p.settings.scale, p.settings.customScale);
        for (const nt of t.notes) {
          const nx = X(nt.start);
          if (nx > w || nx + nt.dur * ppb < G) continue;
          // other layers are shown in their own vertical frame, faintly
          const yy = Y(nt.pitchY !== undefined && !nt.stepOffset ? nt.pitchY : yForMidi(nt.midi, tp));
          const nh = Math.max(3, Math.min(14, (mine ? rowH : H / Math.max(1, tp.length - 1)) * 0.7));
          ctx.fillStyle = hexA(t.color, mine ? 0.35 + nt.vel * 0.45 : 0.14);
          ctx.fillRect(nx, yy - nh / 2, Math.max(2, nt.dur * ppb - 1), nh);
          if (mine && (nt.origin === 'user' || nt.origin === 'midi')) { ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1; ctx.strokeRect(nx + 0.5, yy - nh / 2 + 0.5, Math.max(2, nt.dur * ppb - 2), nh - 1); }
          if (mine && u.selNotes.includes(nt.id)) { ctx.strokeStyle = '#f2c27b'; ctx.lineWidth = 2; ctx.strokeRect(nx, yy - nh / 2, Math.max(2, nt.dur * ppb - 1), nh); }
        }
      }
    }
    // drawn automation for the selected track
    for (const lane of tr.automation.filter((a) => a.origin === 'drawn')) {
      ctx.strokeStyle = 'rgba(217,207,106,0.75)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      lane.points.forEach((pt, i) => (i ? ctx.lineTo(X(pt.beat), Y(pt.value)) : ctx.moveTo(X(pt.beat), Y(pt.value))));
      ctx.stroke();
      ctx.setLineDash([]);
      if (lane.points[0]) { ctx.fillStyle = '#d9cf6a'; ctx.fillText(`⟿ ${lane.target}`, X(lane.points[0].beat) + 4, Y(lane.points[0].value) - 8); }
    }
    // strokes
    const drawPts = (pts: Pt[], color: string, width: number, closedDot = false) => {
      if (pts.length === 1 || closedDot) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(X(pts[0].x), Y(pts[0].y), Math.max(3, width), 0, Math.PI * 2); ctx.fill();
        return;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((pt, i) => (i ? ctx.lineTo(X(pt.x), Y(pt.y)) : ctx.moveTo(X(pt.x), Y(pt.y))));
      ctx.stroke();
    };
    for (const s of p.strokes) {
      const t = p.tracks.find((x) => x.id === s.trackId);
      if (!t) continue;
      const mine = t.id === tr.id;
      const sel = u.selStrokes.includes(s.id);
      drawPts(s.points, hexA(t.color, mine ? 0.95 : 0.3), 1.2 + s.brush.size * 0.9);
      if (sel) drawPts(s.points, 'rgba(242,194,123,0.45)', 2.5 + s.brush.size * 0.9 + 4);
    }
    if (u.selStrokes.length) {
      const bb2 = strokeBBox(p.strokes.filter((s) => u.selStrokes.includes(s.id)));
      if (Number.isFinite(bb2.x0)) {
        ctx.strokeStyle = '#f2c27b';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        ctx.strokeRect(X(bb2.x0) - 6, Y(bb2.y1) - 6, (bb2.x1 - bb2.x0) * ppb + 12, (bb2.y1 - bb2.y0) * H + 12);
        ctx.setLineDash([]);
        ctx.fillStyle = '#f2c27b';
        ctx.fillRect(X(bb2.x1) + 2, Y(bb2.y0) + 2, 8, 8); // resize handle
      }
    }
    // in-progress gesture
    const d = drag.current;
    const col = tr.color;
    if (d?.kind === 'draw' && d.points) drawPts(d.points, col, 1.2 + u.brush.size * 0.9);
    if (d?.kind === 'shape') {
      const shape = TOOL_SHAPE[u.tool] ?? 'line';
      drawPts(shapePoints(shape, d.start, d.cur), col, 1.2 + u.brush.size * 0.9);
    }
    if (curve.current.length) {
      const pts = hover.current ? [...curve.current, hover.current] : curve.current;
      drawPts(catmullRom(pts), col, 1.2 + u.brush.size * 0.9);
      for (const c of curve.current) { ctx.fillStyle = '#fff'; ctx.fillRect(X(c.x) - 2, Y(c.y) - 2, 4, 4); }
    }
    if (d?.kind === 'marquee') {
      ctx.strokeStyle = '#6fb7d6';
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(X(Math.min(d.start.x, d.cur.x)), Y(Math.max(d.start.y, d.cur.y)), Math.abs(d.cur.x - d.start.x) * ppb, Math.abs(d.cur.y - d.start.y) * H);
      ctx.setLineDash([]);
    }
    // playhead
    const pos = engine.position();
    const px = X(pos);
    if (px >= G && px <= w) {
      ctx.strokeStyle = '#f2c27b';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
    }
    // hover readout
    if (hover.current && !d) {
      const hy = hover.current.y;
      const m = mapY(hy, pitches);
      ctx.fillStyle = 'rgba(15,16,18,0.8)';
      ctx.fillRect(w - 130, h - 22, 126, 18);
      ctx.fillStyle = '#c9c6bf';
      ctx.fillText(`${tr.pitch.mode === 'drums' ? DRUM_NAMES[m] : midiName(m, p.settings.key, p.settings.scale)} · beat ${hover.current.x.toFixed(2)}`, w - 124, h - 13);
    }
  }, [project, ui]);

  useEffect(() => {
    const onEsc = () => { curve.current = []; drag.current = null; invalidate(); };
    const kd = (e: KeyboardEvent) => {
      if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'INPUT') space.current = true;
      if (e.key === 'Enter' && curve.current.length >= 2) finishCurve();
    };
    const ku = (e: KeyboardEvent) => { if (e.key === ' ') space.current = false; };
    window.addEventListener('aperture:escape', onEsc);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('aperture:escape', onEsc); window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, []);

  // keep the view fitted when the project length changes
  useEffect(() => { view.current.ppb = 0; invalidate(); }, [total]);

  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    const H = size.current.h - RT;
    return { x: view.current.x0 + (e.clientX - r.left - G) / view.current.ppb, y: Math.max(0, Math.min(1, 1 - (e.clientY - r.top - RT) / H)) };
  };
  const snap = (b: number) => (useStore.getState().ui.brush.quantize ? Math.round(b * project.settings.quantize) / project.settings.quantize : b);

  const finishCurve = () => {
    const pts = curve.current;
    curve.current = [];
    if (pts.length >= 2 && track) st.addStroke({ trackId: track.id, shape: 'curve', brush: { ...useStore.getState().ui.brush }, points: catmullRom(pts) });
    invalidate();
  };

  const audition = (y: number) => {
    if (!track || engine.state === 'playing' || !engine.ready) return;
    const pitches = allowedPitches(track.pitch, project.settings.key, project.settings.scale, project.settings.customScale);
    const row = Math.round(y * (pitches.length - 1));
    if (drag.current && drag.current.lastRow === row) return;
    if (drag.current) drag.current.lastRow = row;
    void engine.preview(track.id, pitches[row], 0.6, 0.25);
  };

  const hitStroke = (pt: Pt, tol = 8): Stroke | undefined => {
    const H = size.current.h - RT;
    const ppb = view.current.ppb;
    let best: Stroke | undefined;
    let bestD = tol;
    for (const s of useStore.getState().project.strokes) {
      for (let i = 0; i < s.points.length; i++) {
        const a = s.points[i];
        const b = s.points[Math.min(s.points.length - 1, i + 1)];
        // distance to segment in pixels
        const ax = a.x * ppb, ay = a.y * H, bx = b.x * ppb, by = b.y * H, px = pt.x * ppb, py = pt.y * H;
        const dx = bx - ax, dy = by - ay;
        const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
        const dd = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (dd < bestD) { bestD = dd; best = s; }
      }
    }
    return best;
  };

  const hitNote = (pt: Pt): NoteEvent | undefined => {
    if (!track || !useStore.getState().ui.showNotes) return undefined;
    const pitches = allowedPitches(track.pitch, project.settings.key, project.settings.scale, project.settings.customScale);
    const H = size.current.h - RT;
    const rowH = H / Math.max(1, pitches.length - 1);
    const t = useStore.getState().project.tracks.find((x) => x.id === track.id)!;
    return t.notes.find((n) => {
      const ny = n.pitchY !== undefined && !n.stepOffset ? n.pitchY : yForMidi(n.midi, pitches);
      return pt.x >= n.start && pt.x <= n.start + n.dur && Math.abs(ny - pt.y) * H <= Math.max(4, rowH * 0.45);
    });
  };

  const onDown = (e: React.PointerEvent) => {
    if (!track) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const pt = toPt(e);
    const u = useStore.getState().ui;
    const base = { start: pt, cur: pt, px0: e.clientX, py0: e.clientY };
    if (e.button === 1 || u.tool === 'hand' || space.current) { drag.current = { kind: 'pan', ...base, x00: view.current.x0 }; return; }
    if (e.clientY - ref.current!.getBoundingClientRect().top < RT) { engine.seek(Math.max(0, snap(pt.x))); return; }
    switch (u.tool) {
      case 'pencil':
        drag.current = { kind: 'draw', ...base, points: [pt], pressure: [e.pressure || 0.5] };
        audition(pt.y);
        break;
      case 'line': case 'rect': case 'ellipse':
        drag.current = { kind: 'shape', ...base };
        audition(pt.y);
        break;
      case 'dot':
        st.addStroke({ trackId: track.id, shape: 'dot', brush: { ...u.brush }, points: [{ x: Math.max(0, snap(pt.x)), y: pt.y }] });
        audition(pt.y);
        break;
      case 'curve':
        if (e.detail >= 2) { finishCurve(); break; }
        curve.current = [...curve.current, pt];
        audition(pt.y);
        break;
      case 'eraser':
        st.checkpoint();
        drag.current = { kind: 'erase', ...base };
        eraseAt(pt);
        break;
      case 'select': {
        const sel = u.selStrokes;
        const p = useStore.getState().project;
        if (sel.length) {
          const bb = strokeBBox(p.strokes.filter((s) => sel.includes(s.id)));
          const H = size.current.h - RT;
          const hx = G + (bb.x1 - view.current.x0) * view.current.ppb + 6;
          const hy = RT + (1 - bb.y0) * H + 6;
          const r = ref.current!.getBoundingClientRect();
          if (Math.abs(e.clientX - r.left - hx) < 9 && Math.abs(e.clientY - r.top - hy) < 9) {
            st.checkpoint();
            drag.current = { kind: 'resize', ...base, origStrokes: p.strokes.filter((s) => sel.includes(s.id)), bbox: bb };
            break;
          }
        }
        const hit = hitStroke(pt);
        if (hit) {
          const next = e.shiftKey ? (sel.includes(hit.id) ? sel.filter((x) => x !== hit.id) : [...sel, hit.id]) : sel.includes(hit.id) ? sel : [hit.id];
          st.setUi({ selStrokes: next, selNotes: [] });
          st.checkpoint();
          drag.current = { kind: 'move', ...base, origStrokes: p.strokes.filter((s) => next.includes(s.id)) };
          break;
        }
        const note = hitNote(pt);
        if (note) {
          const ids = e.shiftKey ? [...new Set([...u.selNotes, note.id])] : u.selNotes.includes(note.id) ? u.selNotes : [note.id];
          st.setUi({ selNotes: ids, selStrokes: [] });
          st.checkpoint();
          const t = p.tracks.find((x) => x.id === track.id)!;
          drag.current = { kind: 'moveNotes', ...base, origNotes: t.notes.filter((n) => ids.includes(n.id)) };
          break;
        }
        drag.current = { kind: 'marquee', ...base };
        if (!e.shiftKey) st.setUi({ selStrokes: [], selNotes: [] });
        break;
      }
    }
    invalidate();
  };

  const eraseAt = (pt: Pt) => {
    const s = hitStroke(pt, 10);
    if (s) st.deleteStrokes([s.id], false);
    else if (track) {
      const n = hitNote(pt);
      if (n) st.deleteNotes(track.id, [n.id], false);
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const pt = toPt(e);
    hover.current = pt;
    const d = drag.current;
    if (!d) { invalidate(); return; }
    d.cur = pt;
    const ppb = view.current.ppb;
    switch (d.kind) {
      case 'pan':
        view.current.x0 = Math.max(-2, (d.x00 ?? 0) - (e.clientX - d.px0) / ppb);
        break;
      case 'draw': {
        const last = d.points![d.points!.length - 1];
        if (Math.abs(pt.x - last.x) * ppb + Math.abs(pt.y - last.y) * size.current.h > 2) { d.points!.push(pt); d.pressure!.push(e.pressure || 0.5); }
        audition(pt.y);
        break;
      }
      case 'shape': audition(pt.y); break;
      case 'erase': eraseAt(pt); break;
      case 'move': {
        const dx = snap(pt.x - d.start.x);
        const dy = pt.y - d.start.y;
        st.replaceStrokes(d.origStrokes!.map((s) => ({ ...s, points: s.points.map((q) => ({ x: Math.max(0, q.x + dx), y: Math.max(0, Math.min(1, q.y + dy)) })) })), false);
        break;
      }
      case 'resize': {
        const bb = d.bbox!;
        const sx = Math.max(0.05, (pt.x - bb.x0) / Math.max(1e-3, bb.x1 - bb.x0));
        const sy = Math.max(0.05, (bb.y1 - pt.y) / Math.max(1e-3, bb.y1 - bb.y0));
        st.replaceStrokes(d.origStrokes!.map((s) => ({ ...s, points: s.points.map((q) => ({ x: bb.x0 + (q.x - bb.x0) * sx, y: Math.max(0, Math.min(1, bb.y1 - (bb.y1 - q.y) * sy)) })) })), false);
        break;
      }
      case 'moveNotes': {
        if (!track) break;
        const pitches = allowedPitches(track.pitch, project.settings.key, project.settings.scale, project.settings.customScale);
        const dRow = Math.round((pt.y - d.start.y) * (pitches.length - 1));
        const dx = snap(pt.x - d.start.x);
        const orig = new Map(d.origNotes!.map((n) => [n.id, n]));
        st.updateNotes(track.id, [...orig.keys()], (n) => {
          const o = orig.get(n.id)!;
          const idx = Math.max(0, Math.min(pitches.length - 1, Math.round(yForMidi(o.midi, pitches) * (pitches.length - 1)) + dRow));
          return { ...n, start: Math.max(0, o.start + dx), midi: pitches[idx], pitchY: o.pitchY !== undefined ? idx / Math.max(1, pitches.length - 1) : undefined, stepOffset: undefined, degree: undefined };
        }, false);
        break;
      }
    }
    invalidate();
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !track) { invalidate(); return; }
    const u = useStore.getState().ui;
    const brush = { ...u.brush };
    if (d.kind === 'draw' && d.points) {
      if (d.points.length === 1 && Math.abs(e.clientX - d.px0) < 3) {
        st.addStroke({ trackId: track.id, shape: 'dot', brush, points: [{ x: Math.max(0, snap(d.points[0].x)), y: d.points[0].y }] });
      } else {
        // stylus pressure scales the stroke's velocity
        const isPen = e.pointerType === 'pen';
        if (isPen && d.pressure?.length) brush.velocity = Math.max(0.1, Math.min(1, brush.velocity * (0.5 + d.pressure.reduce((a, b) => a + b, 0) / d.pressure.length)));
        st.addStroke({ trackId: track.id, shape: 'freehand', brush, points: d.points.map((q) => ({ x: Math.max(0, q.x), y: q.y })) });
      }
    } else if (d.kind === 'shape') {
      const shape = TOOL_SHAPE[u.tool] ?? 'line';
      if (Math.abs(d.cur.x - d.start.x) > 0.05 || Math.abs(d.cur.y - d.start.y) > 0.02) {
        st.addStroke({ trackId: track.id, shape, brush, points: shapePoints(shape, { x: Math.max(0, d.start.x), y: d.start.y }, { x: Math.max(0, d.cur.x), y: d.cur.y }) });
      }
    } else if (d.kind === 'marquee') {
      const xa = Math.min(d.start.x, d.cur.x), xb = Math.max(d.start.x, d.cur.x);
      const ya = Math.min(d.start.y, d.cur.y), yb = Math.max(d.start.y, d.cur.y);
      const p = useStore.getState().project;
      const strokes = p.strokes.filter((s) => s.points.some((q) => q.x >= xa && q.x <= xb && q.y >= ya && q.y <= yb)).map((s) => s.id);
      let notes: string[] = [];
      if (u.showNotes) {
        const pitches = allowedPitches(track.pitch, p.settings.key, p.settings.scale, p.settings.customScale);
        notes = p.tracks.find((t) => t.id === track.id)!.notes.filter((n) => !n.strokeId && n.start >= xa && n.start <= xb && (n.pitchY ?? yForMidi(n.midi, pitches)) >= ya && (n.pitchY ?? yForMidi(n.midi, pitches)) <= yb).map((n) => n.id);
      }
      st.setUi({ selStrokes: [...new Set([...u.selStrokes, ...strokes])], selNotes: [...new Set([...u.selNotes, ...notes])] });
    }
    invalidate();
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const v = view.current;
    if (e.ctrlKey || e.metaKey) {
      const at = v.x0 + (e.clientX - r.left - G) / v.ppb;
      v.ppb = Math.max(2, Math.min(600, v.ppb * Math.exp(-e.deltaY * 0.01)));
      v.x0 = at - (e.clientX - r.left - G) / v.ppb;
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      v.x0 = Math.max(-2, v.x0 + d / v.ppb);
    }
    invalidate();
  };

  const cursor = ui.tool === 'hand' ? 'grab' : ui.tool === 'select' ? 'default' : ui.tool === 'eraser' ? 'cell' : 'crosshair';
  return (
    <>
      <canvas ref={ref} style={{ cursor }} aria-label={`Drawing canvas. ${track ? `Drawing on ${track.name}` : ''}. Horizontal is time, vertical is pitch.`} role="img"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => { hover.current = null; invalidate(); }}
        onWheel={onWheel} onContextMenu={(e) => e.preventDefault()} />
      {project.strokes.length === 0 && !project.tracks.some((t) => t.notes.length) && (
        <div className="overlay-msg passive"><div className="card">
          <h2>Draw to make music</h2>
          <p>Pick a layer on the left and draw: left→right is time, bottom→top is pitch. Lines rise into melodies, flat strokes sustain, dots become single notes. Press <kbd>Space</kbd> to play.</p>
        </div></div>
      )}
      <div className="hud">{track ? `${track.name} · ${track.patch.name} · ${ui.brush.kind} brush` : ''} · zoom ⌘/ctrl+wheel · pan wheel / H</div>
    </>
  );
}
