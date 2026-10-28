// Project-level musical plumbing, pure (no audio): the shared musical context of a project, how
// sequencers re-read it, how a generator publishes its harmony, and how an image or panorama source
// leaves a project. The store composes these into undoable commits; tests call them directly.

import type { AutomationLane, ChordSlot, HarmonySettings, NoteEvent, Project, Track } from '../core/types';
import { hash32, rng } from '../core/rng';
import { barBeats, projectBeats } from '../core/time';
import { deriveHarmonic } from '../interpret/derive';
import type { MusicInput } from '../interpret/imageModes';
import { orbitalNotes } from '../interpret/orbital';
import { simulateParticles, soundingIndex } from '../interpret/particles';
import { musicalContext, type MusicalContext } from '../theory/context';
import { diatonicChord } from '../theory/chords';
import { generateProgression, type ProgressionType } from '../theory/progression';
import { MODAL_SCALES, scaleFamily } from '../theory/scales';

/** Sections from the arrangement markers. */
function sectionsOf(p: Project) {
  const ms = [...p.markers].sort((a, b) => a.beat - b.beat);
  const end = projectBeats(p.settings);
  return ms.map((m, i) => ({ start: m.beat, end: ms[i + 1]?.beat ?? end, name: m.label }));
}

/** The Musical Intelligence Engine's view of a project: key, scale, behaviour, harmony, sections. */
export const projectContext = (p: Project): MusicalContext => musicalContext(p.settings, p.harmony, sectionsOf(p));

/** What image/panorama generation receives from the shared harmony. */
export const musicInput = (p: Project): MusicInput => ({ slots: p.harmony.lock ? p.harmony.slots : undefined, behavior: p.harmony.behavior, colour: p.harmony.colour, seed: p.harmony.seed });

/** One tonic chord for the whole length: what a source that does not follow chord changes publishes. */
export function tonicTimeline(p: Project, beats: number): ChordSlot[] {
  const chord = diatonicChord(0, p.settings.key, p.settings.scale, 3, p.settings.customScale);
  return [{ start: 0, dur: Math.max(1, beats), chord, bassPc: p.settings.key, func: 'tonic', tension: 0, size: 3 }];
}

/** The harmony panel's own progression choice for "Auto": modes vamp, tonal scales move by function. */
export function autoProgression(p: Project): ProgressionType {
  const fam = scaleFamily(p.settings.scale, p.settings.customScale);
  if (MODAL_SCALES.has(p.settings.scale)) return 'modal';
  if (fam === 'symmetric' || fam === 'chromatic' || fam === 'other') return 'sparse';
  return 'diatonic';
}

/** A timeline written by the harmony panel itself, across the project. */
export function panelTimeline(p: Project): ChordSlot[] {
  const h = p.harmony;
  const type: ProgressionType = h.progression === 'auto' ? (h.sequence.trim() ? 'custom' : autoProgression(p)) : h.progression;
  return generateProgression({
    type, beats: projectBeats(p.settings), barBeats: barBeats(p.settings.timeSig), root: p.settings.key, scale: p.settings.scale, custom: p.settings.customScale,
    harmonicRhythm: h.rhythm > 0 ? h.rhythm : 2, tension: 0.5, behavior: h.behavior, colour: h.colour, sequence: h.sequence, rng: rng(hash32(`harmony:${h.seed}`)),
  });
}

/** Orbital voices → notes on their layers. Each repetition of a revolution reads the harmony. */
export function withOrbital(p: Project): Project {
  const ctx = projectContext(p);
  const total = projectBeats(p.settings);
  const byTrack = new Map<string, { notes: NoteEvent[]; pan: AutomationLane | null }>();
  for (const v of p.orbital.voices) {
    const track = p.tracks.find((t) => t.id === v.trackId);
    if (!track || !v.strokes.length) continue;
    const { notes, pan } = orbitalNotes(v, track, p.settings, ctx, total);
    const e = byTrack.get(track.id) ?? { notes: [], pan: null };
    e.notes.push(...notes.map((n) => ({ ...n, id: `${v.id}_${n.id}` })));
    e.pan ??= pan;
    byTrack.set(track.id, e);
  }
  const tracks = p.tracks.map((t) => {
    const e = byTrack.get(t.id);
    const had = t.notes.some((n) => n.origin === 'orbital') || t.automation.some((a) => a.id === 'orbital_pan');
    if (!e && !had) return t;
    return {
      ...t, notes: [...t.notes.filter((n) => n.origin !== 'orbital'), ...(e?.notes ?? [])].sort((a, b) => a.start - b.start),
      automation: [...t.automation.filter((a) => a.id !== 'orbital_pan'), ...(e?.pan ? [e.pan] : [])],
    };
  });
  return { ...p, tracks };
}

/** Particle zones → notes, reading the harmony and listening to everything else that sounds. */
export function withParticles(p: Project): Project {
  if (!p.particles.zones.length && !p.tracks.some((t) => t.notes.some((n) => n.origin === 'particle'))) return p;
  const sim = simulateParticles(p.particles, p.tracks, p.settings, { ctx: projectContext(p), sounding: soundingIndex(p.tracks) });
  return {
    ...p,
    tracks: p.tracks.map((t) => {
      const add = sim.notes.get(t.id) ?? [];
      const had = t.notes.some((n) => n.origin === 'particle');
      if (!add.length && !had) return t;
      return { ...t, notes: [...t.notes.filter((n) => n.origin !== 'particle'), ...add.map((n) => ({ ...n, id: `${t.id}_${n.id}` }))].sort((a, b) => a.start - b.start) };
    }),
  };
}

/** Harmony-following drawings, then Orbital, then Particles (which complement what the orbit plays). */
export const refreshSequencers = (p: Project): Project => withParticles(withOrbital(deriveHarmonic(p)));

/** Publish a timeline as the project's shared harmony (unless the harmony is locked). */
export const publishHarmony = (p: Project, slots: ChordSlot[] | null, author: HarmonySettings['author']): Project =>
  !slots || p.harmony.lock ? p : { ...p, harmony: { ...p.harmony, slots, author } };

const SOURCE = { image: { prefix: 'image:', origin: 'image' as const }, panorama: { prefix: 'pano:', origin: 'panorama' as const } };

/** Take a source out of a project. keepMusic: its layers stay as independent editable tracks
 *  (detached: they will never regenerate or vanish). Otherwise its layers go, except layers that
 *  also carry other material (edited notes, drawings, Orbital or Particle notes) — those only lose
 *  the source's notes. Nothing unrelated is touched. */
export function withoutSource(p: Project, kind: 'image' | 'panorama', keepMusic: boolean): Project {
  const { prefix, origin } = SOURCE[kind];
  const used = new Set([...p.orbital.voices.map((v) => v.trackId), ...p.particles.zones.map((z) => z.trackId), ...p.strokes.map((s) => s.trackId)]);
  const fromSource = (t: Track) => !!t.generator?.startsWith(prefix);
  const strip = (t: Track): Track => ({
    ...t, generator: undefined,
    notes: t.notes.filter((n) => n.origin !== origin),
    automation: t.automation.filter((a) => a.origin !== origin && a.origin !== 'modmatrix'),
  });
  const detach = (t: Track): Track => ({
    ...t, generator: undefined,
    notes: t.notes.map((n) => (n.origin === origin ? { ...n, origin: 'user' as const, cid: undefined, src: undefined } : n)),
    automation: t.automation.filter((a) => a.origin !== 'modmatrix'),
  });
  const tracks = p.tracks.flatMap((t) => {
    if (!fromSource(t)) return [t];
    if (keepMusic) return [detach(t)];
    const other = used.has(t.id) || t.notes.some((n) => n.origin !== origin);
    return other ? [strip(t)] : [];
  });
  const harmony = !keepMusic && p.harmony.author === kind && !p.harmony.lock ? { ...p.harmony, slots: [], author: 'none' as const } : p.harmony;
  const next: Project = { ...p, tracks, harmony, modRoutes: p.modRoutes.filter((r) => r.from !== kind) };
  delete next[kind];
  const first = next.tracks[0]?.id ?? '';
  next.orbital = { ...next.orbital, voices: next.orbital.voices.map((v) => (next.tracks.some((t) => t.id === v.trackId) ? v : { ...v, trackId: first })) };
  next.particles = { ...next.particles, zones: next.particles.zones.filter((z) => next.tracks.some((t) => t.id === z.trackId)) };
  return refreshSequencers(next);
}

/** Notes generated from a source are removed; the source, its layers and edited notes stay. */
export function withoutSourceNotes(p: Project, kind: 'image' | 'panorama'): Project {
  const { prefix, origin } = SOURCE[kind];
  return { ...p, tracks: p.tracks.map((t) => (t.generator?.startsWith(prefix) ? { ...t, notes: t.notes.filter((n) => n.origin !== origin) } : t)) };
}
