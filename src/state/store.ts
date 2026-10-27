import { create } from 'zustand';
import type {
  BrushSettings, CompositionSettings, EffectSlot, ImageSettings, Mix, NoteEvent, PanoramaSettings, Project, ProjectSettings,
  Region, RhythmSpec, Stroke, SynthPatch, Track, Workspace, ShapeKind,
} from '../core/types';
import { uid } from '../core/ids';
import { hash32 } from '../core/rng';
import { barBeats, projectBeats } from '../core/time';
import { LiveEngine } from '../audio/engine';
import { defaultBrush } from '../interpret/strokes';
import { deriveStrokes } from '../interpret/derive';
import { remapProject, remapTrack } from '../interpret/remap';
import { type LayerOutput, PALETTE, trackFromLayer, emptyTrack } from '../interpret/layers';
import { defaultImageSettings, generateImageLayers } from '../interpret/imageModes';
import { defaultPanoramaSettings, defaultRegions, generatePanoramaLayers, panoramaBeats, scanPath, regionMask } from '../interpret/panorama';
import { blendByBars, compose, drawingCurve } from '../interpret/composer';
import { orbitalNotes } from '../interpret/orbital';
import { simulateParticles } from '../interpret/particles';
import { bakeRoute } from '../interpret/modmatrix';
import { captureScene, printArrangement } from '../interpret/scenes';
import { fullMask, regionCurve, type Curve } from '../analysis/features';
import { AnalysisCancelled, analyzeBitmap, buildLevels, decodeImage, getAnalysis, rerunContours } from '../analysis/client';
import * as db from '../persist/db';
import { newProject, normalizeProject } from './project';
import { instrument } from '../audio/patches';

export type Tool = 'pencil' | 'line' | 'curve' | 'dot' | 'rect' | 'ellipse' | 'eraser' | 'select' | 'hand';
export const TOOL_SHAPE: Partial<Record<Tool, ShapeKind>> = { pencil: 'freehand', line: 'line', curve: 'curve', dot: 'dot', rect: 'rect', ellipse: 'ellipse' };

export interface Toast { id: number; kind: 'info' | 'error' | 'ok'; text: string }
export interface Job { status: 'idle' | 'running' | 'done' | 'error'; progress: number; label: string; error?: string }

export interface UIState {
  tool: Tool;
  brush: BrushSettings;
  selectedTrackId: string;
  selStrokes: string[];
  selNotes: string[]; // note ids on the selected track
  showNotes: boolean;
  inspectorTab: 'track' | 'sound' | 'fx' | 'source' | 'mod';
  bottomTab: 'mixer' | 'roll' | 'scenes';
  bottomOpen: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  toasts: Toast[];
  analysis: { image: Job; panorama: Job };
  render: Job;
  saveState: 'saved' | 'saving' | 'unsaved' | 'error';
  recording: boolean;
  midiStatus: string;
  panoTool: 'scrub' | 'paint' | 'erase' | 'lasso' | 'path';
  paintRegionId: string;
  pendingRegen: string | null;
  dialog: null | 'projects' | 'export' | 'help' | 'about';
  hoverInfo: string;
}

interface Store {
  project: Project;
  past: Project[];
  future: Project[];
  ui: UIState;
  setUi(patch: Partial<UIState>): void;
  toast(text: string, kind?: Toast['kind']): void;
  // history
  commit(fn: (p: Project) => Project, history?: boolean): void;
  checkpoint(): void;
  undo(): void;
  redo(): void;
  // settings / tracks
  setSettings(patch: Partial<ProjectSettings>): void;
  setWorkspace(w: Workspace): void;
  rename(name: string): void;
  addTrack(role?: Track['role'], patchName?: string): string;
  removeTrack(id: string): void;
  updateTrack(id: string, fn: (t: Track) => Track, history?: boolean): void;
  setMix(id: string, patch: Partial<Mix>, history?: boolean): void;
  setPatch(id: string, patch: SynthPatch, history?: boolean): void;
  setFx(id: string, fx: EffectSlot[], history?: boolean): void;
  // drawing
  addStroke(s: Omit<Stroke, 'id' | 'seed'>): string;
  replaceStrokes(strokes: Stroke[], history?: boolean): void;
  deleteStrokes(ids: string[], history?: boolean): void;
  duplicateSelection(): void;
  clearLayer(trackId: string): void;
  clearCanvas(): void;
  rederiveAll(): void;
  // notes
  addNote(trackId: string, n: Omit<NoteEvent, 'id' | 'origin'>, origin?: NoteEvent['origin']): void;
  updateNotes(trackId: string, ids: string[], fn: (n: NoteEvent) => NoteEvent, history?: boolean): void;
  deleteNotes(trackId: string, ids: string[], history?: boolean): void;
  // generation
  applyLayers(family: string, layers: LayerOutput[], opts?: { only?: string; label?: string }): void;
  importImage(file: Blob, name: string, kind: 'image' | 'panorama', settings?: Partial<ImageSettings> | Partial<PanoramaSettings>): Promise<void>;
  analyze(kind: 'image' | 'panorama'): Promise<void>;
  cancelAnalysis(kind: 'image' | 'panorama'): void;
  setImageSettings(patch: Partial<ImageSettings>, regenerate?: boolean): void;
  generateImage(only?: string): void;
  setPanoramaSettings(patch: Partial<PanoramaSettings>): void;
  setRegions(regions: Region[], history?: boolean): void;
  generatePanorama(only?: string): void;
  setComposition(patch: Partial<CompositionSettings>): void;
  generateComposition(only?: string, applyTempo?: boolean): void;
  regenerateTrack(trackId: string, newSeed?: boolean): void;
  setTrackRhythm(trackId: string, r: Partial<RhythmSpec>): void;
  bakeModMatrix(): void;
  regenerateOrbital(): void;
  regenerateParticles(): void;
  // scenes
  saveScene(name: string): void;
  recallScene(id: string): void;
  deleteScene(id: string): void;
  setArrangement(entries: Project['arrangement']): void;
  printArrangement(): void;
  // projects
  loadProject(p: Project, assets?: { id: string; blob: Blob }[]): Promise<void>;
  newProject(): void;
  saveNow(): Promise<void>;
}

const HISTORY_LIMIT = 120;
let analysisAborts: Record<string, AbortController | undefined> = {};
let toastId = 0;

export const useStore = create<Store>((set, get) => {
  const initial = newProject('Untitled');

  const finish = (p: Project): Project => ({ ...p, modified: Date.now() });

  const curveFor = (p: Project, source: 'image' | 'panorama' | 'drawing', steps = 256): { curve: Curve; beats: number } | null => {
    if (source === 'drawing') {
      if (!p.strokes.length) return null;
      return { curve: drawingCurve(p.strokes, projectBeats(p.settings)), beats: projectBeats(p.settings) };
    }
    const src = source === 'image' ? p.image : p.panorama;
    if (!src) return null;
    const a = getAnalysis(src.asset.assetId);
    if (!a) return null;
    if (source === 'panorama' && p.panorama) {
      const s = p.panorama.settings;
      return { curve: regionCurve(a.grid, fullMask, { steps, sensitivity: s.sensitivity, strip: s.stripWidth, smoothing: s.smoothing, path: scanPath(s, steps) }), beats: panoramaBeats(s, p.settings) };
    }
    const is = p.image!.settings;
    return { curve: regionCurve(a.grid, fullMask, { steps, sensitivity: is.edgeSensitivity, strip: 0.5, smoothing: is.smoothing }), beats: is.bars * barBeats(p.settings.timeSig) };
  };

  /** Apply a change now, or (while playing) at the next beat/bar/phrase boundary. */
  const atBoundary = (label: string, apply: () => void) => {
    const p = get().project;
    const mode = p.settings.switchAt;
    if (engine.state !== 'playing' || mode === 'now') { apply(); return; }
    const pos = engine.position();
    const bb = barBeats(p.settings.timeSig);
    const unit = mode === 'beat' ? 1 : mode === 'bar' ? bb : bb * 4;
    let at = Math.ceil((pos + 0.05) / unit) * unit;
    const loop = p.settings.loop;
    if (loop.on && at >= loop.end) at = loop.end; // the loop wrap is the boundary
    set((s) => ({ ui: { ...s.ui, pendingRegen: `${label} at ${mode === 'phrase' ? 'next phrase' : `next ${mode}`}` } }));
    engine.queueSwap(`regen:${label}`, at, () => {
      apply();
      set((s) => ({ ui: { ...s.ui, pendingRegen: null } }));
    });
  };

  const store: Store = {
    project: initial,
    past: [],
    future: [],
    ui: {
      tool: 'pencil', brush: defaultBrush(), selectedTrackId: initial.tracks[0].id, selStrokes: [], selNotes: [], showNotes: true,
      inspectorTab: 'source', bottomTab: 'mixer', bottomOpen: true, leftOpen: true, rightOpen: true, toasts: [],
      analysis: { image: { status: 'idle', progress: 0, label: '' }, panorama: { status: 'idle', progress: 0, label: '' } },
      render: { status: 'idle', progress: 0, label: '' }, saveState: 'saved', recording: false, midiStatus: 'MIDI: not connected',
      panoTool: 'scrub', paintRegionId: '', pendingRegen: null, dialog: null, hoverInfo: '',
    },
    setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
    toast: (text, kind = 'info') => {
      const id = ++toastId;
      set((s) => ({ ui: { ...s.ui, toasts: [...s.ui.toasts.slice(-3), { id, kind, text }] } }));
      setTimeout(() => set((s) => ({ ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== id) } })), kind === 'error' ? 9000 : 4500);
    },

    commit: (fn, history = true) => {
      const prev = get().project;
      const next = finish(fn(prev));
      if (next === prev) return;
      set((s) => ({
        project: next,
        past: history ? [...s.past.slice(-HISTORY_LIMIT), prev] : s.past,
        future: history ? [] : s.future,
        ui: { ...s.ui, saveState: 'unsaved' },
      }));
    },
    checkpoint: () => set((s) => ({ past: [...s.past.slice(-HISTORY_LIMIT), s.project], future: [] })),
    undo: () => {
      const { past, project, future } = get();
      if (!past.length) return;
      set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future].slice(0, HISTORY_LIMIT) });
      set((s) => ({ ui: { ...s.ui, saveState: 'unsaved' } }));
    },
    redo: () => {
      const { past, project, future } = get();
      if (!future.length) return;
      set({ project: future[0], future: future.slice(1), past: [...past, project] });
      set((s) => ({ ui: { ...s.ui, saveState: 'unsaved' } }));
    },

    setSettings: (patch) => {
      const p = get().project;
      const pitchChanged = ['key', 'scale', 'customScale'].some((k) => k in patch && JSON.stringify((patch as any)[k]) !== JSON.stringify((p.settings as any)[k]));
      get().commit((pp) => {
        let settings = { ...pp.settings, ...patch };
        if (patch.lengthBars !== undefined || patch.timeSig !== undefined) {
          const oldEnd = projectBeats(pp.settings);
          const newEnd = projectBeats(settings);
          if (Math.abs(pp.settings.loop.end - oldEnd) < 1e-6 || settings.loop.end > newEnd) settings = { ...settings, loop: { ...settings.loop, end: newEnd, start: Math.min(settings.loop.start, Math.max(0, newEnd - 1)) } };
        }
        let next: Project = { ...pp, settings };
        if (pitchChanged) next = remapProject(next);
        if (patch.timeSig !== undefined) next = deriveStrokes(next, new Set(next.strokes.map((s) => s.id)));
        return next;
      });
      if (patch.bpm !== undefined) engine.retempo();
      // a shorter piece should not leave the stopped playhead stranded beyond its end
      const end = projectBeats(get().project.settings);
      if (engine.state !== 'playing' && engine.position() > end) engine.seek(0);
    },
    setWorkspace: (w) => get().commit((p) => ({ ...p, workspace: w }), false),
    rename: (name) => get().commit((p) => ({ ...p, name: name.trim() || 'Untitled' })),
    addTrack: (role = 'melody', patchName) => {
      const id = uid('trk');
      get().commit((p) => ({ ...p, tracks: [...p.tracks, emptyTrack(id, `${role[0].toUpperCase()}${role.slice(1)} ${p.tracks.length + 1}`, role, PALETTE[p.tracks.length % PALETTE.length], patchName)] }));
      get().setUi({ selectedTrackId: id });
      return id;
    },
    removeTrack: (id) => {
      get().commit((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== id), strokes: p.strokes.filter((s) => s.trackId !== id) }));
      const p = get().project;
      if (get().ui.selectedTrackId === id) get().setUi({ selectedTrackId: p.tracks[0]?.id ?? '' });
    },
    updateTrack: (id, fn, history = true) => get().commit((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? fn(t) : t)) }), history),
    setMix: (id, patch, history = true) => get().updateTrack(id, (t) => ({ ...t, mix: { ...t.mix, ...patch } }), history),
    setPatch: (id, patch, history = true) => get().updateTrack(id, (t) => ({ ...t, patch }), history),
    setFx: (id, fx, history = true) => get().updateTrack(id, (t) => ({ ...t, fx }), history),

    addStroke: (s) => {
      const id = uid('stk');
      const stroke: Stroke = { ...s, id, seed: hash32(id) };
      get().commit((p) => deriveStrokes({ ...p, strokes: [...p.strokes, stroke] }, new Set([id])));
      return id;
    },
    replaceStrokes: (strokes, history = true) => {
      const ids = new Set(strokes.map((s) => s.id));
      get().commit((p) => deriveStrokes({ ...p, strokes: p.strokes.map((s) => strokes.find((x) => x.id === s.id) ?? s) }, ids), history);
    },
    deleteStrokes: (ids, history = true) => {
      const set_ = new Set(ids);
      get().commit((p) => deriveStrokes({ ...p, strokes: p.strokes.filter((s) => !set_.has(s.id)) }, new Set(), set_), history);
      get().setUi({ selStrokes: [] });
    },
    duplicateSelection: () => {
      const { ui, project } = get();
      if (!ui.selStrokes.length) return;
      const copies = project.strokes.filter((s) => ui.selStrokes.includes(s.id)).map((s) => {
        const id = uid('stk');
        return { ...s, id, seed: hash32(id), points: s.points.map((pt) => ({ x: pt.x + 1, y: Math.max(0, pt.y - 0.03) })) };
      });
      get().commit((p) => deriveStrokes({ ...p, strokes: [...p.strokes, ...copies] }, new Set(copies.map((c) => c.id))));
      get().setUi({ selStrokes: copies.map((c) => c.id) });
    },
    clearLayer: (trackId) => get().commit((p) => ({
      ...p,
      strokes: p.strokes.filter((s) => s.trackId !== trackId),
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, notes: t.notes.filter((n) => n.origin !== 'drawn'), automation: t.automation.filter((a) => a.origin !== 'drawn') } : t)),
    })),
    clearCanvas: () => get().commit((p) => ({
      ...p, strokes: [],
      tracks: p.tracks.map((t) => ({ ...t, notes: t.notes.filter((n) => n.origin !== 'drawn'), automation: t.automation.filter((a) => a.origin !== 'drawn') })),
    })),
    rederiveAll: () => get().commit((p) => deriveStrokes(p, new Set(p.strokes.map((s) => s.id)))),

    addNote: (trackId, n, origin = 'user') => get().updateTrack(trackId, (t) => ({ ...t, notes: [...t.notes, { ...n, id: uid('n'), origin }].sort((a, b) => a.start - b.start) })),
    updateNotes: (trackId, ids, fn, history = true) => {
      const s = new Set(ids);
      // an edited derived note becomes a user note (detached from its stroke / generator)
      get().updateTrack(trackId, (t) => ({ ...t, notes: t.notes.map((n) => (s.has(n.id) ? { ...fn(n), origin: 'user' as const, strokeId: undefined } : n)) }), history);
    },
    deleteNotes: (trackId, ids, history = true) => {
      const s = new Set(ids);
      get().updateTrack(trackId, (t) => ({ ...t, notes: t.notes.filter((n) => !s.has(n.id)) }), history);
      get().setUi({ selNotes: [] });
    },

    applyLayers: (family, layers, opts = {}) => {
      const p0 = get().project;
      const lockInst = p0.composition.locks.instruments;
      const lockSel = p0.composition.locks.selected;
      get().commit((p) => {
        const keys = new Set(layers.map((l) => l.key));
        let tracks = p.tracks.filter((t) => opts.only || !t.generator || !t.generator.startsWith(family) || keys.has(t.generator) || t.notes.some((n) => n.origin === 'user'));
        for (const l of layers) {
          const existing = tracks.find((t) => t.generator === l.key);
          if (existing) {
            const kept = existing.notes.filter((n) => n.origin === 'user' || n.origin === 'midi' || n.origin === 'drawn' || (lockSel && n.locked));
            const oldGen = existing.notes.filter((n) => !kept.includes(n));
            const blended = blendByBars(oldGen, l.notes, existing.variation ?? 1, barBeats(p.settings.timeSig), existing.seed + hash32(l.key));
            const keptAuto = existing.automation.filter((a) => a.origin === 'drawn' || a.origin === 'modmatrix');
            tracks = tracks.map((t) => (t === existing ? {
              ...t, notes: [...kept, ...blended].sort((a, b) => a.start - b.start), automation: [...keptAuto, ...l.automation],
              patch: lockInst ? t.patch : l.patch, rhythm: l.rhythm ?? t.rhythm, pitch: l.pitch, fx: t.fx.length ? t.fx : l.fx ?? [],
            } : t));
          } else {
            tracks = [...tracks, trackFromLayer(l, uid('trk'), PALETTE[tracks.length % PALETTE.length], hash32(l.key))];
          }
        }
        return { ...p, tracks };
      });
      if (opts.label) get().toast(opts.label, 'ok');
    },

    importImage: async (file, name, kind, preset) => {
      const job = (j: Partial<Job>) => set((s) => ({ ui: { ...s.ui, analysis: { ...s.ui.analysis, [kind]: { ...s.ui.analysis[kind], ...j } } } }));
      job({ status: 'running', progress: 0, label: 'Decoding…', error: undefined });
      try {
        const bmp = await decodeImage(file);
        const assetId = uid('img');
        try { await db.putAsset(assetId, file); } catch (e) { get().toast(`Image kept in memory only: ${(e as Error).message}`, 'error'); }
        await buildLevels(assetId, bmp, kind);
        const asset = { assetId, name, mime: file.type || 'image/png', width: bmp.width, height: bmp.height, bytes: file.size };
        get().commit((p) => kind === 'image'
          ? { ...p, image: { asset, settings: { ...(p.image?.settings ?? defaultImageSettings()), ...(preset as Partial<ImageSettings>) } }, workspace: 'image' }
          : { ...p, panorama: { asset, settings: { ...(p.panorama?.settings ?? defaultPanoramaSettings()), ...(preset as Partial<PanoramaSettings>), genBeats: undefined }, regions: p.panorama?.regions ?? defaultRegions() }, workspace: 'panorama' });
        assetBitmaps.set(assetId, bmp);
        await get().analyze(kind);
      } catch (e) {
        job({ status: 'error', error: (e as Error).message, label: 'Import failed' });
        get().toast((e as Error).message, 'error');
      }
    },
    analyze: async (kind) => {
      const p = get().project;
      const src = kind === 'image' ? p.image : p.panorama;
      if (!src) return;
      const job = (j: Partial<Job>) => set((s) => ({ ui: { ...s.ui, analysis: { ...s.ui.analysis, [kind]: { ...s.ui.analysis[kind], ...j } } } }));
      analysisAborts[kind]?.abort();
      const ac = new AbortController();
      analysisAborts[kind] = ac;
      job({ status: 'running', progress: 0.02, label: 'Analysing…', error: undefined });
      try {
        let bmp = assetBitmaps.get(src.asset.assetId);
        if (!bmp) {
          const blob = await db.getAsset(src.asset.assetId);
          if (!blob) throw new Error('The source image is missing from browser storage. Re-import it or open the portable project file.');
          bmp = await decodeImage(blob);
          assetBitmaps.set(src.asset.assetId, bmp);
          await buildLevels(src.asset.assetId, bmp, kind);
        }
        const is = p.image?.settings ?? defaultImageSettings();
        await analyzeBitmap(src.asset.assetId, bmp, {
          kind, signal: ac.signal,
          contours: { sensitivity: is.edgeSensitivity, minLength: is.minContour, detail: is.detail, maxGestures: 80 },
          onProgress: (f, stage) => job({ progress: f, label: stage === 'tiles' ? 'Reading image tiles…' : stage === 'features' ? 'Measuring colour, light and texture…' : stage === 'contours' ? 'Tracing contours…' : 'Done' }),
        });
        job({ status: 'done', progress: 1, label: 'Analysis ready' });
        // the full-resolution bitmap is no longer needed once tiles + display levels exist
        bmp.close();
        assetBitmaps.delete(src.asset.assetId);
        if (kind === 'image') get().generateImage();
        else get().generatePanorama();
      } catch (e) {
        if (e instanceof AnalysisCancelled) { job({ status: 'idle', label: 'Analysis cancelled', progress: 0 }); return; }
        job({ status: 'error', error: (e as Error).message, label: 'Analysis failed' });
        get().toast((e as Error).message, 'error');
      }
    },
    cancelAnalysis: (kind) => analysisAborts[kind]?.abort(),
    setImageSettings: (patch, regenerate = false) => {
      const before = get().project.image?.settings;
      get().commit((p) => (p.image ? { ...p, image: { ...p.image, settings: { ...p.image.settings, ...patch } } } : p));
      const p = get().project;
      if (!p.image || !regenerate) return;
      const contourChange = before && (patch.edgeSensitivity !== undefined || patch.minContour !== undefined || patch.detail !== undefined) &&
        (before.edgeSensitivity !== p.image.settings.edgeSensitivity || before.minContour !== p.image.settings.minContour || before.detail !== p.image.settings.detail);
      if (contourChange && getAnalysis(p.image.asset.assetId)) {
        const s = p.image.settings;
        rerunContours(p.image.asset.assetId, { sensitivity: s.edgeSensitivity, minLength: s.minContour, detail: s.detail, maxGestures: 80 })
          .then(() => get().generateImage()).catch((e) => get().toast((e as Error).message, 'error'));
      } else get().generateImage();
    },
    generateImage: (only) => {
      const p = get().project;
      if (!p.image) return;
      const a = getAnalysis(p.image.asset.assetId);
      if (!a) { get().toast('Analyse the image first.', 'error'); return; }
      const layers = generateImageLayers(a, p.image.settings, p.settings, only);
      atBoundary('image', () => {
        get().applyLayers('image:', layers, { only });
        const bars = p.image!.settings.bars;
        if (!only && get().project.settings.lengthBars < bars) get().setSettings({ lengthBars: bars });
        get().bakeModMatrix();
      });
    },
    setPanoramaSettings: (patch) => get().commit((p) => (p.panorama ? { ...p, panorama: { ...p.panorama, settings: { ...p.panorama.settings, ...patch } } } : p)),
    setRegions: (regions, history = true) => get().commit((p) => (p.panorama ? { ...p, panorama: { ...p.panorama, regions } } : p), history),
    generatePanorama: (only) => {
      const p = get().project;
      if (!p.panorama) return;
      const a = getAnalysis(p.panorama.asset.assetId);
      if (!a) { get().toast('Analyse the panorama first.', 'error'); return; }
      const layers = generatePanoramaLayers(a.grid, p.panorama, p.settings, only);
      atBoundary('panorama', () => {
        get().applyLayers('pano:', layers, { only });
        const pp = get().project;
        const beats = panoramaBeats(pp.panorama!.settings, pp.settings);
        const bars = Math.ceil(beats / barBeats(pp.settings.timeSig) - 1e-6);
        if (!only) {
          get().setSettings({ lengthBars: bars, loop: { on: pp.settings.loop.on, start: 0, end: beats } });
          get().commit((q) => (q.panorama ? { ...q, panorama: { ...q.panorama, settings: { ...q.panorama.settings, genBeats: beats } } } : q), false);
        }
        get().bakeModMatrix();
      });
    },
    setComposition: (patch) => get().commit((p) => ({ ...p, composition: { ...p.composition, ...patch, locks: { ...p.composition.locks, ...(patch.locks ?? {}) } } })),
    generateComposition: (only, applyTempo = false) => {
      const p = get().project;
      const c = p.composition;
      const guide = c.source === 'none' ? undefined : curveFor(p, c.source)?.curve;
      if (c.source !== 'none' && !guide) get().toast(`No ${c.source} source yet — composing from the seed alone.`, 'info');
      const previous = new Map(p.tracks.filter((t) => t.generator?.startsWith('gen:')).map((t) => [t.generator!, { notes: t.notes, rhythm: t.rhythm }]));
      const rhythms = new Map(p.tracks.filter((t) => t.generator?.startsWith('gen:') && only === t.generator).map((t) => [t.generator!, t.rhythm]));
      const res = compose({ comp: c, settings: p.settings, guide, previous, previousHarmony: lastHarmony, only, rhythms });
      lastHarmony = res.harmony;
      lastSections = res.sections;
      atBoundary('composition', () => {
        get().applyLayers('gen:', res.layers, { only });
        if (!only) {
          const patch: Partial<ProjectSettings> = { lengthBars: c.bars };
          if (applyTempo) patch.bpm = res.bpm;
          get().setSettings(patch);
          const bb = barBeats(get().project.settings.timeSig);
          get().commit((pp) => ({ ...pp, markers: res.sections.map((s) => ({ beat: s.start, label: s.name })), settings: { ...pp.settings, loop: { ...pp.settings.loop, start: 0, end: c.bars * bb } } }), false);
        }
      });
    },
    regenerateTrack: (trackId, newSeed = true) => {
      const t = get().project.tracks.find((x) => x.id === trackId);
      if (!t?.generator) { get().toast('This track was not generated — nothing to regenerate.', 'info'); return; }
      const g = t.generator;
      // a per-track seed bump changes only this layer (the family seed is folded in)
      if (newSeed) get().updateTrack(trackId, (x) => ({ ...x, seed: (x.seed + 7919) >>> 0 }), true);
      const seedBump = get().project.tracks.find((x) => x.id === trackId)!.seed;
      const p = get().project;
      if (g.startsWith('gen:')) {
        const c = { ...p.composition, seed: (p.composition.seed + seedBump) >>> 0, locks: { ...p.composition.locks, harmony: true } };
        const res = compose({ comp: c, settings: p.settings, previous: new Map([[g, { notes: t.notes, rhythm: t.rhythm }]]), previousHarmony: lastHarmony, only: g, rhythms: new Map([[g, t.rhythm]]) });
        atBoundary('track', () => get().applyLayers('gen:', res.layers, { only: g }));
      } else if (g.startsWith('image:') && p.image) {
        const a = getAnalysis(p.image.asset.assetId);
        if (!a) { get().toast('Analyse the image first.', 'error'); return; }
        const layers = generateImageLayers(a, { ...p.image.settings, seed: (p.image.settings.seed + seedBump) >>> 0 }, p.settings, g);
        atBoundary('track', () => get().applyLayers('image:', layers, { only: g }));
      } else if (g.startsWith('pano:') && p.panorama) {
        const a = getAnalysis(p.panorama.asset.assetId);
        if (!a) { get().toast('Analyse the panorama first.', 'error'); return; }
        const src = { ...p.panorama, settings: { ...p.panorama.settings, seed: (p.panorama.settings.seed + seedBump) >>> 0 } };
        atBoundary('track', () => get().applyLayers('pano:', generatePanoramaLayers(a.grid, src, p.settings, g), { only: g }));
      }
    },
    setTrackRhythm: (trackId, r) => get().updateTrack(trackId, (t) => ({ ...t, rhythm: { ...t.rhythm, ...r } })),
    bakeModMatrix: () => {
      const p = get().project;
      if (!p.modRoutes.length && !p.tracks.some((t) => t.automation.some((a) => a.origin === 'modmatrix'))) return;
      const curves = { image: curveFor(p, 'image', 512), panorama: curveFor(p, 'panorama', 512) };
      get().commit((pp) => ({
        ...pp,
        tracks: pp.tracks.map((t) => {
          const routes = pp.modRoutes.filter((r) => r.trackId === t.id);
          const lanes = routes.map((r) => { const c = curves[r.from]; return c ? bakeRoute(r, c.curve, c.beats) : null; }).filter((x): x is NonNullable<typeof x> => !!x);
          const others = t.automation.filter((a) => a.origin !== 'modmatrix');
          if (!lanes.length && others.length === t.automation.length) return t;
          return { ...t, automation: [...others, ...lanes] };
        }),
      }), false);
    },
    regenerateOrbital: () => {
      const p = get().project;
      const track = p.tracks.find((t) => t.id === p.orbital.trackId);
      if (!track) return;
      const { notes, pan } = orbitalNotes(p.orbital, track, p.settings);
      get().updateTrack(track.id, (t) => ({
        ...t, notes: [...t.notes.filter((n) => n.origin !== 'orbital'), ...notes].sort((a, b) => a.start - b.start),
        automation: [...t.automation.filter((a) => a.id !== 'orbital_pan'), ...(pan ? [pan] : [])],
      }));
    },
    regenerateParticles: () => {
      const p = get().project;
      const sim = simulateParticles(p.particles, p.tracks, p.settings);
      get().commit((pp) => ({
        ...pp,
        tracks: pp.tracks.map((t) => {
          const add = sim.notes.get(t.id) ?? [];
          const had = t.notes.some((n) => n.origin === 'particle');
          if (!add.length && !had) return t;
          return { ...t, notes: [...t.notes.filter((n) => n.origin !== 'particle'), ...add.map((n) => ({ ...n, id: `${t.id}_${n.id}` }))].sort((a, b) => a.start - b.start) };
        }),
      }));
    },

    saveScene: (name) => get().commit((p) => ({ ...p, scenes: [...p.scenes, captureScene(p, uid('scn'), name || `Scene ${p.scenes.length + 1}`)] })),
    recallScene: (id) => {
      const sc = get().project.scenes.find((s) => s.id === id);
      if (!sc) return;
      atBoundary('scene', () => get().commit((p) => ({ ...p, tracks: structuredClone(sc.tracks), settings: { ...p.settings, lengthBars: sc.bars } })));
    },
    deleteScene: (id) => get().commit((p) => ({ ...p, scenes: p.scenes.filter((s) => s.id !== id), arrangement: p.arrangement.filter((e) => e.sceneId !== id) })),
    setArrangement: (entries) => get().commit((p) => ({ ...p, arrangement: entries })),
    printArrangement: () => {
      const p = get().project;
      if (!p.arrangement.length) { get().toast('Add scenes to the arrangement first.', 'info'); return; }
      const { tracks, bars } = printArrangement(p, p.arrangement);
      const bb = barBeats(p.settings.timeSig);
      let at = 0;
      const markers = p.arrangement.flatMap((e) => { const sc = p.scenes.find((s) => s.id === e.sceneId); if (!sc) return []; const m = { beat: at, label: sc.name }; at += sc.bars * bb * Math.max(1, e.repeats); return [m]; });
      get().commit((pp) => ({ ...pp, tracks, markers, settings: { ...pp.settings, lengthBars: bars, loop: { on: false, start: 0, end: bars * bb } } }));
      get().toast(`Arrangement printed: ${bars} bars`, 'ok');
    },

    loadProject: async (raw, assets = []) => {
      engine.stop();
      const p = normalizeProject(raw);
      for (const a of assets) { try { await db.putAsset(a.id, a.blob); } catch { /* memory only */ } }
      set((s) => ({ project: p, past: [], future: [], ui: { ...s.ui, selectedTrackId: p.tracks[0]?.id ?? '', selStrokes: [], selNotes: [], saveState: 'unsaved', analysis: { image: { status: 'idle', progress: 0, label: '' }, panorama: { status: 'idle', progress: 0, label: '' } } } }));
      lastHarmony = undefined;
      db.setLastProjectId(p.id);
      // rebuild display levels + analysis from stored assets (notes are already in the project)
      for (const kind of ['image', 'panorama'] as const) {
        const src = p[kind];
        if (!src) continue;
        const blob = assets.find((a) => a.id === src.asset.assetId)?.blob ?? (await db.getAsset(src.asset.assetId).catch(() => undefined));
        if (!blob) { get().toast(`The ${kind} for this project is missing from browser storage.`, 'error'); continue; }
        reanalyze(kind, blob, src.asset.assetId);
      }
      engine.sync();
    },
    newProject: () => {
      engine.stop();
      const p = newProject('Untitled');
      set((s) => ({ project: p, past: [], future: [], ui: { ...s.ui, selectedTrackId: p.tracks[0].id, selStrokes: [], selNotes: [], saveState: 'unsaved' } }));
      db.setLastProjectId(p.id);
    },
    saveNow: async () => {
      const p = get().project;
      set((s) => ({ ui: { ...s.ui, saveState: 'saving' } }));
      try {
        await db.saveProject(p);
        db.setLastProjectId(p.id);
        if (get().project === p) set((s) => ({ ui: { ...s.ui, saveState: 'saved' } }));
      } catch (e) {
        set((s) => ({ ui: { ...s.ui, saveState: 'error' } }));
        get().toast((e as Error).message, 'error');
      }
    },
  };
  return store;

  async function reanalyze(kind: 'image' | 'panorama', blob: Blob, assetId: string) {
    try {
      const bmp = await decodeImage(blob);
      await buildLevels(assetId, bmp, kind);
      const is = get().project.image?.settings ?? defaultImageSettings();
      set((s) => ({ ui: { ...s.ui, analysis: { ...s.ui.analysis, [kind]: { status: 'running', progress: 0.1, label: 'Re-analysing stored image…' } } } }));
      await analyzeBitmap(assetId, bmp, { kind, contours: { sensitivity: is.edgeSensitivity, minLength: is.minContour, detail: is.detail, maxGestures: 80 } });
      bmp.close();
      set((s) => ({ ui: { ...s.ui, analysis: { ...s.ui.analysis, [kind]: { status: 'done', progress: 1, label: 'Analysis ready' } } } }));
    } catch (e) {
      set((s) => ({ ui: { ...s.ui, analysis: { ...s.ui.analysis, [kind]: { status: 'error', progress: 0, label: 'Analysis failed', error: (e as Error).message } } } }));
    }
  }
});

let lastHarmony: ReturnType<typeof compose>['harmony'] | undefined;
export let lastSections: ReturnType<typeof compose>['sections'] = [];
export const getHarmony = () => lastHarmony;
const assetBitmaps = new Map<string, ImageBitmap>();

/** The single live engine; it reads the current project on every scheduler tick. */
export const engine = new LiveEngine(() => useStore.getState().project);

// keep the audio graph in step with mix/patch/fx changes
let lastTracksRef: Track[] | null = null;
let lastSettingsRef: ProjectSettings | null = null;
useStore.subscribe((s) => {
  if (s.project.tracks !== lastTracksRef || s.project.settings !== lastSettingsRef) {
    lastTracksRef = s.project.tracks;
    lastSettingsRef = s.project.settings;
    engine.sync();
  }
});

// autosave (debounced) to IndexedDB
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaved: Project | null = null;
useStore.subscribe((s) => {
  if (s.project === lastSaved) return;
  if (s.ui.saveState !== 'unsaved') return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { lastSaved = useStore.getState().project; void useStore.getState().saveNow(); }, 1500);
});

export const selectedTrack = (s: { project: Project; ui: UIState }) => s.project.tracks.find((t) => t.id === s.ui.selectedTrackId) ?? s.project.tracks[0];

export { remapTrack, regionMask, instrument };
