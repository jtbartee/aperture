// PARTICLE SEQUENCER: deterministic 2-D physics (seeded initial state, fixed time step). A note
// fires when a particle enters a musical zone; its height inside the zone and its speed are the
// physical event. The simulation is recorded so the view can replay it in sync with playback.
//
// Music never steers the physics. What a zone does with an entry is its behaviour:
//   chord      — the chord tone of the moment nearest the entry height
//   melody     — a scale melody: chord tones on strong beats, stepwise motion from the zone's last
//                note, the mode's colour tones welcome on weak beats
//   pedal      — tonic and fifth (and their octaves): a held, grounding answer
//   arp        — walks the chord's tones; the particle's vertical direction decides up or down
//   percussion — drum rows by height, no pitch rules
//   free       — the original spatial mapping: height → scale row
// Every harmonic behaviour also listens to what else sounds at that moment (Orbital voices,
// generated layers) and avoids doubling it or rubbing a semitone against it, preferring thirds and
// sixths: particle replies complement the orbit instead of colliding with it. `repeat` makes a
// zone replay its remembered cell (re-fitted to the current chord) instead of finding new notes.

import type { NoteEvent, ParticleSource, ParticleZone, ProjectSettings, Track, ZoneBehavior } from '../core/types';
import { hash32, rng, type Rng } from '../core/rng';
import { barBeats, beatStrength } from '../core/time';
import { allowedPitches, mapY } from '../theory/scales';
import { type MusicalContext, choosePitch, pitchesOf, slotAt, chordPcsFor } from '../theory/context';

export interface ParticleSim {
  /** positions per frame: frame f, particle i → [x, y] at frames[(f * count + i) * 2] */
  frames: Float32Array;
  frameBeats: number;
  count: number;
  notes: Map<string, NoteEvent[]>;
}

export interface ParticleMusic {
  ctx: MusicalContext;
  /** pitches other sources sound at a beat (not the particles themselves) */
  sounding?: (beat: number) => number[];
}

export function defaultParticles(): ParticleSource {
  return { count: 6, speed: 0.5, gravity: 0.15, bars: 8, seed: 3, quantize: 4, zones: [] };
}

/** The behaviour a new zone gets from its layer's role. */
export function defaultZoneBehavior(track: Pick<Track, 'role' | 'pitch'> | undefined): ZoneBehavior {
  if (!track) return 'melody';
  if (track.pitch.mode === 'drums' || track.role === 'percussion') return 'percussion';
  if (track.role === 'pad' || track.role === 'chords' || track.role === 'bass') return 'chord';
  if (track.role === 'arp') return 'arp';
  if (track.role === 'drone') return 'pedal';
  return 'melody';
}

export const ZONE_BEHAVIORS: { id: ZoneBehavior; label: string; title: string }[] = [
  { id: 'melody', label: 'Scale melody', title: 'Stepwise replies in the scale; chord tones on strong beats' },
  { id: 'chord', label: 'Chord tones', title: 'Only tones of the chord sounding at that moment' },
  { id: 'arp', label: 'Arpeggio', title: 'Walks the chord’s tones; rising particles arpeggiate upward' },
  { id: 'pedal', label: 'Pedal / drone', title: 'Tonic and fifth: grounding, sustained answers' },
  { id: 'percussion', label: 'Percussion', title: 'Drum rows by height; no pitch rules' },
  { id: 'free', label: 'Free', title: 'The original mapping: height → scale row' },
];

interface ZoneState { last?: number; cell: number[]; k: number; arp: number; rng: Rng }

/** Index of other sources' notes by whole beat, for "what else is sounding now". */
export function soundingIndex(tracks: Track[], exclude: NoteEvent['origin'] = 'particle'): (beat: number) => number[] {
  const buckets = new Map<number, NoteEvent[]>();
  for (const t of tracks) {
    if (t.pitch.mode === 'drums' || t.mix.mute) continue;
    for (const n of t.notes) {
      if (n.origin === exclude) continue;
      for (let b = Math.floor(n.start); b <= Math.floor(n.start + n.dur - 1e-6) && b - Math.floor(n.start) < 64; b++) (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(n);
    }
  }
  return (beat) => (buckets.get(Math.floor(beat)) ?? []).filter((n) => n.start <= beat + 1e-6 && n.start + n.dur > beat + 1e-6).map((n) => n.midi);
}

export function simulateParticles(src: ParticleSource, tracks: Track[], ps: ProjectSettings, music?: ParticleMusic): ParticleSim {
  const r = rng(hash32(`particles:${src.seed}`));
  const beats = src.bars * barBeats(ps.timeSig);
  const dt = 1 / 32; // beats per physics step
  const frameBeats = 1 / 16;
  const n = Math.max(1, Math.min(40, Math.round(src.count)));
  const pos = Array.from({ length: n }, () => ({ x: 0.1 + r() * 0.8, y: 0.1 + r() * 0.5 }));
  const vel = Array.from({ length: n }, () => { const a = r() * Math.PI * 2; const s = 0.15 + src.speed * 0.6; return { x: Math.cos(a) * s, y: Math.sin(a) * s }; });
  const inside = pos.map(() => new Set<string>());
  const frames = new Float32Array(Math.ceil(beats / frameBeats + 1) * n * 2);
  const notes = new Map<string, NoteEvent[]>();
  const pitchCache = new Map<string, number[]>();
  const zoneState = new Map<string, ZoneState>();
  let k = 0;
  let frame = 0;
  for (let step = 0; step * dt <= beats; step++) {
    const t = step * dt;
    if (Math.abs(t / frameBeats - Math.round(t / frameBeats)) < 1e-6) {
      for (let i = 0; i < n; i++) { frames[(frame * n + i) * 2] = pos[i].x; frames[(frame * n + i) * 2 + 1] = pos[i].y; }
      frame++;
    }
    for (let i = 0; i < n; i++) {
      vel[i].y += src.gravity * dt * 0.8;
      pos[i].x += vel[i].x * dt;
      pos[i].y += vel[i].y * dt;
      if (pos[i].x < 0) { pos[i].x = -pos[i].x; vel[i].x = Math.abs(vel[i].x); }
      if (pos[i].x > 1) { pos[i].x = 2 - pos[i].x; vel[i].x = -Math.abs(vel[i].x); }
      if (pos[i].y < 0) { pos[i].y = -pos[i].y; vel[i].y = Math.abs(vel[i].y); }
      if (pos[i].y > 1) { pos[i].y = 2 - pos[i].y; vel[i].y = -Math.abs(vel[i].y) * 0.98; }
      for (const z of src.zones) {
        const inZ = pos[i].x >= z.x && pos[i].x <= z.x + z.w && pos[i].y >= z.y && pos[i].y <= z.y + z.h;
        const was = inside[i].has(z.id);
        if (inZ && !was) {
          const track = tracks.find((tr) => tr.id === z.trackId);
          if (track) {
            let pitches = pitchCache.get(track.id);
            if (!pitches) { pitches = allowedPitches(track.pitch, ps.key, ps.scale, ps.customScale); pitchCache.set(track.id, pitches); }
            const y = 1 - (pos[i].y - z.y) / Math.max(1e-6, z.h);
            const start = src.quantize ? Math.round(t * src.quantize) / src.quantize : t;
            if (start < beats) {
              const speed = Math.hypot(vel[i].x, vel[i].y);
              const behavior: ZoneBehavior = track.pitch.mode === 'drums' ? 'percussion' : z.behavior ?? 'free';
              let st = zoneState.get(z.id);
              if (!st) { st = { cell: [], k: 0, arp: 0, rng: rng(hash32(`zone:${src.seed}:${z.id}`)) }; zoneState.set(z.id, st); }
              const midi = behavior === 'percussion' || behavior === 'free' || !music
                ? mapY(y, pitches)
                : zonePitch(music, z, behavior, st, { y, start, rising: vel[i].y < 0, track, ps });
              st.last = midi;
              const durBase = 0.25 + z.w * 2;
              const arr = notes.get(track.id) ?? [];
              arr.push({
                id: `particle_${k++}`, start, dur: behavior === 'pedal' ? durBase * 2 : durBase, midi, vel: Math.min(1, 0.4 + speed * 0.6), origin: 'particle',
                pitchY: track.pitch.mode === 'drums' ? undefined : y,
              });
              notes.set(track.id, arr);
            }
          }
          inside[i].add(z.id);
        } else if (!inZ && was) inside[i].delete(z.id);
      }
    }
  }
  return { frames, frameBeats, count: n, notes };
}

/** A zone's musical reading of one physical entry. */
function zonePitch(music: ParticleMusic, z: ParticleZone, behavior: ZoneBehavior, st: ZoneState, e: { y: number; start: number; rising: boolean; track: Track; ps: ProjectSettings }): number {
  const ctx = music.ctx;
  const lo = Math.min(e.track.pitch.low, e.track.pitch.high), hi = Math.max(e.track.pitch.low, e.track.pitch.high);
  const target = lo + e.y * (hi - lo);
  const bb = barBeats(e.ps.timeSig);
  const strong = beatStrength(e.ps.timeSig, ((e.start % bb) + bb) % bb);
  const avoid = music.sounding?.(e.start) ?? [];
  const repeat = z.repeat ?? 0.3;
  // repetition: replay the zone's remembered cell, fitted to the chord of the moment
  if (st.cell.length >= 2 && behavior !== 'arp' && st.rng.chance(repeat)) {
    const want = st.cell[st.k++ % st.cell.length];
    return choosePitch(ctx, { target: want, lo: want - 3, hi: want + 3, beat: e.start, strong, prev: st.last, mode: behavior === 'melody' ? 'melody' : behavior === 'pedal' ? 'pedal' : 'chord', avoid, spread: 1.2 });
  }
  let midi: number;
  switch (behavior) {
    case 'arp': {
      const tones = pitchesOf(chordPcsFor(ctx, slotAt(ctx, e.start), 'harmony'), lo, hi);
      if (!tones.length) { midi = Math.round(target); break; }
      // a fresh run starts near the entry height; then each entry steps along the chord
      if (st.last === undefined || !tones.includes(st.last)) st.arp = tones.reduce((bi, m, i) => (Math.abs(m - target) < Math.abs(tones[bi] - target) ? i : bi), 0);
      else st.arp = (st.arp + (e.rising ? 1 : -1) + tones.length) % tones.length;
      midi = tones[st.arp];
      break;
    }
    case 'pedal':
      midi = choosePitch(ctx, { target, lo, hi, beat: e.start, strong, mode: 'pedal', avoid, spread: 6 });
      break;
    case 'chord':
      midi = choosePitch(ctx, { target, lo, hi, beat: e.start, strong, mode: 'chord', avoid, spread: 3, rng: st.rng });
      break;
    default:
      midi = choosePitch(ctx, { target, lo, hi, beat: e.start, strong, prev: st.last, mode: 'melody', avoid, spread: 3.5, rng: st.rng, colour: 0.5 });
  }
  st.cell.push(midi);
  if (st.cell.length > 4) st.cell.shift();
  return midi;
}
