import type { HarmonySettings, OrbitalSource, OrbitalVoice, Project, ProjectSettings } from '../core/types';
import { uid } from '../core/ids';
import { barBeats } from '../core/time';
import { defaultComposition } from '../interpret/composer';
import { defaultImageSettings } from '../interpret/imageModes';
import { defaultPanoramaSettings, defaultRegions } from '../interpret/panorama';
import { defaultParticles } from '../interpret/particles';
import { defaultOrbitalVoice } from '../interpret/orbital';
import { defaultHarmony } from '../theory/context';
import { emptyTrack, PALETTE } from '../interpret/layers';
import { fxSlot } from '../interpret/layers';
import { legacyShape } from '../interpret/sonify';
import { contourPreset } from '../analysis/contours';

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
    harmony: defaultHarmony(),
    orbital: { voices: [defaultOrbitalVoice(lead.id)], active: 'orb_1' },
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
    harmony: normalizeHarmony(raw),
    orbital: normalizeOrbital(raw?.orbital, base.orbital),
    particles: { ...base.particles, ...(raw?.particles ?? {}) },
    tracks: Array.isArray(raw?.tracks) ? raw.tracks : base.tracks,
    strokes: Array.isArray(raw?.strokes) ? raw.strokes : [],
    modRoutes: Array.isArray(raw?.modRoutes) ? raw.modRoutes : [],
    scenes: Array.isArray(raw?.scenes) ? raw.scenes : [],
    arrangement: Array.isArray(raw?.arrangement) ? raw.arrangement : [],
    markers: Array.isArray(raw?.markers) ? raw.markers : [],
  };
  if (p.image) p.image = { ...p.image, settings: normalizeImageSettings(p.image.settings) };
  if (p.panorama) p.panorama = { ...p.panorama, settings: normalizePanoramaSettings(p.panorama.settings), regions: p.panorama.regions?.length ? p.panorama.regions : defaultRegions() };
  const firstTrack = p.tracks[0]?.id ?? '';
  p.orbital = { ...p.orbital, voices: p.orbital.voices.map((v) => (p.tracks.some((t) => t.id === v.trackId) ? v : { ...v, trackId: firstTrack })) };
  if (!p.orbital.voices.some((v) => v.id === p.orbital.active)) p.orbital.active = p.orbital.voices[0]?.id ?? '';
  return p;
}

/** Projects saved before the shared harmony existed: their composer lock becomes the harmony lock;
 *  the timeline itself was never saved, so it starts empty (the next generation writes it). */
function normalizeHarmony(raw: any): HarmonySettings {
  const def = defaultHarmony();
  const h = raw?.harmony;
  if (!h) return { ...def, lock: !!raw?.composition?.locks?.harmony };
  return { ...def, ...h, slots: Array.isArray(h.slots) ? h.slots : [] };
}

/** Orbital sources saved before voices existed become one voice that keeps the original
 *  behaviour: radius → scale rows, a single revolution. */
function normalizeOrbital(raw: any, base: OrbitalSource): OrbitalSource {
  if (!raw) return base;
  if (Array.isArray(raw.voices) && raw.voices.length) {
    const voices: OrbitalVoice[] = raw.voices.map((v: any, i: number) => ({ ...defaultOrbitalVoice(v?.trackId ?? '', v?.id ?? `orb_${i + 1}`), ...v, strokes: Array.isArray(v?.strokes) ? v.strokes : [] }));
    return { voices, active: raw.active ?? voices[0].id };
  }
  const legacy: OrbitalVoice = { ...defaultOrbitalVoice(raw.trackId ?? '', 'orb_1'), bars: raw.bars ?? 4, direction: raw.direction ?? 'cw', strokes: Array.isArray(raw.strokes) ? raw.strokes : [], pitch: 'scale', fill: false };
  return { voices: [legacy], active: 'orb_1' };
}

/** Settings saved before the sonification overhaul have no rhythm mode. They keep the behaviour
 *  they were made with (metric percussion, preset instruments, classic hybrid layers) so that
 *  regenerating an older piece does not silently turn it into something else. Their old contour
 *  sliders carry over into the new contour settings. */
export function normalizeImageSettings(raw: any): ReturnType<typeof defaultImageSettings> {
  const def = defaultImageSettings();
  const legacy = raw && raw.rhythm === undefined;
  const base = legacy ? { ...def, ...legacyShape(), hybrid: { ...def.hybrid, atmosphere: false, bass: true, pads: true } } : def;
  const contour = raw?.contour ?? (legacy
    ? { ...contourPreset('photo'), preset: 'custom' as const, sensitivity: raw?.edgeSensitivity ?? 0.55, minLength: raw?.minContour ?? 24, detail: raw?.detail ?? 0.5 }
    : def.contour);
  const out: any = { ...base, ...(raw ?? {}), contour: { ...def.contour, ...contour }, hybrid: { ...base.hybrid, ...(raw?.hybrid ?? {}) }, synthMap: Array.isArray(raw?.synthMap) ? raw.synthMap : base.synthMap };
  for (const k of ['edgeSensitivity', 'minContour', 'detail', 'grouping']) delete out[k];
  return out;
}

export function normalizePanoramaSettings(raw: any): ReturnType<typeof defaultPanoramaSettings> {
  const def = defaultPanoramaSettings();
  const legacy = raw && raw.layers === undefined;
  const base = legacy ? { ...def, ...legacyShape(), layers: { contours: false, atmosphere: false, events: false, regions: true } } : def;
  return { ...base, ...(raw ?? {}), layers: { ...base.layers, ...(raw?.layers ?? {}) }, contour: { ...def.contour, ...(raw?.contour ?? {}) }, synthMap: Array.isArray(raw?.synthMap) ? raw.synthMap : base.synthMap };
}

export const projectLengthBeats = (p: Project) => p.settings.lengthBars * barBeats(p.settings.timeSig);
