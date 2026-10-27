import { useMemo, useRef } from 'react';
import { engine, useStore } from '../../state/store';
import { simulateParticles } from '../../interpret/particles';
import { hexA, useStageCanvas } from '../canvas';
import { uid } from '../../core/ids';
import { barBeats } from '../../core/time';

export function ParticleView() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const geom = useRef({ x: 0, y: 0, s: 1 });
  const drag = useRef<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const sim = useMemo(() => simulateParticles(project.particles, project.tracks, project.settings), [project.particles, project.tracks, project.settings]);

  const { ref, invalidate } = useStageCanvas((ctx, w, h) => {
    const p = useStore.getState().project;
    ctx.fillStyle = '#0f1012';
    ctx.fillRect(0, 0, w, h);
    const s = Math.min(w, h) - 30;
    const x0 = (w - s) / 2, y0 = (h - s) / 2;
    geom.current = { x: x0, y: y0, s };
    ctx.strokeStyle = '#3a3e46';
    ctx.strokeRect(x0, y0, s, s);
    for (const z of p.particles.zones) {
      const t = p.tracks.find((tr) => tr.id === z.trackId);
      ctx.fillStyle = hexA(t?.color ?? '#888', 0.22);
      ctx.strokeStyle = hexA(t?.color ?? '#888', 0.8);
      ctx.fillRect(x0 + z.x * s, y0 + z.y * s, z.w * s, z.h * s);
      ctx.strokeRect(x0 + z.x * s, y0 + z.y * s, z.w * s, z.h * s);
      ctx.fillStyle = '#c9c6bf';
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.fillText(t?.name ?? '?', x0 + z.x * s + 4, y0 + z.y * s + 13);
    }
    if (drag.current) {
      const { a, b } = drag.current;
      ctx.strokeStyle = '#f2c27b';
      ctx.strokeRect(x0 + Math.min(a.x, b.x) * s, y0 + Math.min(a.y, b.y) * s, Math.abs(b.x - a.x) * s, Math.abs(b.y - a.y) * s);
    }
    // replay the recorded deterministic simulation at the transport position
    const beats = p.particles.bars * barBeats(p.settings.timeSig);
    const pos = engine.position() % Math.max(1, beats);
    const f = Math.min(Math.floor(pos / sim.frameBeats), sim.frames.length / (sim.count * 2) - 1);
    for (let i = 0; i < sim.count; i++) {
      const px = sim.frames[(f * sim.count + i) * 2], py = sim.frames[(f * sim.count + i) * 2 + 1];
      ctx.fillStyle = '#e4e1da';
      ctx.beginPath(); ctx.arc(x0 + px * s, y0 + py * s, 4, 0, 7); ctx.fill();
    }
  }, [project, ui, sim]);

  const toN = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const g = geom.current;
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left - g.x) / g.s)), y: Math.max(0, Math.min(1, (e.clientY - r.top - g.y) / g.s)) };
  };
  return (
    <>
      <canvas ref={ref} role="img" aria-label="Particle sequencer. Drag to draw a zone for the selected layer; Alt-click a zone to delete it."
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          const pt = toN(e);
          const st = useStore.getState();
          if (e.altKey) {
            const z = st.project.particles.zones.find((q) => pt.x >= q.x && pt.x <= q.x + q.w && pt.y >= q.y && pt.y <= q.y + q.h);
            if (z) { st.commit((p) => ({ ...p, particles: { ...p.particles, zones: p.particles.zones.filter((q) => q.id !== z.id) } })); st.regenerateParticles(); }
            return;
          }
          drag.current = { a: pt, b: pt };
        }}
        onPointerMove={(e) => { if (drag.current) { drag.current.b = toN(e); invalidate(); } }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          const w = Math.abs(d.b.x - d.a.x), h = Math.abs(d.b.y - d.a.y);
          if (w < 0.02 || h < 0.02) { invalidate(); return; }
          const st = useStore.getState();
          st.commit((p) => ({ ...p, particles: { ...p.particles, zones: [...p.particles.zones, { id: uid('zone'), x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w, h, trackId: st.ui.selectedTrackId }] } }));
          st.regenerateParticles();
        }} />
      {!project.particles.zones.length && <div className="overlay-msg passive"><div className="card"><h2>Particle sequencer</h2><p>Drag rectangles to create musical zones for the selected layer. Particles bounce deterministically (seeded); each time one enters a zone it plays a note — its height inside the zone sets the pitch, its speed the velocity.</p></div></div>}
      <div className="hud">{sim.count} particles · seed {project.particles.seed} · {project.particles.zones.length} zones · alt-click a zone to delete</div>
    </>
  );
}
