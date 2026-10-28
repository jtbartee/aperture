import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import * as db from '../persist/db';
import { FACTORY, loadFactory } from '../state/factory';
import { exportMidi, exportOverlay, exportPNG, exportProjectFile, exportSVG, exportWav, importProjectFile, type Range, type WavOptions } from './exportActions';
import { Check, Progress, Seg } from './components/controls';
import { RenderCancelled } from '../audio/offline';
import { uid } from '../core/ids';
import type { Project } from '../core/types';
import { resetLayout } from './ErrorBoundary';

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('button, input, select')?.focus(); }, []);
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <button className="btn small close" onClick={onClose} aria-label="Close">Close</button>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const st = useStore.getState();
  const current = useStore((s) => s.project);
  const [list, setList] = useState<db.ProjectMeta[]>([]);
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => { db.listProjects().then(setList).catch((e) => setErr(e.message)); db.storageEstimate().then(setEst); };
  useEffect(refresh, []);
  const open = async (id: string) => { const p = await db.loadProject(id); if (p) { await st.loadProject(p); st.setUi({ saveState: 'saved' }); onClose(); } };
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  return (
    <Modal title="Projects" onClose={onClose}>
      <p className="note warn">Projects are saved in this browser only (IndexedDB) and are lost if you clear site data. Use <b>Export → Project file</b> for a permanent, portable copy that includes its images.</p>
      {est && <p className="note">Storage used: {mb(est.usage)} of {mb(est.quota)} available to this site.</p>}
      {err && <p className="note err">{err}</p>}
      <div className="btnrow">
        <button className="btn primary" onClick={() => { st.newProject(); onClose(); }}>New empty project</button>
        <button className="btn" onClick={() => fileRef.current?.click()}>Import project file…</button>
        <input ref={fileRef} type="file" accept=".aperture,.zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importProjectFile(f).then(onClose); e.target.value = ''; }} />
      </div>
      <h3 className="h">Factory projects</h3>
      <div className="factory">
        {FACTORY.map((f) => (
          <button key={f.id} onClick={() => { onClose(); void loadFactory(f.id); }}>
            <b>{f.name}</b><small>{f.mode} · {f.style}</small><br /><small>{f.description}</small>
          </button>
        ))}
      </div>
      <h3 className="h">Saved in this browser</h3>
      <div className="plist">
        {!list.length && <p className="note">No saved projects yet — they autosave as you work.</p>}
        {list.map((m) => (
          <div className="pitem" key={m.id}>
            <span>{m.name}{m.id === current.id ? ' (open)' : ''}<br /><span className="meta">{m.workspace} · edited {new Date(m.modified).toLocaleString()}</span></span>
            <span className="btnrow" style={{ margin: 0 }}>
              <button className="btn small" onClick={() => void open(m.id)}>Open</button>
              <button className="btn small" onClick={async () => {
                const name = prompt('Rename project', m.name);
                if (!name) return;
                const p = await db.loadProject(m.id);
                if (p) { await db.saveProject({ ...p, name }); if (m.id === current.id) st.rename(name); refresh(); }
              }}>Rename</button>
              <button className="btn small" onClick={async () => {
                const p = await db.loadProject(m.id);
                if (p) { const copy: Project = { ...structuredClone(p), id: uid('prj'), name: `${p.name} copy`, created: Date.now(), modified: Date.now() }; await db.saveProject(copy); refresh(); }
              }}>Duplicate</button>
              <button className="btn small danger" disabled={m.id === current.id} onClick={async () => { if (confirm(`Delete “${m.name}” from this browser?`)) { await db.deleteProject(m.id); refresh(); } }}>Delete</button>
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const st = useStore.getState();
  const project = useStore((s) => s.project);
  const [range, setRange] = useState<Range>('all');
  const [opts, setOpts] = useState<Omit<WavOptions, 'range' | 'stems'>>({ tail: project.settings.tail, bitDepth: 16, sampleRate: 44100 });
  const [job, setJob] = useState<{ running: boolean; progress: number; label: string; result?: string; error?: string }>({ running: false, progress: 0, label: '' });
  const abort = useRef<AbortController | null>(null);
  const run = async (stems: boolean) => {
    abort.current = new AbortController();
    setJob({ running: true, progress: 0, label: 'Preparing…' });
    try {
      const result = await exportWav({ ...opts, range, stems }, (f, label) => setJob((j) => ({ ...j, progress: f, label })), abort.current.signal);
      setJob({ running: false, progress: 1, label: '', result });
    } catch (e) {
      setJob({ running: false, progress: 0, label: '', error: e instanceof RenderCancelled ? 'Render cancelled.' : `Render failed: ${(e as Error).message}` });
    }
  };
  const loopLen = project.settings.loop.end - project.settings.loop.start;
  return (
    <Modal title="Export" onClose={() => { abort.current?.abort(); onClose(); }}>
      <Seg label="Range" value={range} onChange={setRange} options={[{ value: 'all', label: `Full arrangement (${project.settings.lengthBars} bars)` }, { value: 'loop', label: `Loop region (${loopLen.toFixed(1)} beats)` }]} />
      <h3 className="h">MIDI</h3>
      <p className="note">Standard MIDI file: one track per layer, tempo, time signature, swing applied exactly as heard, drums on channel 10, filter/pan automation as CC74/CC10. MIDI carries notes, not APERTURE's synth sounds — assign instruments in your DAW.</p>
      <div className="btnrow"><button className="btn primary" onClick={() => { exportMidi(range); st.toast('MIDI exported', 'ok'); }}>Export MIDI (.mid)</button></div>
      <h3 className="h">Audio</h3>
      <p className="note">Rendered offline through the same synths, effects and mix as playback — faster than real time, with progress and cancel.</p>
      <div className="btnrow">
        <Seg value={opts.sampleRate} onChange={(v) => setOpts({ ...opts, sampleRate: v })} options={[{ value: 44100, label: '44.1 kHz' }, { value: 48000, label: '48 kHz' }]} />
        <Seg value={opts.bitDepth} onChange={(v) => setOpts({ ...opts, bitDepth: v })} options={[{ value: 16, label: '16-bit' }, { value: 24, label: '24-bit' }]} />
        <label className="field">Tail <input type="number" min={0} max={30} value={opts.tail} onChange={(e) => setOpts({ ...opts, tail: Math.max(0, Math.min(30, Number(e.target.value))) })} /> s</label>
      </div>
      <div className="btnrow">
        <button className="btn primary" disabled={job.running} onClick={() => void run(false)}>Export WAV mix</button>
        <button className="btn" disabled={job.running} onClick={() => void run(true)}>Export stems (ZIP of WAVs)</button>
        {job.running && <button className="btn danger" onClick={() => abort.current?.abort()}>Cancel</button>}
      </div>
      {job.running && <><p className="note">{job.label}</p><Progress value={job.progress} /></>}
      {job.result && <p className="note" style={{ color: 'var(--ok)' }}>{job.result}</p>}
      {job.error && <p className="note err">{job.error}</p>}
      <h3 className="h">Project & images</h3>
      <div className="btnrow">
        <button className="btn" onClick={() => void exportProjectFile().then(() => st.toast('Project file exported (includes images)', 'ok')).catch((e) => st.toast(e.message, 'error'))}>Project file (.aperture)</button>
        <button className="btn" onClick={exportPNG}>PNG of current view</button>
        <button className="btn" disabled={!project.strokes.length} onClick={exportSVG}>SVG of drawing</button>
        <button className="btn" disabled={!project.image} onClick={() => void exportOverlay('image').catch((e) => st.toast(e.message, 'error'))}>Image analysis overlay</button>
        <button className="btn" disabled={!project.panorama} onClick={() => void exportOverlay('panorama').catch((e) => st.toast(e.message, 'error'))}>Panorama overlay</button>
      </div>
    </Modal>
  );
}

const STATUS: [string, 'ok' | 'part', string][] = [
  ['Drawing instrument (6 tools + shapes, 6 brushes, select/move/resize/duplicate, eraser, zoom/pan, stylus pressure)', 'ok', 'Automated + browser tested'],
  ['Key/scale remapping without touching sources (17 scales + custom)', 'ok', 'Automated tests'],
  ['Image sonification: traced contours as voices, colour & texture, atmospheric, hybrid; photo / contour / overlay views', 'ok', 'Automated + browser tested (contour fidelity measured)'],
  ['Free-time, image-texture and metric rhythm; no default drum kit', 'ok', 'Automated + rendered-audio tests'],
  ['Image Synth: image wavetables, FM, noise, LFO, reassignable feature → parameter mapping, evolving lanes', 'ok', 'Rendered-audio tests; not yet reviewed by ear'],
  ['Panorama sequencer: contour voices, evolving atmosphere, tiled analysis, free/beat timing, 5 scan directions, regions/masks/lasso/path', 'ok', 'Automated + browser tested'],
  ['Generative composer: 8 styles, 5 structures, locks, seeds, mutation/evolution', 'ok', 'Automated tests'],
  ['12 instruments + drum kit, 26 factory presets, sound editor, user presets', 'ok', 'Browser tested (rendered audio)'],
  ['Effects: 14 insert types incl. Atmospheric Sweep; reverb/delay sends; modulation matrix', 'ok', 'Browser tested'],
  ['MIDI / WAV / stems / project / PNG / SVG / overlay export', 'ok', 'Automated + browser tested'],
  ['Scenes + arrangement printing', 'ok', 'Automated tests'],
  ['Orbital and particle sequencers, custom scan path', 'ok', 'Automated tests; UI lightly tested'],
  ['Web MIDI input (play, scale-lock, record)', 'part', 'Implemented; needs testing with hardware'],
  ['Bitcrusher', 'part', 'Bit-depth reduction only (no sample-rate reduction)'],
  ['GIF', 'part', 'First frame only (still-frame behaviour)'],
];

function HelpDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'start' | 'keys' | 'status'>('start');
  return (
    <Modal title="APERTURE" onClose={onClose}>
      <Seg value={tab} onChange={setTab} options={[{ value: 'start', label: 'Getting started' }, { value: 'keys', label: 'Shortcuts' }, { value: 'status', label: 'Feature status' }]} />
      {tab === 'start' && (
        <div>
          <p><b>The image is the score.</b> Everything you draw, import or generate becomes ordinary note events on layers — the same events play live, render to WAV and export to MIDI.</p>
          <ul>
            <li><b>Draw</b>: pick a layer and a brush, draw left→right. Vertical position is pitch in the layer's range and the project key/scale.</li>
            <li><b>Image</b>: import a photo. Its contours are traced and each plays as a voice — left to right is time, height is pitch, gaps are silence. Switch between Photo, Contours and Overlay to see exactly what is heard. Shape the reading with Visual fidelity, Musical structure, Evolution and Event density; choose Free time, Image texture or Metric beat. Every derived layer is editable in the piano roll.</li>
            <li><b>Panorama</b>: import a very wide image; it scrolls under a fixed playhead. Ridgelines become voices over an evolving atmosphere whose timbre follows the scan; classic band and painted-region roles are still available.</li>
            <li><b>Generative</b>: choose a style and press Generate; guide it with your drawing or image; lock what you like and regenerate the rest.</li>
            <li>Change sounds in <b>Sound</b>/<b>FX</b>; that never re-analyses the image. Changing the scale re-pitches notes without touching drawings.</li>
          </ul>
          <p className="note">Audio starts after your first click or key press (browser policy). Everything runs locally: no account, no uploads, no paid services.</p>
          <div className="btnrow"><button className="btn small" onClick={() => { resetLayout(); onClose(); }}>Reset workspace layout</button></div>
        </div>
      )}
      {tab === 'keys' && (
        <table className="status-table"><tbody>
          {[['Space', 'Play / pause'], ['Home', 'Rewind'], ['Esc', 'Cancel tool / clear selection'], ['B / P', 'Pencil'], ['L C D R O', 'Line, curve, dot, rectangle, ellipse'], ['E', 'Eraser'], ['V', 'Select'], ['H (or hold Space-drag, middle-drag)', 'Pan'], ['⌘/Ctrl + wheel', 'Zoom'], ['Delete', 'Delete selection'], ['⌘/Ctrl + D', 'Duplicate selected strokes'], ['⌘/Ctrl + Z / ⇧⌘Z', 'Undo / redo'], ['⌘/Ctrl + S', 'Save'], ['N', 'Toggle note overlay'], ['M', 'Mute selected layer'], ['⌥1 … ⌥6', 'Switch workspace'], ['Piano roll: click / drag / edge / Alt-click / L', 'Add, move, resize, delete, lock notes'], ['Enter / double-click', 'Finish a curve']].map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}
        </tbody></table>
      )}
      {tab === 'status' && (
        <table className="status-table"><tbody>
          {STATUS.map(([f, s, n]) => <tr key={f}><td className={s === 'ok' ? 'st-ok' : 'st-part'}>{s === 'ok' ? '●' : '◐'}</td><td>{f}</td><td className="note">{n}</td></tr>)}
        </tbody></table>
      )}
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.ui.dialog);
  const close = () => useStore.getState().setUi({ dialog: null });
  if (dialog === 'projects') return <ProjectsDialog onClose={close} />;
  if (dialog === 'export') return <ExportDialog onClose={close} />;
  if (dialog === 'help') return <HelpDialog onClose={close} />;
  return null;
}

export { Check };
