import type { AutomationLane, EffectSlot, Mix, NoteEvent, PitchMapping, Role, RhythmSpec, SynthPatch, Track, TrackSource } from '../core/types';
import { instrument } from '../audio/patches';
import { defaultRhythm } from '../theory/rhythm';
import { defaultParams } from '../audio/fx';

/** What a generator produces for one musical layer; the store turns it into (or merges it into) a Track. */
export interface LayerOutput {
  key: string;
  name: string;
  role: Role;
  source: TrackSource;
  patch: SynthPatch;
  pitch: PitchMapping;
  notes: NoteEvent[];
  automation: AutomationLane[];
  rhythm?: RhythmSpec;
  mix?: Partial<Mix>;
  fx?: EffectSlot[];
  color?: string;
}

export const PALETTE = ['#e0a458', '#6fb7d6', '#b48ee0', '#7fcf9a', '#e07a6a', '#d9cf6a', '#6a8de0', '#d97fb6', '#9ad0c9', '#c9a27f', '#8fa3b8', '#e0b5d0'];

export const ROLE_RANGE: Record<Role, PitchMapping> = {
  bass: { mode: 'scale', low: 28, high: 52 },
  drone: { mode: 'scale', low: 36, high: 62 },
  pad: { mode: 'scale', low: 48, high: 79 },
  chords: { mode: 'scale', low: 52, high: 77 },
  melody: { mode: 'scale', low: 57, high: 86 },
  arp: { mode: 'scale', low: 55, high: 84 },
  percussion: { mode: 'drums', low: 36, high: 56 },
  texture: { mode: 'chromatic', low: 48, high: 96 },
};

export const ROLE_PATCH: Record<Role, string> = {
  bass: 'Sub Bass', drone: 'Dark Drone', pad: 'Warm Analog Pad', chords: 'Electric Keyboard', melody: 'Plucked Synth',
  arp: 'Soft Arpeggio Synth', percussion: 'Drum Kit', texture: 'Glitch Percussion',
};

export const ROLE_MIX: Record<Role, Partial<Mix>> = {
  bass: { volume: -4, reverb: 0.05, delay: 0 },
  drone: { volume: -8, reverb: 0.45, delay: 0 },
  pad: { volume: -8, reverb: 0.4, delay: 0.05 },
  chords: { volume: -8, reverb: 0.25, delay: 0.15 },
  melody: { volume: -6, reverb: 0.25, delay: 0.2 },
  arp: { volume: -9, reverb: 0.2, delay: 0.15 },
  percussion: { volume: -5, reverb: 0.08, delay: 0.05 },
  texture: { volume: -10, reverb: 0.3, delay: 0.25 },
};

export function fxSlot(type: EffectSlot['type'], params: Record<string, number> = {}, id?: string): EffectSlot {
  return { id: id ?? `fx_${type}_${Math.random().toString(36).slice(2, 7)}`, type, on: true, params: { ...defaultParams(type), ...params } };
}

export function layer(key: string, name: string, role: Role, source: TrackSource, extra: Partial<LayerOutput> = {}): LayerOutput {
  return {
    key, name, role, source,
    patch: extra.patch ?? instrument(ROLE_PATCH[role]),
    pitch: extra.pitch ?? { ...ROLE_RANGE[role] },
    notes: extra.notes ?? [],
    automation: extra.automation ?? [],
    rhythm: extra.rhythm,
    mix: { ...ROLE_MIX[role], ...extra.mix },
    fx: extra.fx,
    color: extra.color,
  };
}

export function trackFromLayer(l: LayerOutput, id: string, color: string, seed: number): Track {
  return {
    id, name: l.name, color: l.color ?? color, source: l.source, role: l.role, patch: l.patch, notes: l.notes,
    automation: l.automation, pitch: l.pitch,
    mix: { volume: -6, pan: 0, mute: false, solo: false, reverb: 0.2, delay: 0, ...l.mix },
    fx: l.fx ?? [], rhythm: l.rhythm ?? defaultRhythm(), seed, variation: 1, generator: l.key,
  };
}

export function emptyTrack(id: string, name: string, role: Role, color: string, patchName?: string): Track {
  const l = layer('', name, role, 'drawn', patchName ? { patch: instrument(patchName) } : {});
  const t = trackFromLayer(l, id, color, 1);
  t.generator = undefined;
  return t;
}
