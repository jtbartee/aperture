import { useEffect, useRef, useState } from 'react';
import { engine, useStore } from '../state/store';
import { formatPosition, TIME_SIGS } from '../core/time';
import type { ScaleId, TimeSigId } from '../core/types';
import { KEY_NAMES, SCALES, SCALE_IDS } from '../theory/scales';
import { IExport, IFolder, IHelp, IImage, ILoop, IMetro, INew, IPanel, IPause, IPlay, IRec, IRedo, IRewind, ISave, IStop, IUndo } from './components/icons';
import { SUBDIVISIONS } from '../theory/rhythm';
import { toggleMidiRecord } from './midiInput';
import { importProjectFile } from './exportActions';

function Position() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const p = useStore.getState().project;
      if (ref.current) ref.current.textContent = formatPosition(engine.position(), p.settings.timeSig) + `  ${engine.position().toFixed(2)}`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span className="pos" ref={ref} aria-label="Transport position (bar.beat and beats)" style={{ minWidth: 120 }} />;
}

export function importFile(file: File) {
  const s = useStore.getState();
  if (/\.aperture$|\.zip$/i.test(file.name)) { void importProjectFile(file); return; }
  if (!/^image\//.test(file.type)) { s.toast(`“${file.name}” is not an image (JPG, PNG, WebP or GIF) or an .aperture project.`, 'error'); return; }
  const ws = s.project.workspace;
  // decide: explicit workspace wins; otherwise very wide images become panoramas
  const probe = new Image();
  const url = URL.createObjectURL(file);
  probe.onload = () => {
    URL.revokeObjectURL(url);
    const wide = probe.naturalWidth / Math.max(1, probe.naturalHeight) >= 2.2;
    const kind = ws === 'panorama' ? 'panorama' : ws === 'image' ? 'image' : wide ? 'panorama' : 'image';
    void s.importImage(file, file.name, kind);
  };
  probe.onerror = () => { URL.revokeObjectURL(url); void s.importImage(file, file.name, ws === 'panorama' ? 'panorama' : 'image'); };
  probe.src = url;
}

export function Toolbar() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const st = useStore.getState();
  const [, force] = useState(0);
  useEffect(() => engine.onChange(() => force((x) => x + 1)), []);
  const taps = useRef<number[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const s = project.settings;
  const playing = engine.state === 'playing';

  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 2500), now].slice(-5);
    if (taps.current.length >= 2) {
      const iv = taps.current.slice(1).map((t, i) => t - taps.current[i]);
      const bpm = Math.round(60000 / (iv.reduce((a, b) => a + b, 0) / iv.length));
      if (bpm >= 30 && bpm <= 300) st.setSettings({ bpm });
    }
  };

  return (
    <header className="toolbar top" role="toolbar" aria-label="Project and transport">
      <span className="brand" aria-label="APERTURE">APERTURE</span>
      <input className="proj-name" aria-label="Project name" value={project.name} onChange={(e) => st.commit((p) => ({ ...p, name: e.target.value }), false)} onBlur={() => st.rename(project.name)} />
      <span className={`save-state ${ui.saveState}`} title="Projects autosave to this browser. Download a project file for permanent storage.">
        {ui.saveState === 'saved' ? 'Saved' : ui.saveState === 'saving' ? 'Saving…' : ui.saveState === 'error' ? 'Save failed' : 'Unsaved'}
      </span>
      <div className="tb-group">
        <button className="btn icon" title="New project" aria-label="New project" onClick={() => { if (confirm('Start a new project? The current one stays saved in this browser.')) st.newProject(); }}><INew /></button>
        <button className="btn icon" title="Open project…" aria-label="Open project" onClick={() => st.setUi({ dialog: 'projects' })}><IFolder /></button>
        <button className="btn icon" title="Save (⌘S)" aria-label="Save" onClick={() => void st.saveNow().then(() => st.toast('Saved to this browser', 'ok'))}><ISave /></button>
        <button className="btn" title="Import an image or panorama (or drop a file anywhere)" onClick={() => fileRef.current?.click()}><IImage /> Import</button>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,.aperture,.zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
      </div>
      <div className="tb-group">
        <button className="btn icon" title="Undo (⌘Z)" aria-label="Undo" disabled={!past} onClick={st.undo}><IUndo /></button>
        <button className="btn icon" title="Redo (⇧⌘Z)" aria-label="Redo" disabled={!future} onClick={st.redo}><IRedo /></button>
      </div>
      <div className="tb-group" aria-label="Transport">
        <button className="btn icon" title="Rewind to start (Home)" aria-label="Rewind" onClick={() => engine.seek(0)}><IRewind /></button>
        <button className={`btn icon play ${playing ? 'on' : ''}`} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'} onClick={() => engine.toggle()}>{playing ? <IPause /> : <IPlay />}</button>
        <button className="btn icon" title="Stop (press twice to return to 0)" aria-label="Stop" onClick={() => engine.stop()}><IStop /></button>
        <button className={`btn icon ${s.loop.on ? 'on' : ''}`} title="Loop region on/off" aria-pressed={s.loop.on} aria-label="Loop" onClick={() => st.setSettings({ loop: { ...s.loop, on: !s.loop.on } })}><ILoop /></button>
        <button className={`btn icon ${s.metronome ? 'on' : ''}`} title="Metronome" aria-pressed={s.metronome} aria-label="Metronome" onClick={() => st.setSettings({ metronome: !s.metronome })}><IMetro /></button>
        <button className={`btn icon ${ui.recording ? 'on' : ''}`} title="Record MIDI input into the selected track (needs a MIDI keyboard)" aria-pressed={ui.recording} aria-label="Record MIDI" style={{ color: ui.recording ? '#f08a7a' : undefined }} onClick={() => toggleMidiRecord()}><IRec /></button>
        <Position />
      </div>
      <div className="tb-group">
        <span className="field"><label htmlFor="bpm">Tempo</label>
          <input id="bpm" type="number" min={30} max={300} step={1} value={s.bpm} onChange={(e) => { const v = Number(e.target.value); if (v >= 30 && v <= 300) st.setSettings({ bpm: v }); }} />
        </span>
        <button className="btn small" title="Tap tempo" onClick={tap}>Tap</button>
        <select className="sel" aria-label="Time signature" value={s.timeSig} onChange={(e) => st.setSettings({ timeSig: e.target.value as TimeSigId })}>
          {Object.keys(TIME_SIGS).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="sel" aria-label="Key" value={s.key} onChange={(e) => st.setSettings({ key: Number(e.target.value) })}>
          {KEY_NAMES.map((k, i) => <option key={k} value={i}>{k}</option>)}
        </select>
        <select className="sel" aria-label="Scale" value={s.scale} onChange={(e) => st.setSettings({ scale: e.target.value as ScaleId })}>
          {SCALE_IDS.map((id) => <option key={id} value={id}>{SCALES[id].name}</option>)}
        </select>
        <select className="sel" aria-label="Swing" title="Swing (applied identically to playback, WAV and MIDI)" value={s.swing} onChange={(e) => st.setSettings({ swing: Number(e.target.value) })}>
          <option value={0}>Swing off</option><option value={0.25}>Swing light</option><option value={0.5}>Swing medium</option><option value={0.8}>Swing hard</option>
        </select>
        <select className="sel" aria-label="Quantize grid" title="Quantize grid for drawing and note editing" value={s.quantize} onChange={(e) => { const q = Number(e.target.value); st.setSettings({ quantize: q }); st.setUi({ brush: { ...ui.brush, density: q } }); }}>
          {SUBDIVISIONS.map((d) => <option key={d.steps} value={d.steps}>Grid {d.label}</option>)}
        </select>
      </div>
      <span className="spacer" />
      <button className="btn primary" onClick={() => st.setUi({ dialog: 'export' })} title="Export MIDI, WAV, stems, project file and images"><IExport /> Export</button>
      <button className="btn icon" title="Help, shortcuts and feature status" aria-label="Help" onClick={() => st.setUi({ dialog: 'help' })}><IHelp /></button>
      <button className="btn icon" title="Toggle side panels" aria-label="Toggle side panels" onClick={() => st.setUi({ leftOpen: !(ui.leftOpen && ui.rightOpen), rightOpen: !(ui.leftOpen && ui.rightOpen) })}><IPanel /></button>
    </header>
  );
}
