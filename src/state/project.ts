import type { Project, ProjectSettings } from '../core/types';
import { uid } from '../core/ids';
import { barBeats } from '../core/time';
import { defaultComposition } from '../interpret/composer';
import { defaultImageSettings } from '../interpret/imageModes';
import { defaultPanoramaSettings, defaultRegions } from '../interpret/panorama';
import { defaultParticles } from '../interpret/particles';
import { emptyTrack, PALETTE } from '../interpret/layers';
import { fxSlot } from '../interpret/layers';

export function defaultSettings(): ProjectSettings {
  return {
    bpm: 96, timeSig: '4/4', key: 9, scale: 'minor', customScale: [0, 2, 3, 7, 9], swing: 0, swingGrid: 16, quantize: 4,
    lengthBars: 8, loop: { on: true, start: 0, end: 32 }, metronome: false, switchAt: 'bar', tail: 4,
  };
}

export function newProject(name = 'Untitled'): Project {
  const now = Date.now();
  const lead = emptyTrack(uid('trk'), 'Lead', 'melody', PALETTE[0], 'Plucked Synth');
  lead.fx = [fxSlot('pingpong', { wet: 0.18 })];
  lead.mix.delay = 0.1;
  const bass = emptyTrack(uid('trk'), 'Bass', 'bass', PALETTE[1], 'Analog Mono Bass');
  const pad = emptyTrack(uid('trk'), 'Pad', 'pad', PALETTE[2], 'Warm Analog Pad');
  const drums = emptyTrack(uid('trk'), 'Drums', 'percussion', PALETTE[4], 'Drum Kit');
  return {
    format: 'aperture-project', version: 1, id: uid('prj'), name, created: now, modified: now,
    settings: defaultSettings(),
    tracks: [lead, bass, pad, drums],
    strokes: [],
    composition: defaultComposition(),
    orbital: { bars: 4, direction: 'cw', trackId: lead.id, strokes: [] },
    particles: defaultParticles(),
    modRoutes: [],
    scenes: [],
    arrangement: [],
    markers: [],
    workspace: 'draw',
  };
}

/** Fill in anything missing from an older or hand-edited project. */
export function normalizeProject(raw: any): Project {
  const base = newProject(raw?.name ?? 'Imported');
  const p: Project = {
    ...base,
    ...raw,
    format: 'aperture-project',
    version: 1,
    settings: { ...base.settings, ...(raw?.settings ?? {}), loop: { ...base.settings.loop, ...(raw?.settings?.loop ?? {}) } },
    composition: { ...base.composition, ...(raw?.composition ?? {}), locks: { ...base.composition.locks, ...(raw?.composition?.locks ?? {}) } },
    orbital: { ...base.orbital, ...(raw?.orbital ?? {}) },
    particles: { ...base.particles, ...(raw?.particles ?? {}) },
    tracks: Array.isArray(raw?.tracks) ? raw.tracks : base.tracks,
    strokes: Array.isArray(raw?.strokes) ? raw.strokes : [],
    modRoutes: Array.isArray(raw?.modRoutes) ? raw.modRoutes : [],
    scenes: Array.isArray(raw?.scenes) ? raw.scenes : [],
    arrangement: Array.isArray(raw?.arrangement) ? raw.arrangement : [],
    markers: Array.isArray(raw?.markers) ? raw.markers : [],
  };
  if (p.image) p.image = { ...p.image, settings: { ...defaultImageSettings(), ...p.image.settings } };
  if (p.panorama) p.panorama = { ...p.panorama, settings: { ...defaultPanoramaSettings(), ...p.panorama.settings }, regions: p.panorama.regions?.length ? p.panorama.regions : defaultRegions() };
  if (!p.orbital.trackId || !p.tracks.some((t) => t.id === p.orbital.trackId)) p.orbital.trackId = p.tracks[0]?.id ?? '';
  return p;
}

export const projectLengthBeats = (p: Project) => p.settings.lengthBars * barBeats(p.settings.timeSig);
