import { useRef, useState } from 'react';
import { engine, useStore } from '../../state/store';
import { getAnalysis, getLevels } from '../../analysis/client';
import { displayBeats, panoramaSeconds, regionYRange, scanPoint, timeForX, viewportOffset } from '../../interpret/panorama';
import { fullMask, regionCurve } from '../../analysis/features';
import { allowedPitches, yForMidi } from '../../theory/scales';
import type { Region } from '../../core/types';
import { hexA, useStageCanvas } from '../canvas';
import { drawContours } from '../contourDraw';
import { laneValue, cutoffFromNorm } from '../../audio/graph';
import { unit } from '../../audio/imageSynth';
import { Progress } from '../components/controls';
import { loadFactory } from '../../state/factory';

const OV = 56; // overview strip height
const MASK_COLS = 128, MASK_ROWS = 32;
const ROLE_COLOR: Record<string, string> = { pad: '#b48ee0', melody: '#e0a458', bass: '#6a8de0', drone: '#8fa3b8', percussion: '#e07a6a', texture: '#9ad0c9', arp: '#7fcf9a', chords: '#d9cf6a' };

function maskFromRegion(r: Region): Uint8Array {
  const m = new Uint8Array(MASK_COLS * MASK_ROWS);
  if (r.mask) {
    for (let row = 0; row < MASK_ROWS; row++) for (let c = 0; c < MASK_COLS; c++) {
      const mr = Math.floor((row / MASK_ROWS) * r.mask.rows), mc = Math.floor((c / MASK_COLS) * r.mask.cols);
      m[row * MASK_COLS + c] = r.mask.bits.charCodeAt(mr * r.mask.cols + mc) === 49 ? 1 : 0;
    }
  }
  return m;
}
const bits = (m: Uint8Array) => Array.from(m, (v) => (v ? '1' : '0')).join('');

export function PanoramaView() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const pano = project.panorama;
  const job = ui.analysis.panorama;
  const fileRef = useRef<HTMLInputElement>(null);
  const zoom = useRef(1);
  const [showContours, setShowContours] = useState(true);
  const geom = useRef({ dw: 0, dh: 0, off: 0, top: OV + 6, w: 0 });
  const drag = useRef<null | { kind: 'scrub' | 'paint' | 'lasso' | 'path' | 'overview'; x0: number; pos0: number; mask?: Uint8Array; pts: { x: number; y: number }[] }>(null);

  const { ref, invalidate } = useStageCanvas((ctx, w, h) => {
    const p = useStore.getState().project;
    const u = useStore.getState().ui;
    ctx.fillStyle = '#0f1012';
    ctx.fillRect(0, 0, w, h);
    if (!p.panorama) return;
    const src = p.panorama;
    const lv = getLevels(src.asset.assetId);
    const beats = displayBeats(src.settings, p.settings);
    const t = Math.max(0, Math.min(1, engine.position() / beats));
    const at = scanPoint(t, src.settings);
    const top = OV + 6;
    const vh = h - top;
    const aspect = src.asset.width / src.asset.height;
    const dh = vh * zoom.current;
    const dw = dh * aspect;
    const off = viewportOffset(at.x, dw, w, 0.5);
    const imgTop = top + (vh - dh) / 2;
    geom.current = { dw, dh, off, top: imgTop, w };
    // overview strip
    if (lv) ctx.drawImage(lv.overview, 0, 0, w, OV);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, OV);
    if (src.settings.direction === 'region') { ctx.fillStyle = 'rgba(111,183,214,0.25)'; ctx.fillRect(src.settings.region.x0 * w, 0, (src.settings.region.x1 - src.settings.region.x0) * w, OV); }
    const loop = p.settings.loop;
    if (loop.on && (src.settings.direction === 'ltr' || src.settings.direction === 'region')) {
      const a = scanPoint(loop.start / beats, src.settings).x, b = scanPoint(Math.min(1, loop.end / beats), src.settings).x;
      ctx.strokeStyle = '#6fb7d6'; ctx.strokeRect(a * w, 1, (b - a) * w, OV - 2);
    }
    ctx.strokeStyle = '#f2c27b';
    ctx.lineWidth = 1.5;
    ctx.strokeRect((off / dw) * w, 1, (w / dw) * w, OV - 2);
    // main viewport
    ctx.save();
    ctx.beginPath(); ctx.rect(0, top, w, vh); ctx.clip();
    if (lv) ctx.drawImage(lv.display, -off, imgTop, dw, dh);
    const X = (x: number) => x * dw - off;
    const Yimg = (y: number) => imgTop + y * dh; // y: 0 = top of image
    // regions (only when the classic region roles are in use, or while painting one)
    for (const r of src.regions) {
      if (!r.enabled || (!src.settings.layers?.regions && u.paintRegionId !== r.id)) continue;
      const col = ROLE_COLOR[r.role] ?? '#fff';
      if (r.mask) {
        ctx.fillStyle = hexA(col, u.paintRegionId === r.id ? 0.35 : 0.16);
        for (let row = 0; row < r.mask.rows; row++) for (let c = 0; c < r.mask.cols; c++) {
          if (r.mask.bits[row * r.mask.cols + c] !== '1') continue;
          const x = X(c / r.mask.cols);
          if (x > w || x + dw / r.mask.cols < 0) continue;
          ctx.fillRect(x, Yimg(row / r.mask.rows), dw / r.mask.cols + 0.5, dh / r.mask.rows + 0.5);
        }
      } else if (r.band) {
        ctx.strokeStyle = hexA(col, 0.7);
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(-2, Yimg(r.band.y0) + 1, w + 4, (r.band.y1 - r.band.y0) * dh - 2);
        ctx.setLineDash([]);
      }
    }
    // custom path
    if (src.settings.path.length > 1) {
      ctx.strokeStyle = 'rgba(127,207,154,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      src.settings.path.forEach((pt, i) => (i ? ctx.lineTo(X(pt.x), Yimg(1 - pt.y)) : ctx.moveTo(X(pt.x), Yimg(1 - pt.y))));
      ctx.stroke();
    }
    // contours under the scan, sounding ones bold
    const pos = engine.position();
    const active = new Set<string>();
    const voiced = new Set<string>();
    let sounding = 0;
    for (const tr of p.tracks) {
      if (!tr.generator?.startsWith('pano:') || tr.mix.mute) continue;
      for (const n of tr.notes) {
        if (n.cid) voiced.add(n.cid);
        if (n.start <= pos && n.start + n.dur > pos) { sounding++; if (n.cid) active.add(n.cid); }
      }
    }
    const an = getAnalysis(src.asset.assetId);
    if (an && showContours) drawContours(ctx, an.contours, { X, Y: (y) => Yimg(1 - y), sx: dw, sy: dh, active, voiced, junctions: false, clip: [-20, w + 20], alpha: 0.75 });
    // notes overlay: contour notes sit at the image point they were read from; region notes inside
    // the region's vertical extent — all through the same scan mapping as the view
    for (const tr of p.tracks) {
      if (!tr.generator?.startsWith('pano:')) continue;
      const reg = src.regions.find((r) => `pano:${r.id}` === tr.generator);
      const [lo, hi] = reg ? regionYRange(reg) : [0, 1];
      const pitches = allowedPitches(tr.pitch, p.settings.key, p.settings.scale, p.settings.customScale);
      ctx.fillStyle = hexA(tr.color, tr.mix.mute ? 0.25 : 0.8);
      for (const n of tr.notes) {
        const nx = X(scanPoint(n.start / beats, src.settings).x);
        if (nx < -50 || nx > w + 50) continue;
        const wpx = Math.max(2, (n.dur / beats) * dw * (src.settings.direction === 'pingpong' ? 2 : 1));
        const yy = n.src ? Yimg(1 - n.src[1]) : Yimg(1 - (lo + (n.pitchY ?? yForMidi(n.midi, pitches)) * (hi - lo)));
        ctx.fillRect(src.settings.direction === 'rtl' ? nx - wpx : nx, yy - 1.5, wpx, 3);
      }
    }
    // in-progress lasso / path
    const d = drag.current;
    if (d && (d.kind === 'lasso' || d.kind === 'path') && d.pts.length > 1) {
      ctx.strokeStyle = d.kind === 'lasso' ? '#f2c27b' : '#7fcf9a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      d.pts.forEach((pt, i) => (i ? ctx.lineTo(X(pt.x), Yimg(1 - pt.y)) : ctx.moveTo(X(pt.x), Yimg(1 - pt.y))));
      ctx.stroke();
    }
    if (d?.kind === 'paint' && d.mask) {
      const r = src.regions.find((x) => x.id === u.paintRegionId);
      ctx.fillStyle = hexA(ROLE_COLOR[r?.role ?? 'pad'], 0.4);
      for (let row = 0; row < MASK_ROWS; row++) for (let c = 0; c < MASK_COLS; c++) if (d.mask[row * MASK_COLS + c]) ctx.fillRect(X(c / MASK_COLS), Yimg(row / MASK_ROWS), dw / MASK_COLS + 0.5, dh / MASK_ROWS + 0.5);
    }
    // analysed strip + fixed playhead
    const stripPx = Math.max(3, (dw / Math.max(16, src.settings.scanResolution)) * (1 + 2 * src.settings.stripWidth));
    ctx.fillStyle = 'rgba(242,194,123,0.12)';
    ctx.fillRect(w / 2 - stripPx / 2, top, stripPx, vh);
    if (at.y !== undefined) { ctx.fillStyle = '#7fcf9a'; ctx.beginPath(); ctx.arc(w / 2, Yimg(1 - at.y), 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    ctx.strokeStyle = '#f2c27b';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(w / 2, top - 4); ctx.lineTo(w / 2, h); ctx.stroke();
    // live readout of the scanned features and the timbre they are producing
    const a = an;
    if (a && src.settings.readout) {
      const cv = regionCurve(a.grid, fullMask, { steps: 2, sensitivity: src.settings.sensitivity, strip: src.settings.stripWidth, smoothing: 0, path: [{ x: at.x }, { x: at.x }] });
      const fmt = (v: number) => v.toFixed(2);
      const lines = [`x ${at.x.toFixed(3)} · light ${fmt(cv.brightness[0])} · sat ${fmt(cv.saturation[0])} · edges ${fmt(cv.edges[0])} · texture ${fmt(cv.texture[0])} · period ${fmt(cv.periodicity[0])} · vertical ${fmt(cv.orientation[0])}`];
      const synthTrack = p.tracks.find((t) => t.generator?.startsWith('pano:') && t.patch.engine === 'image' && !t.mix.mute);
      if (synthTrack) {
        const lv = (target: string) => { const l = synthTrack.automation.find((x) => x.target === target); return l ? laneValue(l, pos) : null; };
        const c = lv('cutoff'), m = lv('morph'), f = lv('fmDepth'), r = lv('lfoRate');
        lines.push(`${synthTrack.name}: cutoff ${c === null ? '—' : `${Math.round(cutoffFromNorm(c))} Hz`} · morph ${m === null ? '—' : fmt(m)} · FM ${f === null ? '—' : fmt(unit.fmDepth(f))} · LFO ${r === null ? '—' : `${unit.lfoRate(r).toFixed(2)} Hz`} · ${sounding} notes sounding · ${active.size} contours`);
      }
      ctx.font = '11px ui-monospace, monospace';
      lines.forEach((txt, i) => {
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(15,16,18,0.82)';
        ctx.fillRect(w / 2 - tw / 2 - 6, top + 4 + i * 19, tw + 12, 18);
        ctx.fillStyle = '#e4e1da';
        ctx.fillText(txt, w / 2 - tw / 2, top + 17 + i * 19);
      });
    }
  }, [project, ui, showContours]);

  const imgCoord = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const g = geom.current;
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left + g.off) / g.dw)), y: Math.max(0, Math.min(1, 1 - (e.clientY - r.top - g.top) / g.dh)) };
  };

  const paintAt = (m: Uint8Array, pt: { x: number; y: number }, value: number) => {
    const c = Math.floor(pt.x * MASK_COLS), r = Math.floor((1 - pt.y) * MASK_ROWS);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -2; dc <= 2; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < MASK_ROWS && cc >= 0 && cc < MASK_COLS) m[rr * MASK_COLS + cc] = value;
    }
  };

  const onDown = (e: React.PointerEvent) => {
    const p = useStore.getState().project;
    if (!p.panorama) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const r = ref.current!.getBoundingClientRect();
    const beats = displayBeats(p.panorama.settings, p.settings);
    if (e.clientY - r.top < OV) {
      engine.seek(timeForX((e.clientX - r.left) / r.width, p.panorama.settings) * beats);
      drag.current = { kind: 'overview', x0: e.clientX, pos0: 0, pts: [] };
      return;
    }
    const tool = useStore.getState().ui.panoTool;
    const pt = imgCoord(e);
    if (tool === 'scrub') drag.current = { kind: 'scrub', x0: e.clientX, pos0: engine.position(), pts: [] };
    else if (tool === 'paint' || tool === 'erase') {
      const reg = p.panorama.regions.find((x) => x.id === useStore.getState().ui.paintRegionId);
      if (!reg) { useStore.getState().toast('Choose a region to paint in the inspector (Source → Regions).', 'info'); return; }
      const m = maskFromRegion(reg);
      paintAt(m, pt, tool === 'paint' ? 1 : 0);
      drag.current = { kind: 'paint', x0: 0, pos0: 0, mask: m, pts: [] };
    } else drag.current = { kind: tool === 'lasso' ? 'lasso' : 'path', x0: 0, pos0: 0, pts: [pt] };
    invalidate();
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = useStore.getState().project;
    if (!d || !p.panorama) return;
    const beats = displayBeats(p.panorama.settings, p.settings);
    if (d.kind === 'overview') {
      const r = ref.current!.getBoundingClientRect();
      engine.seek(timeForX((e.clientX - r.left) / r.width, p.panorama.settings) * beats);
    } else if (d.kind === 'scrub') {
      const dx = (e.clientX - d.x0) / geom.current.dw;
      const x = scanPoint(d.pos0 / beats, p.panorama.settings).x - dx;
      engine.seek(timeForX(x, p.panorama.settings) * beats);
    } else if (d.kind === 'paint') paintAt(d.mask!, imgCoord(e), useStore.getState().ui.panoTool === 'paint' ? 1 : 0);
    else d.pts.push(imgCoord(e));
    invalidate();
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    const st = useStore.getState();
    const p = st.project;
    if (!d || !p.panorama) return;
    if (d.kind === 'paint' && d.mask) {
      st.setRegions(p.panorama.regions.map((r) => (r.id === st.ui.paintRegionId ? { ...r, band: undefined, mask: { cols: MASK_COLS, rows: MASK_ROWS, bits: bits(d.mask!) } } : r)));
    } else if (d.kind === 'lasso' && d.pts.length > 2) {
      const reg = p.panorama.regions.find((x) => x.id === st.ui.paintRegionId);
      if (reg) {
        const m = maskFromRegion(reg);
        const poly = d.pts;
        for (let row = 0; row < MASK_ROWS; row++) for (let c = 0; c < MASK_COLS; c++) {
          const x = (c + 0.5) / MASK_COLS, y = 1 - (row + 0.5) / MASK_ROWS;
          let inside = false;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i], b = poly[j];
            if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
          }
          if (inside) m[row * MASK_COLS + c] = 1;
        }
        st.setRegions(p.panorama.regions.map((r) => (r.id === reg.id ? { ...r, band: undefined, mask: { cols: MASK_COLS, rows: MASK_ROWS, bits: bits(m) } } : r)));
      } else st.toast('Choose a region for the lasso in the inspector (Source → Regions).', 'info');
    } else if (d.kind === 'path' && d.pts.length > 2) {
      const sorted = d.pts.filter((_, i) => i % 2 === 0);
      st.setPanoramaSettings({ path: sorted, direction: 'path' });
      st.toast('Custom scan path set. Press Generate to re-interpret the panorama along it.', 'ok');
    }
    invalidate();
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = useStore.getState().project;
    if (!p.panorama) return;
    if (e.ctrlKey || e.metaKey) { zoom.current = Math.max(1, Math.min(4, zoom.current * Math.exp(-e.deltaY * 0.01))); invalidate(); return; }
    const beats = displayBeats(p.panorama.settings, p.settings);
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / geom.current.dw;
    const x = scanPoint(engine.position() / beats, p.panorama.settings).x + d;
    engine.seek(timeForX(x, p.panorama.settings) * beats);
  };

  if (!pano) {
    return (
      <div className="overlay-msg"><div className="card">
        <h2>A landscape that plays itself</h2>
        <p>Import a wide image (5000×1000, 15000×3000 …). It scrolls under a fixed playhead while each vertical strip is analysed and turned into music — upper sky as pads, middle as melody, ground as bass, or any regions you paint.</p>
        <div className="btnrow" style={{ justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => fileRef.current?.click()}>Import panorama…</button>
          <button className="btn" onClick={() => void loadFactory('panorama')}>Open “Panoramic Journey” demo</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void useStore.getState().importImage(f, f.name, 'panorama'); e.target.value = ''; }} />
        {job.status === 'error' && <p className="note err">{job.error}</p>}
      </div></div>
    );
  }
  const secs = panoramaSeconds(pano.settings, project.settings);
  return (
    <>
      <canvas ref={ref} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}
        style={{ cursor: ui.panoTool === 'scrub' ? 'ew-resize' : 'crosshair' }} role="img"
        aria-label={`Panorama ${pano.asset.name}. The image scrolls under a fixed playhead. Drag to scrub, click the overview strip to jump.`} />
      <div className="hud" style={{ ['--hud-r-w' as string]: '400px' }}>{pano.asset.name} · {pano.asset.width}×{pano.asset.height} · scan {Math.floor(secs / 60)}:{String(Math.round(secs % 60)).padStart(2, '0')} · {pano.settings.direction} · tool: {ui.panoTool}</div>
      <div className="hud hud-r" style={{ pointerEvents: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        <label className="check"><input type="checkbox" checked={showContours} onChange={(e) => setShowContours(e.target.checked)} />contours</label>
        <span className="seg" style={{ display: 'inline-flex' }}>
          {(['scrub', 'paint', 'erase', 'lasso', 'path'] as const).map((t) => (
            <button key={t} type="button" aria-pressed={ui.panoTool === t} onClick={() => useStore.getState().setUi({ panoTool: t })} title={t === 'path' ? 'Draw a custom scan path across the image' : t === 'lasso' ? 'Lasso-select an area into the chosen region' : t === 'scrub' ? 'Drag to scrub through the image' : `${t} the chosen region's mask`}>{t}</button>
          ))}
        </span>
      </div>
      {job.status === 'running' && (
        <div className="overlay-msg"><div className="card" style={{ minWidth: 320 }}>
          <p>{job.label}</p><Progress value={job.progress} />
          <div className="btnrow" style={{ justifyContent: 'center' }}><button className="btn small" onClick={() => useStore.getState().cancelAnalysis('panorama')}>Cancel</button></div>
        </div></div>
      )}
    </>
  );
}
