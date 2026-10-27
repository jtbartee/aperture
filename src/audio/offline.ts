// Offline rendering through the same AudioGraph + voices + schedule as live playback.
// Notes are scheduled in chunks at OfflineAudioContext.suspend() checkpoints, which bounds the
// number of live nodes for long renders, gives real progress, and makes cancellation possible
// (a cancelled render is simply never resumed).

import * as Tone from 'tone';
import type { Project } from '../core/types';
import { AudioGraph, laneValue } from './graph';
import { chaseNotes, eventsInWindow } from './schedule';

export interface RenderOptions {
  from: number;
  to: number;
  tail: number;
  /** render only these tracks (stems); default = audible mix */
  only?: string[];
  sampleRate?: number;
  onProgress?: (f: number) => void;
  signal?: AbortSignal;
}

export class RenderCancelled extends Error { constructor() { super('Render cancelled'); } }

const CHUNK = 4; // seconds of audio per scheduling chunk

export async function renderOffline(project: Project, o: RenderOptions): Promise<AudioBuffer> {
  const sr = o.sampleRate ?? 44100;
  const bps = project.settings.bpm / 60;
  const seconds = Math.max(0.5, (o.to - o.from) / bps + o.tail);
  const frames = Math.ceil(seconds * sr);
  if (frames * 2 * 4 > 1.6e9) throw new Error(`A ${Math.round(seconds)} s render is too large for browser memory; export a shorter loop region or individual stems.`);
  const raw = new OfflineAudioContext(2, frames, sr);
  const prev = Tone.getContext();
  const tctx = new Tone.OfflineContext(raw);
  Tone.setContext(tctx);
  let graph: AudioGraph;
  const only = o.only ? new Set(o.only) : undefined;
  // stems: treat the chosen tracks as audible regardless of mute/solo
  const p: Project = only
    ? { ...project, tracks: project.tracks.map((t) => ({ ...t, mix: { ...t.mix, mute: !only.has(t.id), solo: false } })) }
    : project;
  try {
    graph = new AudioGraph(false);
    graph.sync(p);
  } finally {
    Tone.setContext(prev);
  }
  await graph.whenReady();

  const timeOf = (beat: number) => (beat - o.from) / bps;
  const scheduleChunk = (t0: number, t1: number) => {
    const b0 = o.from + t0 * bps;
    const b1 = Math.min(o.to, o.from + t1 * bps);
    if (b1 > b0) {
      for (const ev of eventsInWindow(p, b0, b1, only)) {
        graph.trigger(ev.track, ev.note, Math.max(0, timeOf(ev.beat)), (ev.endBeat - ev.beat) / bps);
      }
    }
    // automation sampled every 1/8 beat
    for (const t of p.tracks) {
      const ch = graph.channels.get(t.id);
      if (!ch || !t.automation.length) continue;
      for (let b = Math.ceil(b0 * 8) / 8; b < Math.max(b1, b0 + 1e-6); b += 0.125) {
        for (const lane of t.automation) {
          const v = laneValue(lane, b);
          if (v !== null) ch.applyMod(lane.target, v, Math.max(0, timeOf(b)), 0.05);
        }
      }
    }
  };

  for (const ch of graph.channels.values()) ch.resetAutomation(0);
  for (const ev of chaseNotes(p, o.from, only)) graph.trigger(ev.track, ev.note, 0, (ev.endBeat - o.from) / bps);
  scheduleChunk(0, CHUNK);

  let cancelled = false;
  let rejectCancel: (e: Error) => void = () => {};
  const cancelPromise = new Promise<never>((_, rej) => { rejectCancel = rej; });
  const onAbort = () => { cancelled = true; rejectCancel(new RenderCancelled()); };
  o.signal?.addEventListener('abort', onAbort);

  for (let k = 1; k * CHUNK < seconds; k++) {
    const at = k * CHUNK;
    raw.suspend(at).then(() => {
      if (cancelled) return; // never resumed: the render is abandoned
      o.onProgress?.(at / seconds);
      scheduleChunk(at, at + CHUNK);
      raw.resume();
    });
  }
  try {
    const buffer = await Promise.race([raw.startRendering(), cancelPromise]);
    o.onProgress?.(1);
    return buffer;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    try { graph.dispose(); } catch { /* context may be closed */ }
  }
}

export function peakAndRms(buf: AudioBuffer): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const x = Math.abs(d[i]); if (x > peak) peak = x; sum += x * x; n++; }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)) };
}
