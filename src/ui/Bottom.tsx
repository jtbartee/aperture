import { useEffect, useRef, useState } from 'react';
import { engine, selectedTrack, useStore } from '../state/store';
import type { NoteEvent, Track } from '../core/types';
import { barBeats, projectBeats } from '../core/time';
import { allowedPitches, DRUM_NAMES, inScale, midiName } from '../theory/scales';
import { dbToGain } from '../audio/voices';
import { hexA, useStageCanvas } from './canvas';
import { IChevron } from './components/icons';
import { PerfMonitor } from './panels/PerfMonitor';

// ------------------------------------------------------------------ timeline

function Timeline() {
  const project = useStore((s) => s.project);
  const drag = useRef<null | 'seek' | 'loopA' | 'loopB' | 'loopNew'>(null);
  const anchor = useRef(0);
  const { ref } = useStageCanvas((ctx, w, h) => {
    const p = useStore.getState().project;
    const total = Math.max(1, projectBeats(p.settings));
    const X = (b: number) => (b / total) * w;
    ctx.fillStyle = '#1c1e22';
    ctx.fillRect(0, 0, w, h);
    const bb = barBeats(p.settings.timeSig);
    const bars = p.settings.lengthBars;
    const every = Math.max(1, Math.ceil(bars / (w / 34)));
    ctx.font = '10px ui-monospace, monospace';
    for (let bar = 0; bar <= bars; bar++) {
      const x = X(bar * bb);
      ctx.strokeStyle = bar % every === 0 ? '#3a3e46' : '#26292e';
      ctx.beginPath(); ctx.moveTo(x + 0.5, bar % every === 0 ? 10 : 18); ctx.lineTo(x + 0.5, h); ctx.stroke();
      if (bar % every === 0 && bar < bars) { ctx.fillStyle = '#8b8984'; ctx.fillText(String(bar + 1), x + 3, 10); }
    }
    for (const m of p.markers) {
      ctx.fillStyle = '#b48ee0';
      ctx.fillRect(X(m.beat), 12, 2, h - 12);
      ctx.fillText(m.label, X(m.beat) + 4, h - 4);
    }
    const loop = p.settings.loop;
    ctx.fillStyle = loop.on ? 'rgba(111,183,214,0.28)' : 'rgba(111,183,214,0.1)';
    ctx.fillRect(X(loop.start), 0, X(loop.end) - X(loop.start), 8);
    ctx.fillStyle = loop.on ? '#6fb7d6' : '#4a6470';
    ctx.fillRect(X(loop.start) - 1, 0, 3, 12);
    ctx.fillRect(X(loop.end) - 2, 0, 3, 12);
    const px = X(engine.position());
    ctx.strokeStyle = '#f2c27b';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }, [project]);
  const beatAt = (e: { clientX: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const p = useStore.getState().project;
    const total = projectBeats(p.settings);
    const b = ((e.clientX - r.left) / r.width) * total;
    return Math.max(0, Math.min(total, Math.round(b * p.settings.quantize) / p.settings.quantize));
  };
  return (
    <div className="timeline" title="Click/drag to scrub · drag the blue handles (top strip) to set the loop · shift-drag to draw a new loop">
      <canvas ref={ref} role="slider" aria-label="Timeline position" aria-valuenow={0} tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'ArrowRight') engine.seek(engine.position() + 1); if (e.key === 'ArrowLeft') engine.seek(Math.max(0, engine.position() - 1)); }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          const p = useStore.getState().project;
          const r = ref.current!.getBoundingClientRect();
          const b = beatAt(e);
          const total = projectBeats(p.settings);
          const tol = (6 / r.width) * total;
          if (e.shiftKey) { drag.current = 'loopNew'; anchor.current = b; useStore.getState().checkpoint(); return; }
          if (e.clientY - r.top < 14 && Math.abs(b - p.settings.loop.start) < tol) { drag.current = 'loopA'; useStore.getState().checkpoint(); return; }
          if (e.clientY - r.top < 14 && Math.abs(b - p.settings.loop.end) < tol) { drag.current = 'loopB'; useStore.getState().checkpoint(); return; }
          drag.current = 'seek';
          engine.seek(b);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const st = useStore.getState();
          const s = st.project.settings;
          const b = beatAt(e);
          if (drag.current === 'seek') engine.seek(b);
          else if (drag.current === 'loopA') st.commit((p) => ({ ...p, settings: { ...s, loop: { ...s.loop, start: Math.min(b, s.loop.end - 0.25) } } }), false);
          else if (drag.current === 'loopB') st.commit((p) => ({ ...p, settings: { ...s, loop: { ...s.loop, end: Math.max(b, s.loop.start + 0.25) } } }), false);
          else st.commit((p) => ({ ...p, settings: { ...s, loop: { on: true, start: Math.min(anchor.current, b), end: Math.max(anchor.current + 0.25, b) } } }), false);
        }}
        onPointerUp={() => { drag.current = null; }} />
    </div>
  );
}

// ------------------------------------------------------------------ mixer

function Meter({ trackId }: { trackId?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = engine.graph;
      const m = trackId ? g?.channels.get(trackId)?.meter : g?.masterMeter;
      let v = -Infinity;
      if (m) { const x = m.getValue(); v = Array.isArray(x) ? Math.max(...x) : (x as number); }
      const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, ((v + 60) / 60) * 100)) : 0;
      if (ref.current) ref.current.style.height = `${pct}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [trackId]);
  return <div className="meter" aria-hidden="true"><i ref={ref} /></div>;
}

function Strip({ t, selected }: { t: Track; selected: boolean }) {
  const st = useStore.getState();
  return (
    <div className="strip" aria-current={selected} aria-label={`Channel ${t.name}`}>
      <button className="nm" onClick={() => st.setUi({ selectedTrackId: t.id })} title={`${t.name} · ${t.patch.name}`}><span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flex: 'none' }} />{t.name}</button>
      <div className="ms">
        <button className={`btn mute ${t.mix.mute ? 'on' : ''}`} aria-pressed={t.mix.mute} aria-label={`Mute ${t.name}`} onClick={() => st.setMix(t.id, { mute: !t.mix.mute })}>M</button>
        <button className={`btn solo ${t.mix.solo ? 'on' : ''}`} aria-pressed={t.mix.solo} aria-label={`Solo ${t.name}`} onClick={() => st.setMix(t.id, { solo: !t.mix.solo })}>S</button>
      </div>
      <div className="fader">
        <input type="range" min={-40} max={6} step={0.5} value={t.mix.volume} aria-label={`${t.name} volume`} onPointerDown={() => st.checkpoint()} onChange={(e) => st.setMix(t.id, { volume: Number(e.target.value) }, false)} onDoubleClick={() => st.setMix(t.id, { volume: -6 })} />
        <Meter trackId={t.id} />
      </div>
      <div className="db">{t.mix.volume.toFixed(1)} dB</div>
      <div className="mini"><span>Pan</span><input type="range" min={-1} max={1} step={0.01} value={t.mix.pan} aria-label={`${t.name} pan`} onPointerDown={() => st.checkpoint()} onChange={(e) => st.setMix(t.id, { pan: Number(e.target.value) }, false)} onDoubleClick={() => st.setMix(t.id, { pan: 0 })} /></div>
      <div className="mini"><span>Rev</span><input type="range" min={0} max={1} step={0.01} value={t.mix.reverb} aria-label={`${t.name} reverb send`} onPointerDown={() => st.checkpoint()} onChange={(e) => st.setMix(t.id, { reverb: Number(e.target.value) }, false)} /></div>
      <div className="mini"><span>Dly</span><input type="range" min={0} max={1} step={0.01} value={t.mix.delay} aria-label={`${t.name} delay send`} onPointerDown={() => st.checkpoint()} onChange={(e) => st.setMix(t.id, { delay: Number(e.target.value) }, false)} /></div>
    </div>
  );
}

function MasterStrip() {
  const [vol, setVol] = useState(0);
  return (
    <div className="strip" aria-label="Master">
      <span className="nm"><b>Master</b></span>
      <div className="fader">
        <input type="range" min={-30} max={6} step={0.5} value={vol} aria-label="Master volume" onChange={(e) => { const v = Number(e.target.value); setVol(v); engine.graph?.out.gain.rampTo(dbToGain(v), 0.05); }} />
        <Meter />
      </div>
      <div className="db">{vol.toFixed(1)} dB</div>
      <p className="note" style={{ margin: 0 }}>glue comp → limiter</p>
    </div>
  );
}

function Mixer() {
  const tracks = useStore((s) => s.project.tracks);
  const sel = useStore((s) => s.ui.selectedTrackId);
  return (
    <div className="mixer" role="group" aria-label="Mixer">
      {tracks.map((t) => <Strip key={t.id} t={t} selected={t.id === sel} />)}
      <MasterStrip />
    </div>
  );
}

// ------------------------------------------------------------------ piano roll

const KEYW = 54;
function PianoRoll() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const t = selectedTrack({ project, ui }) as Track | undefined;
  const view = useRef({ x0: 0, ppb: 0 });
  const drag = useRef<null | { kind: 'move' | 'resize' | 'marquee'; b0: number; m0: number; orig: NoteEvent[]; b1?: number; m1?: number }>(null);
  const rows = () => {
    const p = useStore.getState().project;
    const tr = selectedTrack({ project: p, ui: useStore.getState().ui });
    if (!tr) return [] as number[];
    if (tr.pitch.mode === 'drums') return allowedPitches(tr.pitch, 0, 'major');
    const out: number[] = [];
    for (let m = tr.pitch.low; m <= tr.pitch.high; m++) out.push(m);
    return out;
  };
  const { ref, size, invalidate } = useStageCanvas((ctx, w, h) => {
    const p = useStore.getState().project;
    const u = useStore.getState().ui;
    const tr = selectedTrack({ project: p, ui: u });
    ctx.fillStyle = '#101113';
    ctx.fillRect(0, 0, w, h);
    if (!tr) return;
    const R = rows();
    const rh = h / Math.max(1, R.length);
    if (!view.current.ppb) view.current.ppb = Math.max(4, (w - KEYW) / Math.max(1, projectBeats(p.settings)));
    const { x0, ppb } = view.current;
    const X = (b: number) => KEYW + (b - x0) * ppb;
    R.forEach((m, i) => {
      const y = h - (i + 1) * rh;
      const inS = tr.pitch.mode === 'drums' || inScale(m, p.settings.key, p.settings.scale, p.settings.customScale);
      ctx.fillStyle = inS ? (i % 2 ? '#15161a' : '#17181c') : '#0d0e10';
      ctx.fillRect(KEYW, y, w - KEYW, rh);
      ctx.fillStyle = [1, 3, 6, 8, 10].includes(m % 12) && tr.pitch.mode !== 'drums' ? '#26282d' : '#3a3d44';
      ctx.fillRect(0, y, KEYW - 2, rh - 1);
      if (rh >= 8) { ctx.fillStyle = '#a9a69f'; ctx.font = '9px ui-monospace, monospace'; ctx.textBaseline = 'middle'; ctx.fillText(tr.pitch.mode === 'drums' ? DRUM_NAMES[m] ?? String(m) : midiName(m, p.settings.key, p.settings.scale), 3, y + rh / 2); }
    });
    const bb = barBeats(p.settings.timeSig);
    for (let b = Math.floor(x0); X(b) < w; b++) {
      if (b < 0) continue;
      ctx.strokeStyle = b % bb === 0 ? '#3a3e46' : '#202328';
      ctx.beginPath(); ctx.moveTo(X(b) + 0.5, 0); ctx.lineTo(X(b) + 0.5, h); ctx.stroke();
    }
    const yOf = (m: number) => { const i = R.indexOf(m); return i < 0 ? -100 : h - (i + 1) * rh; };
    for (const n of tr.notes) {
      const x = X(n.start);
      if (x > w || x + n.dur * ppb < KEYW) continue;
      const y = yOf(n.midi);
      const user = n.origin === 'user' || n.origin === 'midi';
      ctx.fillStyle = hexA(tr.color, 0.35 + n.vel * 0.6);
      ctx.fillRect(x, y + 1, Math.max(3, n.dur * ppb - 1), Math.max(2, rh - 2));
      if (user) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 1.5, Math.max(3, n.dur * ppb - 2), Math.max(2, rh - 3)); }
      if (n.locked) { ctx.fillStyle = '#f2c27b'; ctx.fillRect(x + 1, y + 2, 3, 3); }
      if (u.selNotes.includes(n.id)) { ctx.strokeStyle = '#f2c27b'; ctx.lineWidth = 2; ctx.strokeRect(x, y + 1, Math.max(3, n.dur * ppb - 1), Math.max(2, rh - 2)); }
    }
    const d = drag.current;
    if (d?.kind === 'marquee' && d.b1 !== undefined) {
      ctx.strokeStyle = '#6fb7d6';
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(X(Math.min(d.b0, d.b1)), Math.min(yOf(d.m0), yOf(d.m1!)), Math.abs(d.b1 - d.b0) * ppb, Math.abs(yOf(d.m0) - yOf(d.m1!)) + rh);
      ctx.setLineDash([]);
    }
    const px = X(engine.position());
    ctx.strokeStyle = '#f2c27b';
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }, [project, ui]);

  useEffect(() => { view.current.ppb = 0; invalidate(); }, [project.settings.lengthBars, t?.id]);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const R = rows();
    const rh = size.current.h / Math.max(1, R.length);
    const i = Math.floor((size.current.h - (e.clientY - r.top)) / rh);
    return { beat: view.current.x0 + (e.clientX - r.left - KEYW) / view.current.ppb, midi: R[Math.max(0, Math.min(R.length - 1, i))] };
  };
  const q = () => useStore.getState().project.settings.quantize;
  const snap = (b: number) => Math.round(b * q()) / q();
  const hit = (beat: number, midi: number) => t?.notes.find((n) => n.midi === midi && beat >= n.start && beat <= n.start + n.dur);

  if (!t) return <div className="roll" />;
  return (
    <div className="roll">
      <canvas ref={ref} role="application" aria-label={`Piano roll for ${t.name}: click empty space to add a note, drag notes to move, drag their right edge to resize, Delete removes, L locks`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key.toLowerCase() === 'l') useStore.getState().updateTrack(t.id, (x) => ({ ...x, notes: x.notes.map((n) => (ui.selNotes.includes(n.id) ? { ...n, locked: !n.locked } : n)) }));
        }}
        onWheel={(e) => { const v = view.current; if (e.ctrlKey || e.metaKey) v.ppb = Math.max(2, Math.min(400, v.ppb * Math.exp(-e.deltaY * 0.01))); else v.x0 = Math.max(-1, v.x0 + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / v.ppb); invalidate(); }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          const { beat, midi } = at(e);
          const st = useStore.getState();
          const n = hit(beat, midi);
          if (n && e.altKey) { st.deleteNotes(t.id, [n.id]); return; }
          if (n) {
            const sel = e.shiftKey ? [...new Set([...st.ui.selNotes, n.id])] : st.ui.selNotes.includes(n.id) ? st.ui.selNotes : [n.id];
            st.setUi({ selNotes: sel, selStrokes: [] });
            st.checkpoint();
            const edge = (n.start + n.dur - beat) * view.current.ppb < 6;
            drag.current = { kind: edge ? 'resize' : 'move', b0: beat, m0: midi, orig: t.notes.filter((x) => sel.includes(x.id)) };
            void engine.preview(t.id, n.midi, n.vel, 0.25);
            return;
          }
          if (e.shiftKey) { drag.current = { kind: 'marquee', b0: beat, m0: midi, orig: [], b1: beat, m1: midi }; return; }
          if (beat < 0) return;
          const dur = Math.max(1 / q(), 0.5);
          st.addNote(t.id, { start: Math.max(0, Math.floor(beat * q()) / q()), dur, midi, vel: 0.8 });
          void engine.preview(t.id, midi, 0.8, 0.25);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const { beat, midi } = at(e);
          const st = useStore.getState();
          if (d.kind === 'marquee') { d.b1 = beat; d.m1 = midi; invalidate(); return; }
          const R = rows();
          const dRow = R.indexOf(midi) - R.indexOf(d.m0);
          const dB = snap(beat - d.b0);
          const orig = new Map(d.orig.map((n) => [n.id, n]));
          st.updateNotes(t.id, [...orig.keys()], (n) => {
            const o = orig.get(n.id)!;
            if (d.kind === 'resize') return { ...n, dur: Math.max(1 / q() / 2, o.dur + dB) };
            const idx = Math.max(0, Math.min(R.length - 1, R.indexOf(o.midi) + dRow));
            return { ...n, start: Math.max(0, o.start + dB), midi: R[idx], pitchY: undefined, stepOffset: undefined, degree: undefined };
          }, false);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.kind === 'marquee' && d.b1 !== undefined) {
            const [b0, b1] = [Math.min(d.b0, d.b1), Math.max(d.b0, d.b1)];
            const [m0, m1] = [Math.min(d.m0, d.m1!), Math.max(d.m0, d.m1!)];
            useStore.getState().setUi({ selNotes: t.notes.filter((n) => n.start >= b0 && n.start <= b1 && n.midi >= m0 && n.midi <= m1).map((n) => n.id) });
          }
          invalidate();
        }} />
    </div>
  );
}

// ------------------------------------------------------------------ scenes

function Scenes() {
  const project = useStore((s) => s.project);
  const st = useStore.getState();
  const [name, setName] = useState('');
  return (
    <div className="scenes">
      <div className="col">
        <h3 className="h">Scenes</h3>
        <p className="note">A scene snapshots every layer's notes and mix. Recall swaps them in (at the next boundary while playing).</p>
        <div className="btnrow">
          <input className="txt" placeholder="Scene name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New scene name" />
          <button className="btn small" onClick={() => { st.saveScene(name); setName(''); }}>Save scene</button>
        </div>
        {project.scenes.map((s) => (
          <div key={s.id} className="pitem">
            <span>{s.name} <span className="meta">{s.bars} bars · {s.tracks.length} layers</span></span>
            <span className="btnrow" style={{ margin: 0 }}>
              <button className="btn small" onClick={() => st.recallScene(s.id)}>Recall</button>
              <button className="btn small" onClick={() => st.setArrangement([...project.arrangement, { sceneId: s.id, repeats: 1 }])}>+ Arr.</button>
              <button className="btn small danger" onClick={() => st.deleteScene(s.id)}>×</button>
            </span>
          </div>
        ))}
      </div>
      <div className="col">
        <h3 className="h">Arrangement</h3>
        {!project.arrangement.length && <p className="note">Add scenes to chain them, then print the chain into the timeline.</p>}
        {project.arrangement.map((e, i) => (
          <div key={i} className="pitem">
            <span>{i + 1}. {project.scenes.find((s) => s.id === e.sceneId)?.name ?? '?'}</span>
            <span className="btnrow" style={{ margin: 0 }}>
              <label className="field">×<input type="number" min={1} max={32} value={e.repeats} onChange={(ev) => st.setArrangement(project.arrangement.map((x, j) => (j === i ? { ...x, repeats: Math.max(1, Number(ev.target.value)) } : x)))} style={{ width: 46 }} /></label>
              <button className="btn small danger" onClick={() => st.setArrangement(project.arrangement.filter((_, j) => j !== i))}>×</button>
            </span>
          </div>
        ))}
        <div className="btnrow"><button className="btn small primary" disabled={!project.arrangement.length} onClick={() => { if (confirm('Replace the timeline with the printed arrangement? (Undo restores it.)')) st.printArrangement(); }}>Print arrangement to timeline</button></div>
      </div>
    </div>
  );
}

export function Bottom() {
  const ui = useStore((s) => s.ui);
  const st = useStore.getState();
  return (
    <section className={`bottom ${ui.bottomOpen ? '' : 'closed'}`} aria-label="Timeline, mixer and editors">
      <Timeline />
      <div className="bottom-bar">
        <div className="tabs" role="tablist" style={{ borderBottom: 0, padding: 0 }}>
          {(['mixer', 'roll', 'scenes', 'perf'] as const).map((k) => (
            <button key={k} role="tab" className="tab" aria-selected={ui.bottomTab === k} onClick={() => st.setUi({ bottomTab: k, bottomOpen: true })}>{k === 'roll' ? 'Piano roll' : k === 'mixer' ? 'Mixer' : k === 'perf' ? 'Performance' : 'Scenes'}</button>
          ))}
        </div>
        {ui.pendingRegen && <span className="note warn" style={{ margin: 0 }}>⏱ {ui.pendingRegen}</span>}
        <span className="spacer" />
        <span className="note" style={{ margin: 0 }}>{ui.midiStatus}</span>
        <button className="btn small icon" aria-label={ui.bottomOpen ? 'Collapse panel' : 'Expand panel'} aria-expanded={ui.bottomOpen} onClick={() => st.setUi({ bottomOpen: !ui.bottomOpen })} style={{ transform: ui.bottomOpen ? undefined : 'rotate(180deg)' }}><IChevron size={14} /></button>
      </div>
      <div className="bottom-body">
        {ui.bottomTab === 'mixer' ? <Mixer /> : ui.bottomTab === 'roll' ? <PianoRoll /> : ui.bottomTab === 'perf' ? <PerfMonitor /> : <Scenes />}
      </div>
    </section>
  );
}
