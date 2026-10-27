import { useRef, useState } from 'react';
import { engine, useStore } from '../../state/store';
import { getAnalysis, getLevels } from '../../analysis/client';
import { barBeats } from '../../core/time';
import { allowedPitches, yForMidi } from '../../theory/scales';
import { EDGE_BINS } from '../../analysis/features';
import { hexA, useStageCanvas } from '../canvas';
import { Progress } from '../components/controls';
import { loadProceduralImage } from '../../state/factory';

export function ImageView() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const [layers, setLayers] = useState({ contours: true, notes: true, heat: false });
  const fileRef = useRef<HTMLInputElement>(null);
  const geom = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const img = project.image;
  const job = ui.analysis.image;

  const { ref } = useStageCanvas((ctx, w, h) => {
    const p = useStore.getState().project;
    ctx.fillStyle = '#0f1012';
    ctx.fillRect(0, 0, w, h);
    if (!p.image) return;
    const lv = getLevels(p.image.asset.assetId);
    const a = getAnalysis(p.image.asset.assetId);
    const iw = p.image.asset.width, ih = p.image.asset.height;
    const s = Math.min((w - 24) / iw, (h - 24) / ih);
    const dw = iw * s, dh = ih * s;
    const x0 = (w - dw) / 2, y0 = (h - dh) / 2;
    geom.current = { x: x0, y: y0, w: dw, h: dh };
    if (lv) ctx.drawImage(lv.display, x0, y0, dw, dh);
    else { ctx.fillStyle = '#1a1c20'; ctx.fillRect(x0, y0, dw, dh); }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x0, y0, dw, dh);
    if (a && layers.heat) {
      const g = a.grid;
      const thr = 3;
      for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
        const cell = r * g.cols + c;
        const v = g.count[cell] ? g.hist[cell * EDGE_BINS.length + thr] / g.count[cell] : 0;
        ctx.fillStyle = `rgba(224,122,106,${Math.min(0.7, v * 2.2)})`;
        ctx.fillRect(x0 + (c / g.cols) * dw, y0 + (r / g.rows) * dh, dw / g.cols + 0.5, dh / g.rows + 0.5);
      }
    }
    if (a && layers.contours) {
      ctx.lineWidth = 1.6;
      a.gestures.forEach((gst, i) => {
        ctx.strokeStyle = i < Math.ceil(a.gestures.length * 0.4) ? 'rgba(224,164,88,0.9)' : 'rgba(154,208,201,0.75)';
        ctx.beginPath();
        gst.points.forEach((pt, k) => { const X = x0 + pt.x * dw, Y = y0 + (1 - pt.y) * dh; if (k) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
        ctx.stroke();
      });
    }
    const beats = p.image.settings.bars * barBeats(p.settings.timeSig);
    if (layers.notes) {
      for (const t of p.tracks) {
        if (!t.generator?.startsWith('image:') && !t.notes.some((n) => n.origin === 'image')) continue;
        const pitches = allowedPitches(t.pitch, p.settings.key, p.settings.scale, p.settings.customScale);
        for (const n of t.notes) {
          if (n.start > beats) continue;
          const y = n.pitchY ?? yForMidi(n.midi, pitches);
          const X = x0 + (n.start / beats) * dw;
          const Y = y0 + (1 - y) * dh;
          ctx.fillStyle = hexA(t.color, n.origin === 'user' ? 1 : 0.85);
          ctx.fillRect(X, Y - 2, Math.max(2, (n.dur / beats) * dw), 4);
          if (n.origin === 'user') { ctx.strokeStyle = '#fff'; ctx.strokeRect(X - 0.5, Y - 2.5, Math.max(2, (n.dur / beats) * dw) + 1, 5); }
        }
      }
    }
    const pos = engine.position();
    if (pos <= beats) {
      const X = x0 + (pos / beats) * dw;
      ctx.strokeStyle = '#f2c27b';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X, y0); ctx.lineTo(X, y0 + dh); ctx.stroke();
    }
  }, [project, ui, layers]);

  const onDown = (e: React.PointerEvent) => {
    const p = useStore.getState().project;
    if (!p.image) return;
    const r = ref.current!.getBoundingClientRect();
    const g = geom.current;
    const fx = (e.clientX - r.left - g.x) / g.w;
    const fy = 1 - (e.clientY - r.top - g.y) / g.h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
    const beats = p.image.settings.bars * barBeats(p.settings.timeSig);
    if (e.altKey) {
      // alt-click deletes the image-derived note under the cursor
      for (const t of p.tracks) {
        const pitches = allowedPitches(t.pitch, p.settings.key, p.settings.scale, p.settings.customScale);
        const hit = t.notes.find((n) => Math.abs((n.pitchY ?? yForMidi(n.midi, pitches)) - fy) * g.h < 5 && fx * beats >= n.start - 0.1 && fx * beats <= n.start + n.dur);
        if (hit) { useStore.getState().deleteNotes(t.id, [hit.id]); useStore.getState().setUi({ selectedTrackId: t.id }); return; }
      }
      return;
    }
    engine.seek(fx * beats);
  };

  if (!img) {
    return (
      <div className="overlay-msg"><div className="card">
        <h2>Turn a photograph into a score</h2>
        <p>Import a JPG, PNG, WebP or GIF (first frame). APERTURE analyses it in your browser — edges and contours, colour, brightness, texture — and builds editable musical layers from what it measures.</p>
        <div className="btnrow" style={{ justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => fileRef.current?.click()}>Import image…</button>
          <button className="btn" onClick={() => void loadProceduralImage('haze')}>Try a generated haze</button>
          <button className="btn" onClick={() => void loadProceduralImage('texture')}>Try a textured abstract</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void useStore.getState().importImage(f, f.name, 'image'); e.target.value = ''; }} />
        {job.status === 'error' && <p className="note err">{job.error}</p>}
      </div></div>
    );
  }
  return (
    <>
      <canvas ref={ref} onPointerDown={onDown} role="img" aria-label={`Image ${img.asset.name} with analysis overlays. Click to seek; Alt-click a note to delete it.`} />
      <div className="hud">{img.asset.name} · {img.asset.width}×{img.asset.height} · {img.settings.bars} bars · click = seek · alt-click note = delete</div>
      <div className="hud hud-r" style={{ pointerEvents: 'auto', display: 'flex', gap: 8 }}>
        {(['contours', 'notes', 'heat'] as const).map((k) => (
          <label key={k} className="check"><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />{k === 'heat' ? 'edge density' : k}</label>
        ))}
      </div>
      {job.status === 'running' && (
        <div className="overlay-msg"><div className="card" style={{ minWidth: 320 }}>
          <p>{job.label}</p><Progress value={job.progress} />
          <div className="btnrow" style={{ justifyContent: 'center' }}><button className="btn small" onClick={() => useStore.getState().cancelAnalysis('image')}>Cancel</button></div>
        </div></div>
      )}
    </>
  );
}
