import { useEffect, useState } from 'react';
import * as Tone from 'tone';
import { engine, projectContext, useStore } from '../state/store';
import { explain, slotAt } from '../theory/context';
import { chordSymbol } from '../theory/chords';
import { pcName } from '../theory/scales';
import * as db from '../persist/db';
import type { Workspace } from '../core/types';
import { Toolbar, importFile } from './Toolbar';
import { Sidebar } from './Sidebar';
import { Inspector } from './Inspector';
import { HarmonyNow } from './panels/HarmonyPanel';
import { Bottom } from './Bottom';
import { DrawCanvas } from './workspaces/DrawCanvas';
import { ImageView } from './workspaces/ImageView';
import { PanoramaView } from './workspaces/PanoramaView';
import { GenerativeView } from './workspaces/GenerativeView';
import { OrbitalView } from './workspaces/OrbitalView';
import { ParticleView } from './workspaces/ParticleView';
import { Dialogs } from './Dialogs';
import { ErrorBoundary } from './ErrorBoundary';
import { loadFactory } from '../state/factory';
import { renderOffline, peakAndRms } from '../audio/offline';
import { projectToMidi } from '../export/midi';
import { INSTRUMENTS, instrument } from '../audio/patches';
import { getAnalysis, getLevels } from '../analysis/client';
import { scanPoint, displayBeats } from '../interpret/panorama';
import { colorfulTexture, contourFixture, darkUniform, hazeImage, irregularBars, panoramaLandscape, ridgesImage, uniformImage } from '../analysis/procedural';
import { contourPreset } from '../analysis/contours';
import { encodeWav } from '../audio/wav';
import { rgbaToPng } from '../analysis/client';

const WORKSPACES: { id: Workspace; label: string; hint: string }[] = [
  { id: 'draw', label: 'Draw', hint: 'x = time · y = pitch · draw with brushes on the selected layer' },
  { id: 'image', label: 'Image', hint: 'import a photo: contours, colour/texture and atmosphere become music' },
  { id: 'panorama', label: 'Panorama', hint: 'a wide image scrolls under the playhead and plays itself' },
  { id: 'generative', label: 'Generative', hint: 'style-driven compositions, optionally guided by your drawing or image' },
  { id: 'orbital', label: 'Orbital', hint: 'angle = time around the circle · radius = pitch' },
  { id: 'particles', label: 'Particles', hint: 'deterministic particles trigger notes when they enter zones' },
];

export function App() {
  const ws = useStore((s) => s.project.workspace);
  const ui = useStore((s) => s.ui);
  const [audioReady, setAudioReady] = useState(false);
  const [drag, setDrag] = useState(false);

  // restore the previous session (or start with a factory demo on first visit)
  useEffect(() => {
    (async () => {
      const last = db.lastProjectId();
      if (last) {
        try {
          const p = await db.loadProject(last);
          if (p) { await useStore.getState().loadProject(p); useStore.getState().setUi({ saveState: 'saved' }); useStore.getState().toast(`Restored “${p.name}” from your last session`, 'info'); return; }
        } catch (e) { useStore.getState().toast(`Could not restore the last session: ${(e as Error).message}`, 'error'); }
      }
      if (!new URLSearchParams(location.search).has('blank')) await loadFactory('geometry');
    })();
    // debug / test surface: lets the end-to-end suite measure real audio and analysis state
    (window as any).__aperture = {
      store: useStore, engine, Tone, loadFactory,
      api: {
        renderOffline, peakAndRms, projectToMidi, INSTRUMENTS, instrument, getAnalysis, getLevels, scanPoint, displayBeats, darkUniform, colorfulTexture, rgbaToPng,
        hazeImage, ridgesImage, irregularBars, uniformImage, contourFixture, panoramaLandscape, contourPreset, encodeWav,
        listAssetIds: db.listAssetIds, projectContext, explain, slotAt, chordSymbol, pcName,
      },
      liveRms: () => {
        const a = engine.graph?.analyser;
        if (!a) return 0;
        const v = a.getValue() as Float32Array;
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i] * v[i];
        return Math.sqrt(s / v.length);
      },
    };
  }, []);

  useEffect(() => {
    const unlock = () => { void engine.ensure().then(() => setAudioReady(true)).catch(() => {}); };
    const opts = { once: true } as const;
    window.addEventListener('pointerdown', unlock, opts);
    window.addEventListener('keydown', unlock, opts);
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);

  // keyboard shortcuts (ignored while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((t as HTMLInputElement).type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void s.saveNow().then(() => s.toast('Saved to this browser', 'ok')); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) s.redo(); else s.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); s.duplicateSelection(); return; }
      if (mod) return;
      switch (e.key) {
        case ' ': e.preventDefault(); engine.toggle(); return;
        case 'Escape': s.setUi({ selStrokes: [], selNotes: [], dialog: null }); window.dispatchEvent(new CustomEvent('aperture:escape')); return;
        case 'Delete': case 'Backspace':
          if (s.ui.selStrokes.length) s.deleteStrokes(s.ui.selStrokes);
          else if (s.ui.selNotes.length) s.deleteNotes(s.ui.selectedTrackId, s.ui.selNotes);
          e.preventDefault();
          return;
        case 'Home': engine.seek(0); return;
      }
      const k = e.key.toLowerCase();
      const tools: Record<string, typeof s.ui.tool> = { b: 'pencil', p: 'pencil', e: 'eraser', v: 'select', h: 'hand', l: 'line', c: 'curve', d: 'dot', r: 'rect', o: 'ellipse' };
      if (tools[k]) { s.setUi({ tool: tools[k] }); return; }
      if (k === 'n') { s.setUi({ showNotes: !s.ui.showNotes }); return; }
      if (k === 'm') { const t = s.project.tracks.find((x) => x.id === s.ui.selectedTrackId); if (t) s.setMix(t.id, { mute: !t.mix.mute }); return; }
      if (k === '?') { s.setUi({ dialog: 'help' }); return; }
      if (/^[1-6]$/.test(k) && e.altKey) { s.setWorkspace(WORKSPACES[Number(k) - 1].id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const view = ws === 'draw' ? <DrawCanvas /> : ws === 'image' ? <ImageView /> : ws === 'panorama' ? <PanoramaView /> : ws === 'generative' ? <GenerativeView /> : ws === 'orbital' ? <OrbitalView /> : <ParticleView />;

  return (
    <div
      className={`app ${ui.leftOpen ? '' : 'no-left'} ${ui.rightOpen ? '' : 'no-right'}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) importFile(f); }}
    >
      <Toolbar />
      <Sidebar />
      <main className="main">
        <div className="ws-tabs" role="tablist" aria-label="Workspace">
          {WORKSPACES.map((w, i) => (
            <button key={w.id} role="tab" className="ws-tab" aria-selected={ws === w.id} title={`${w.hint} (⌥${i + 1})`} onClick={() => useStore.getState().setWorkspace(w.id)}>{w.label}</button>
          ))}
          <HarmonyNow compact />
        </div>
        <div className="stage">
          <ErrorBoundary key={ws} label="This workspace">{view}</ErrorBoundary>
          {drag && <div className="drop-hint">Drop an image (or an .aperture project) to import it</div>}
        </div>
      </main>
      <ErrorBoundary label="The inspector"><Inspector /></ErrorBoundary>
      <ErrorBoundary label="The bottom panel"><Bottom /></ErrorBoundary>
      {!audioReady && <button className="audio-gate" onClick={() => void engine.ensure().then(() => setAudioReady(true))}>Click anywhere to enable audio</button>}
      <Dialogs />
      <div className="toasts" role="status" aria-live="polite">
        {ui.toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}
