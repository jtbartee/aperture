import { engine, getHarmony, useStore } from '../../state/store';
import { projectBeats } from '../../core/time';
import { chordSymbol } from '../../theory/chords';
import { pcName } from '../../theory/scales';
import { STYLES } from '../../interpret/composer';
import { hexA, useStageCanvas } from '../canvas';

const HEAD = 44;
const LABEL = 120;

export function GenerativeView() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const { ref } = useStageCanvas((ctx, w, h) => {
    const p = useStore.getState().project;
    const total = Math.max(1, projectBeats(p.settings));
    const X = (b: number) => LABEL + (b / total) * (w - LABEL - 8);
    ctx.fillStyle = '#0f1012';
    ctx.fillRect(0, 0, w, h);
    // sections
    const ms = [...p.markers].sort((a, b) => a.beat - b.beat);
    ms.forEach((m, i) => {
      const end = ms[i + 1]?.beat ?? total;
      ctx.fillStyle = i % 2 ? '#1b1d21' : '#202228';
      ctx.fillRect(X(m.beat), 0, X(end) - X(m.beat), 20);
      ctx.fillStyle = '#c9c6bf';
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.fillText(m.label, X(m.beat) + 5, 14);
      ctx.strokeStyle = '#3a3e46';
      ctx.beginPath(); ctx.moveTo(X(m.beat) + 0.5, 0); ctx.lineTo(X(m.beat) + 0.5, h); ctx.stroke();
    });
    // chord lane
    const harmony = getHarmony();
    if (harmony) {
      ctx.font = '10px ui-monospace, monospace';
      for (const slot of harmony) {
        if (slot.start >= total) continue;
        ctx.fillStyle = '#16171a';
        ctx.fillRect(X(slot.start) + 1, 22, X(slot.start + slot.dur) - X(slot.start) - 2, 18);
        ctx.fillStyle = '#e0a458';
        if (X(slot.start + slot.dur) - X(slot.start) > 26) ctx.fillText(chordSymbol(slot.chord, (pc) => pcName(pc, p.settings.key, p.settings.scale)), X(slot.start) + 4, 35);
      }
    }
    // lanes
    const tracks = p.tracks.filter((t) => t.notes.length || t.generator);
    const laneH = Math.max(18, (h - HEAD - 4) / Math.max(1, tracks.length));
    tracks.forEach((t, i) => {
      const y0 = HEAD + i * laneH;
      ctx.fillStyle = i % 2 ? '#131417' : '#111215';
      ctx.fillRect(0, y0, w, laneH);
      ctx.fillStyle = t.mix.mute ? '#55534f' : '#c9c6bf';
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.fillText(t.name.slice(0, 16), 8, y0 + 14);
      ctx.fillStyle = '#6d6b66';
      ctx.font = '10px ui-sans-serif, system-ui';
      if (laneH > 30) ctx.fillText(t.patch.name.slice(0, 18), 8, y0 + 27);
      let lo = 127, hi = 0;
      for (const n of t.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
      const span = Math.max(6, hi - lo);
      ctx.fillStyle = hexA(t.color, t.mix.mute ? 0.2 : 0.85);
      for (const n of t.notes) {
        const y = y0 + 3 + (1 - (n.midi - lo) / span) * (laneH - 8);
        ctx.fillRect(X(n.start), y, Math.max(1.5, X(n.start + n.dur) - X(n.start)), 2.5);
      }
      for (const lane of t.automation) {
        ctx.strokeStyle = 'rgba(217,207,106,0.35)';
        ctx.beginPath();
        lane.points.forEach((pt, k) => { const yy = y0 + laneH - 2 - pt.value * (laneH - 6); if (k) ctx.lineTo(X(pt.beat), yy); else ctx.moveTo(X(pt.beat), yy); });
        ctx.stroke();
      }
    });
    const loop = p.settings.loop;
    if (loop.on) { ctx.fillStyle = 'rgba(111,183,214,0.08)'; ctx.fillRect(X(loop.start), HEAD, X(loop.end) - X(loop.start), h - HEAD); }
    const px = X(engine.position());
    ctx.strokeStyle = '#f2c27b';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }, [project, ui]);

  const gen = project.tracks.filter((t) => t.generator?.startsWith('gen:'));
  return (
    <>
      <canvas ref={ref} role="img" aria-label="Arrangement overview: sections, chords and every layer's notes"
        onPointerDown={(e) => {
          const r = ref.current!.getBoundingClientRect();
          const total = projectBeats(useStore.getState().project.settings);
          const f = (e.clientX - r.left - LABEL) / (r.width - LABEL - 8);
          if (f >= 0 && f <= 1) engine.seek(f * total);
        }} />
      {!gen.length && (
        <div className="overlay-msg"><div className="card">
          <h2>Generative composition</h2>
          <p>Choose a style in the inspector — {Object.values(STYLES).map((s) => s.label).join(', ')} — and press Generate. Optionally let your drawing, image or panorama guide the density, contour and harmony.</p>
          <div className="btnrow" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => useStore.getState().generateComposition(undefined, true)}>Generate “{STYLES[project.composition.style].label}”</button>
          </div>
        </div></div>
      )}
      <div className="hud">{STYLES[project.composition.style].label} · seed {project.composition.seed} · {project.composition.bars} bars · {gen.length} generated layers · click to seek</div>
    </>
  );
}
