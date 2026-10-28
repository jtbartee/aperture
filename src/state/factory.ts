// Original factory projects. All artwork is procedurally generated here — no third-party images.
import type { Project, Stroke } from '../core/types';
import { hash32 } from '../core/rng';
import { useStore } from './store';
import { newProject } from './project';
import { emptyTrack, PALETTE, fxSlot } from '../interpret/layers';
import { defaultBrush, shapePoints } from '../interpret/strokes';
import { deriveAll } from '../interpret/derive';
import { colorfulTexture, hazeImage, panoramaLandscape } from '../analysis/procedural';
import { rgbaToPng } from '../analysis/client';
import { defaultComposition } from '../interpret/composer';
import { defaultRegions } from '../interpret/panorama';

export type FactoryId = 'geometry' | 'haze' | 'motorik' | 'fragmented' | 'panorama';

export const FACTORY: { id: FactoryId; name: string; mode: string; style: string; description: string }[] = [
  { id: 'geometry', name: 'Geometry in Motion', mode: 'Draw', style: 'Minimal electronic', description: 'Rectangles hold drones, an ellipse arpeggiates, lines rise into phrases, dot rows become rhythm.' },
  { id: 'haze', name: 'Infinite Haze', mode: 'Image', style: 'Ambient drone', description: 'A generated luminous haze read atmospherically: colour sets the chords, light opens the Image Synth drone as the scan passes the glows.' },
  { id: 'motorik', name: 'Motorik Machine', mode: 'Generative', style: 'Krautrock', description: 'A locked pulse, eighth-note bass and arpeggios that mutate and open up over 64 bars.' },
  { id: 'fragmented', name: 'Fragmented Signals', mode: 'Generative', style: 'IDM / glitch in 7/8', description: 'Changing subdivisions, stutters and polymetric layers (7- and 13-step patterns).' },
  { id: 'panorama', name: 'Panoramic Journey', mode: 'Panorama', style: 'Ambient / cinematic', description: 'A generated six-zone landscape scrolls for four minutes: the ridgelines sing as contour voices over an evolving image-synth drone, and each zone changes the timbre.' },
];

function stroke(trackId: string, points: { x: number; y: number }[], brush: Partial<Stroke['brush']>, shape: Stroke['shape'] = 'freehand', id: string): Stroke {
  return { id, trackId, shape, brush: defaultBrush(brush), points, seed: hash32(id) };
}

function geometry(): Project {
  const p = newProject('Geometry in Motion');
  p.settings = { ...p.settings, bpm: 118, key: 2, scale: 'dorian', lengthBars: 8, loop: { on: true, start: 0, end: 32 } };
  const lead = emptyTrack('geo_lead', 'Lead', 'melody', PALETTE[0], 'Hollow Pulse');
  lead.fx = [fxSlot('pingpong', { time: 0.38, feedback: 0.35, wet: 0.22 }, 'geo_fx_pp')];
  const pad = emptyTrack('geo_pad', 'Pad', 'pad', PALETTE[2], 'Analog Haze');
  pad.fx = [fxSlot('atmosSweep', { mix: 0.35 }, 'geo_fx_sweep')];
  const bass = emptyTrack('geo_bass', 'Bass', 'bass', PALETTE[1], 'Analog Mono Bass');
  const drums = emptyTrack('geo_drums', 'Drums', 'percussion', PALETTE[4], 'Drum Kit');
  p.tracks = [lead, bass, pad, drums];
  const S: Stroke[] = [];
  let k = 0;
  const id = () => `geo_s${k++}`;
  // pad: two rectangles held as drones
  S.push(stroke(pad.id, shapePoints('rect', { x: 0, y: 0.3 }, { x: 16, y: 0.52 }), { kind: 'drone', size: 3, velocity: 0.6 }, 'rect', id()));
  S.push(stroke(pad.id, shapePoints('rect', { x: 16, y: 0.38 }, { x: 32, y: 0.62 }), { kind: 'drone', size: 3, velocity: 0.6 }, 'rect', id()));
  // lead: ellipse arpeggio, rising line, zig-zag, falling arc
  S.push(stroke(lead.id, shapePoints('ellipse', { x: 0, y: 0.35 }, { x: 8, y: 0.75 }), { kind: 'arpeggio', density: 4, velocity: 0.6, arpPattern: 'updown' }, 'ellipse', id()));
  S.push(stroke(lead.id, [{ x: 8, y: 0.25 }, { x: 15.5, y: 0.85 }], { kind: 'legato', density: 2 }, 'line', id()));
  S.push(stroke(lead.id, [16, 17, 18, 19, 20, 21, 22, 23].map((x, i) => ({ x, y: i % 2 ? 0.7 : 0.45 })), { kind: 'note', density: 2, articulation: 'staccato' }, 'freehand', id()));
  S.push(stroke(lead.id, Array.from({ length: 17 }, (_, i) => ({ x: 24 + i * 0.5, y: 0.8 - Math.sin((i / 16) * Math.PI) * 0.15 - i * 0.025 })), { kind: 'legato', density: 4 }, 'curve', id()));
  // bass: dotted dots
  for (let b = 0; b < 32; b += 1.5) S.push(stroke(bass.id, [{ x: b, y: Math.floor(b / 8) % 2 ? 0.42 : 0.3 }], { kind: 'note', duration: 2, density: 4, velocity: 0.8 }, 'dot', id()));
  // drums: rows = kick, click, snare, noise, closed hat, open hat, metal
  const row = (i: number) => i / 6;
  S.push(stroke(drums.id, [{ x: 0, y: row(0) }, { x: 31.9, y: row(0) }], { kind: 'rhythm', density: 1, velocity: 0.9 }, 'line', id()));
  S.push(stroke(drums.id, [{ x: 0, y: row(4) }, { x: 31.9, y: row(4) }], { kind: 'rhythm', density: 4, velocity: 0.45, probability: 0.8 }, 'line', id()));
  for (let b = 1; b < 32; b += 2) S.push(stroke(drums.id, [{ x: b, y: row(2) }], { kind: 'rhythm', density: 4, velocity: 0.8 }, 'dot', id()));
  S.push(stroke(drums.id, [{ x: 0.75, y: row(1) }, { x: 31.9, y: row(1) }], { kind: 'rhythm', density: 2, velocity: 0.5, probability: 0.45 }, 'line', id()));
  for (let b = 7.5; b < 32; b += 8) S.push(stroke(drums.id, [{ x: b, y: row(5) }], { kind: 'rhythm', density: 4, velocity: 0.55 }, 'dot', id()));
  p.strokes = S;
  p.orbital.voices[0].trackId = lead.id;
  return deriveAll(p);
}

function blankFor(name: string, workspace: Project['workspace']): Project {
  const p = newProject(name);
  p.tracks = [];
  p.workspace = workspace;
  return p;
}

export async function loadFactory(id: FactoryId) {
  const st = useStore.getState();
  switch (id) {
    case 'geometry': {
      await st.loadProject(geometry());
      break;
    }
    case 'haze': {
      const p = blankFor('Infinite Haze', 'image');
      p.settings = { ...p.settings, bpm: 64, key: 4, scale: 'lydian', lengthBars: 24, loop: { on: true, start: 0, end: 96 } };
      await st.loadProject(p);
      const blob = await rgbaToPng(hazeImage(1280, 800, 11));
      await st.importImage(blob, 'infinite-haze.png', 'image', { mode: 'atmos', bars: 24, density: 0.45, smoothing: 0.5, seed: 3 });
      break;
    }
    case 'motorik': {
      const p = blankFor('Motorik Machine', 'generative');
      p.settings = { ...p.settings, key: 9, scale: 'dorian' };
      p.composition = { ...defaultComposition(), style: 'motorik', structure: 'mutation', bars: 64, seed: 7, evolution: 0.75, mutation: 0.4, density: 0.6, complexity: 0.55 };
      await st.loadProject(p);
      useStore.getState().generateComposition(undefined, true);
      break;
    }
    case 'fragmented': {
      const p = blankFor('Fragmented Signals', 'generative');
      p.settings = { ...p.settings, timeSig: '7/8', key: 6, scale: 'minor' };
      p.composition = { ...defaultComposition(), style: 'idm', structure: 'contrast', bars: 48, seed: 13, irregularity: 0.75, complexity: 0.7, mutation: 0.5, density: 0.6 };
      await st.loadProject(p);
      useStore.getState().generateComposition(undefined, true);
      break;
    }
    case 'panorama': {
      const p = blankFor('Panoramic Journey', 'panorama');
      p.settings = { ...p.settings, bpm: 80, key: 2, scale: 'minor' };
      p.panorama = undefined;
      await st.loadProject(p);
      st.toast('Painting a 4800-pixel landscape…', 'info');
      await new Promise((r) => setTimeout(r, 30));
      const blob = await rgbaToPng(panoramaLandscape(4800, 900, 7));
      await useStore.getState().importImage(blob, 'panoramic-journey.png', 'panorama', { timing: 'free', seconds: 240, scanResolution: 384, density: 0.42, evolution: 0.85, seed: 2 });
      // the classic region roles stay configured (switch them on under Sonification layers)
      const s = useStore.getState();
      if (s.project.panorama) s.setRegions(defaultRegions().map((r) => ({ ...r, enabled: true })), false);
      break;
    }
  }
  useStore.getState().setUi({ saveState: 'unsaved', selectedTrackId: useStore.getState().project.tracks[0]?.id ?? '' });
}

export async function loadProceduralImage(kind: 'haze' | 'texture') {
  const img = kind === 'haze' ? hazeImage(1200, 800, 5) : colorfulTexture(1200, 800, 9);
  const blob = await rgbaToPng(img);
  await useStore.getState().importImage(blob, kind === 'haze' ? 'generated-haze.png' : 'generated-texture.png', 'image');
}
