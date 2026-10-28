import { useRef } from 'react';
import { engine, projectContext, useStore } from '../../state/store';
import { barBeats } from '../../core/time';
import { allowedPitches, pcName } from '../../theory/scales';
import { chordSymbol } from '../../theory/chords';
import { explain, slotAt } from '../../theory/context';
import { polarFromXY, xyFromPolar } from '../../interpret/orbital';
import { hexA, useStageCanvas } from '../canvas';
import { uid } from '../../core/ids';
import { hash32 } from '../../core/rng';

export function OrbitalView() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const geom = useRef({ cx: 0, cy: 0, R: 1 });
  const drag = useRef<{ x: number; y: number }[] | null>(null);
  const o = project.orbital;
  const active = o.voices.find((v) => v.id === o.active) ?? o.voices[0];

  const { ref, invalidate } = useStageCanvas((ctx, w, h) => {
    const p = useStore.getState().project;
    const ob = p.orbital;
    const av = ob.voices.find((v) => v.id === ob.active) ?? ob.voices[0];
    const tr = p.tracks.find((t) => t.id === av?.trackId);
    const mc = projectContext(p);
    const pos = engine.position();
    const slot = slotAt(mc, pos);
    ctx.fillStyle = '#0f1012';
    ctx.fillRect(0, 0, w, h);
    const R = Math.min(w, h) / 2 - 28;
    const cx = w / 2, cy = h / 2;
    geom.current = { cx, cy, R };
    const P = (a: number, r: number) => { const q = xyFromPolar(a, r); return [cx + (q.x - 0.5) * 2 * R, cy + (q.y - 0.5) * 2 * R] as const; };
    const harmonic = av && (av.pitch === 'guided' || av.pitch === 'chord');
    // pitch rings of the active voice: scale degrees labelled, the current chord's tones glowing
    let pitches: number[] = [];
    if (tr && tr.pitch.mode !== 'drums') {
      pitches = allowedPitches(av.pitch === 'chromatic' ? { ...tr.pitch, mode: 'chromatic' } : tr.pitch, p.settings.key, p.settings.scale, p.settings.customScale);
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      pitches.forEach((m, i) => {
        const r = pitches.length > 1 ? i / (pitches.length - 1) : 0.5;
        const pc = ((m % 12) + 12) % 12;
        const deg = mc.pcs.indexOf(pc);
        const tonic = deg === 0;
        const chordTone = slot.chord.pcs.includes(pc);
        ctx.strokeStyle = harmonic && chordTone ? 'rgba(111,183,214,0.4)' : tonic ? 'rgba(224,164,88,0.35)' : 'rgba(255,255,255,0.05)';
        ctx.lineWidth = harmonic && chordTone ? 1.6 : 1;
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, r * R), 0, Math.PI * 2); ctx.stroke();
        if (pitches.length <= 40 && r * R > 8) {
          ctx.fillStyle = tonic ? '#e0a458' : harmonic && chordTone ? '#8fc9e0' : '#55534f';
          ctx.fillText(tonic ? `1 ${pcName(pc, p.settings.key, p.settings.scale)}` : deg >= 0 ? String(deg + 1) : pcName(pc, p.settings.key, p.settings.scale), cx + 3, cy - r * R - 2);
        }
      });
      ctx.lineWidth = 1;
    }
    // beat spokes of the active voice
    const beatsOf = (bars: number) => bars * barBeats(p.settings.timeSig);
    if (av) {
      const beats = beatsOf(av.bars);
      for (let b = 0; b < beats; b++) {
        const [x, y] = P(b / beats, 1);
        ctx.strokeStyle = b % barBeats(p.settings.timeSig) === 0 ? '#3a3e46' : '#202328';
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      }
    }
    const drawPts = (pts: { x: number; y: number }[], c: string, wdt: number) => {
      ctx.strokeStyle = c; ctx.lineWidth = wdt; ctx.lineCap = 'round';
      if (pts.length === 1) { const [x, y] = P(pts[0].x, pts[0].y); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); return; }
      ctx.beginPath();
      pts.forEach((pt, i) => { const [x, y] = P(pt.x, pt.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    };
    let why = '';
    for (const v of ob.voices) {
      const t = p.tracks.find((x) => x.id === v.trackId);
      const col = t?.color ?? '#e0a458';
      const isActive = v.id === av?.id;
      for (const s of v.strokes) drawPts(s.points, hexA(col, isActive ? 0.9 : 0.35), (isActive ? 1.5 : 1) + s.brush.size);
      if (!t) continue;
      const beats = beatsOf(v.bars);
      const rev = Math.floor(pos / beats);
      const vp = t.pitch.mode === 'drums' ? [] : allowedPitches(v.pitch === 'chromatic' ? { ...t.pitch, mode: 'chromatic' } : t.pitch, p.settings.key, p.settings.scale, p.settings.customScale);
      const rOf = (m: number) => {
        if (!vp.length) return 0.5;
        let bi = 0;
        for (let i = 1; i < vp.length; i++) if (Math.abs(vp[i] - m) < Math.abs(vp[bi] - m)) bi = i;
        return vp.length > 1 ? bi / (vp.length - 1) : 0.5;
      };
      // this revolution's notes (they move between revolutions when the chords change)
      for (const n of t.notes) {
        if (n.origin !== 'orbital' || !n.id.startsWith(`${v.id}_`)) continue;
        const r = Math.floor(n.start / beats + 1e-9);
        if (v.fill && r !== rev) continue;
        const a = (n.start % beats) / beats;
        const [x, y] = P(v.direction === 'cw' ? a : 1 - a, rOf(n.midi));
        const sounding = n.start <= pos && n.start + n.dur > pos;
        ctx.fillStyle = hexA(col, sounding ? 1 : isActive ? 0.6 : 0.3);
        ctx.beginPath(); ctx.arc(x, y, sounding ? 5 : 3, 0, 7); ctx.fill();
        if (sounding && isActive && t.pitch.mode !== 'drums') why = explain(mc, n.midi, n.start);
      }
      // each voice has its own rotating playhead
      const frac = (pos % beats) / beats;
      const [x, y] = P(v.direction === 'cw' ? frac : 1 - frac, 1.04);
      ctx.strokeStyle = isActive ? '#f2c27b' : hexA(col, 0.55);
      ctx.lineWidth = isActive ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    }
    if (drag.current) drawPts(drag.current, tr?.color ?? '#e0a458', 2);
    ctx.lineWidth = 1;
    ctx.fillStyle = '#c9c6bf';
    ctx.font = '11px ui-sans-serif, system-ui';
    ctx.textAlign = 'left';
    const names = (pc: number) => pcName(pc, p.settings.key, p.settings.scale);
    if (av) ctx.fillText(`${ob.voices.length} voice${ob.voices.length === 1 ? '' : 's'} · active: ${tr?.name ?? '?'} · ${av.direction === 'cw' ? '↻' : '↺'} ${av.bars} bars per turn · ${av.pitch}${harmonic ? ` · now ${chordSymbol(slot.chord, names)}` : ''}`, 12, h - 12);
    if (why) { ctx.fillStyle = '#8fc9e0'; ctx.fillText(why, 12, h - 28); }
  }, [project, ui]);

  const toPolar = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const g = geom.current;
    const x = 0.5 + (e.clientX - r.left - g.cx) / (2 * g.R);
    const y = 0.5 + (e.clientY - r.top - g.cy) / (2 * g.R);
    const pol = polarFromXY(x, y);
    return { x: pol.angle, y: pol.radius };
  };

  const updateActive = (fn: (strokes: NonNullable<typeof active>['strokes']) => NonNullable<typeof active>['strokes']) => {
    const st = useStore.getState();
    st.commit((p) => ({ ...p, orbital: { ...p.orbital, voices: p.orbital.voices.map((v) => (v.id === p.orbital.active ? { ...v, strokes: fn(v.strokes) } : v)) } }));
    st.regenerateOrbital();
  };

  const commit = (pts: { x: number; y: number }[]) => {
    const st = useStore.getState();
    const av = st.project.orbital.voices.find((v) => v.id === st.project.orbital.active);
    if (!av) return;
    const id = uid('orb');
    const brush = { ...st.ui.brush, kind: st.ui.brush.kind === 'modulation' ? 'legato' as const : st.ui.brush.kind };
    updateActive((strokes) => [...strokes, { id, trackId: av.trackId, shape: pts.length === 1 ? 'dot' : 'freehand', brush, points: pts, seed: hash32(id) }]);
  };

  return (
    <>
      <canvas ref={ref} role="img" aria-label="Orbital sequencer: angle is time, radius is pitch; rings are scale degrees"
        onPointerDown={(e) => {
          if (!active) return;
          (e.target as Element).setPointerCapture(e.pointerId);
          const pt = toPolar(e);
          if (ui.tool === 'eraser') {
            const hit = active.strokes.find((s) => s.points.some((q) => Math.abs(q.x - pt.x) < 0.02 && Math.abs(q.y - pt.y) < 0.06));
            if (hit) updateActive((strokes) => strokes.filter((s) => s.id !== hit.id));
            return;
          }
          drag.current = [pt];
          invalidate();
        }}
        onPointerMove={(e) => { if (drag.current && ui.tool !== 'dot') { drag.current.push(toPolar(e)); invalidate(); } }}
        onPointerUp={() => { const d = drag.current; drag.current = null; if (d) commit(ui.tool === 'dot' ? d.slice(0, 1) : ui.tool === 'line' ? [d[0], d[d.length - 1]] : d); }} />
      {!o.voices.some((v) => v.strokes.length) && <div className="overlay-msg passive"><div className="card"><h2>Orbital sequencer</h2><p>Draw inside the circle. The playhead sweeps around once every {active?.bars ?? 4} bars: where you draw sets <em>when</em>, distance from the centre sets <em>pitch</em> (rim = high; rings are scale degrees, 1 = tonic). In <b>Guided</b> or <b>Chord</b> pitch the figure follows the shared harmony each time it comes round. Add voices in the inspector to layer orbits.</p></div></div>}
    </>
  );
}
