// PARTICLE SEQUENCER: deterministic 2-D physics (seeded initial state, fixed time step). A note
// fires when a particle enters a musical zone; its height inside the zone sets the pitch and its
// speed the velocity. The simulation is recorded so the view can replay it in sync with playback.

import type { NoteEvent, ParticleSource, ProjectSettings, Track } from '../core/types';
import { hash32, rng } from '../core/rng';
import { barBeats } from '../core/time';
import { allowedPitches, mapY } from '../theory/scales';

export interface ParticleSim {
  /** positions per frame: frame f, particle i → [x, y] at frames[(f * count + i) * 2] */
  frames: Float32Array;
  frameBeats: number;
  count: number;
  notes: Map<string, NoteEvent[]>;
}

export function defaultParticles(): ParticleSource {
  return { count: 6, speed: 0.5, gravity: 0.15, bars: 8, seed: 3, quantize: 4, zones: [] };
}

export function simulateParticles(src: ParticleSource, tracks: Track[], ps: ProjectSettings): ParticleSim {
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
              const arr = notes.get(track.id) ?? [];
              arr.push({ id: `particle_${k++}`, start, dur: 0.25 + z.w * 2, midi: mapY(y, pitches), vel: Math.min(1, 0.4 + speed * 0.6), origin: 'particle', pitchY: track.pitch.mode === 'drums' ? undefined : y });
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
