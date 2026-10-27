// Live transport: a lookahead scheduler on the audio clock. A 25 ms JS timer looks 120 ms
// ahead and schedules every note whose performed start falls in the new window, exactly once
// (the cursor only moves forward). The visual playhead is derived from the audio clock, not
// from animation frames. Loop wraps and tempo changes append "segments" mapping audio time to beats.

import * as Tone from 'tone';
import type { NoteEvent, Project, Track } from '../core/types';
import { TIME_SIGS, barBeats, projectBeats } from '../core/time';
import { AudioGraph, laneValue } from './graph';
import { chaseNotes, eventsInWindow } from './schedule';
import { startVoice, type Voice } from './voices';

const LOOKAHEAD = 0.12;
const TICK_MS = 25;

interface Segment { ctx: number; beat: number; bps: number }
interface Swap { trackId: string; at: number; commit: () => void }

export type TransportState = 'stopped' | 'playing' | 'paused';

export class LiveEngine {
  graph: AudioGraph | null = null;
  state: TransportState = 'stopped';
  private segs: Segment[] = [];
  private cursor = 0;
  private parked = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private endCtx: number | null = null;
  private swaps: Swap[] = [];
  private listeners = new Set<() => void>();
  /** count of notes handed to the audio graph (used by tests to detect duplicates) */
  scheduledCount = 0;
  scheduledLog: { id: string; beat: number }[] = [];
  logScheduling = false;

  constructor(private getProject: () => Project) {}

  get ready() { return !!this.graph; }

  /** Must be called from a user gesture the first time (browser autoplay policy). */
  async ensure(): Promise<AudioGraph> {
    if (this.graph) {
      if (this.graph.live && Tone.getContext().state !== 'running') await Tone.start();
      return this.graph;
    }
    Tone.setContext(new Tone.Context({ latencyHint: 'balanced', lookAhead: 0 }));
    await Tone.start();
    this.graph = new AudioGraph(true);
    this.graph.sync(this.getProject());
    this.emit();
    return this.graph;
  }

  get ctxTime(): number { return this.graph ? this.graph.raw.currentTime : 0; }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach((f) => f()); }

  sync() { this.graph?.sync(this.getProject()); }

  /** Current transport position in beats, from the audio clock. */
  position(): number {
    if (this.state !== 'playing' || !this.segs.length) return this.parked;
    const now = this.ctxTime;
    let s = this.segs[0];
    for (const seg of this.segs) if (seg.ctx <= now + 1e-6) s = seg;
    return Math.max(0, s.beat + (now - s.ctx) * s.bps);
  }

  async play(from?: number) {
    const g = await this.ensure();
    if (this.state === 'playing') return;
    const p = this.getProject();
    g.sync(p);
    const start = from ?? this.parked;
    this.beginAt(start);
    this.state = 'playing';
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
    this.emit();
  }

  private beginAt(beat: number) {
    const g = this.graph!;
    const p = this.getProject();
    const now = g.raw.currentTime + 0.04;
    const bps = p.settings.bpm / 60;
    this.segs = [{ ctx: now, beat, bps }];
    this.cursor = beat;
    this.endCtx = null;
    for (const ch of g.channels.values()) ch.resetAutomation(now);
    this.applyAutomation(p, beat, now);
    for (const ev of chaseNotes(p, beat)) this.fire(ev.track, ev.note, now, (ev.endBeat - beat) / bps);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.parked = this.position();
    this.halt();
    this.state = 'paused';
    this.emit();
  }

  stop() {
    const p = this.getProject();
    const wasStopped = this.state === 'stopped';
    this.halt();
    this.state = 'stopped';
    // first stop returns to the loop start (or 0); a second stop returns to 0
    this.parked = !wasStopped && p.settings.loop.on ? p.settings.loop.start : 0;
    this.commitAllSwaps();
    this.emit();
  }

  private halt() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.graph?.killAll(this.ctxTime);
    this.segs = [];
  }

  toggle() { if (this.state === 'playing') this.pause(); else void this.play(); }

  seek(beat: number) {
    const b = Math.max(0, beat);
    if (this.state === 'playing') {
      this.graph!.killAll(this.ctxTime);
      this.beginAt(b);
      this.tick();
    } else {
      this.parked = b;
    }
    this.emit();
  }

  /** Called when the project's tempo changes during playback: re-anchor at the current position. */
  retempo() {
    if (this.state !== 'playing') return;
    const bpm = this.getProject().settings.bpm;
    const last = this.segs[this.segs.length - 1];
    if (!last || Math.abs(last.bps - bpm / 60) < 1e-9) return;
    const now = this.ctxTime;
    const pos = this.position();
    // Voices scheduled in the lookahead at the old tempo are cancelled and rescheduled from
    // the current position — so nothing plays twice and nothing is skipped.
    for (const ch of this.graph!.channels.values()) {
      for (const v of ch.voices) if (v.start > now) { v.kill(now); ch.voices.delete(v); }
    }
    this.segs = [{ ctx: now, beat: pos, bps: bpm / 60 }];
    this.cursor = pos;
  }

  /** Queue a track swap (regenerated notes) to land on a musical boundary. */
  queueSwap(trackId: string, at: number, commit: () => void) {
    this.swaps = this.swaps.filter((s) => s.trackId !== trackId);
    if (this.state !== 'playing' || at <= this.cursor) { commit(); return; }
    this.swaps.push({ trackId, at, commit });
    this.swaps.sort((a, b) => a.at - b.at);
    this.emit();
  }

  get pendingSwaps() { return this.swaps.map((s) => ({ trackId: s.trackId, at: s.at })); }

  private commitAllSwaps() {
    const s = this.swaps;
    this.swaps = [];
    s.forEach((x) => x.commit());
  }

  private fire(track: Track, note: NoteEvent, time: number, durSec: number) {
    this.graph!.trigger(track, note, time, durSec);
    this.scheduledCount++;
    if (this.logScheduling) this.scheduledLog.push({ id: note.id, beat: note.start });
  }

  private applyAutomation(p: Project, beat: number, time: number) {
    const g = this.graph!;
    for (const t of p.tracks) {
      if (!t.automation.length) continue;
      const ch = g.channels.get(t.id);
      if (!ch) continue;
      for (const lane of t.automation) {
        const v = laneValue(lane, beat);
        if (v !== null) ch.applyMod(lane.target, v, time, 0.06);
      }
    }
  }

  tick() {
    if (this.state !== 'playing' || !this.graph) return;
    const now = this.ctxTime;
    if (this.endCtx !== null && now >= this.endCtx) { this.stop(); return; }
    let p = this.getProject();
    const end = projectBeats(p.settings);
    const horizon = now + LOOKAHEAD;
    for (let guard = 0; guard < 8; guard++) {
      const seg = this.segs[this.segs.length - 1];
      const target = seg.beat + (horizon - seg.ctx) * seg.bps;
      if (target <= this.cursor + 1e-9) break;
      const loop = p.settings.loop;
      const looping = loop.on && loop.end > loop.start + 0.01 && this.cursor < loop.end - 1e-9;
      let stopAt = looping ? Math.min(target, loop.end) : Math.min(target, end);
      const swap = this.swaps[0];
      if (swap && swap.at > this.cursor && swap.at < stopAt) stopAt = swap.at;
      if (stopAt > this.cursor) this.scheduleRange(p, this.cursor, stopAt, seg);
      this.cursor = Math.max(this.cursor, stopAt);
      if (swap && Math.abs(this.cursor - swap.at) < 1e-9) {
        this.swaps.shift();
        swap.commit();
        p = this.getProject();
        continue;
      }
      if (looping && this.cursor >= loop.end - 1e-9) {
        const wrapCtx = seg.ctx + (loop.end - seg.beat) / seg.bps;
        this.segs.push({ ctx: wrapCtx, beat: loop.start, bps: seg.bps });
        if (this.segs.length > 6) this.segs.splice(0, this.segs.length - 6);
        this.cursor = loop.start;
        // the loop wrap is a musical boundary: land any pending regenerations here
        if (this.swaps.length) { this.commitAllSwaps(); p = this.getProject(); }
        continue;
      }
      if (!looping && this.cursor >= end - 1e-9 && this.endCtx === null) {
        this.endCtx = seg.ctx + (end - seg.beat) / seg.bps + 0.05;
      }
      break;
    }
  }

  private scheduleRange(p: Project, from: number, to: number, seg: Segment) {
    const now = this.ctxTime;
    const timeOf = (b: number) => seg.ctx + (b - seg.beat) / seg.bps;
    for (const ev of eventsInWindow(p, from, to)) {
      this.fire(ev.track, ev.note, Math.max(now, timeOf(ev.beat)), (ev.endBeat - ev.beat) / seg.bps);
    }
    this.applyAutomation(p, from, Math.max(now, timeOf(from)));
    if (p.settings.metronome) {
      const info = TIME_SIGS[p.settings.timeSig];
      const bb = barBeats(p.settings.timeSig);
      const first = Math.ceil(from / info.pulse - 1e-9) * info.pulse;
      for (let b = first; b < to - 1e-9; b += info.pulse) {
        const inBar = ((b % bb) + bb) % bb;
        this.graph!.click(Math.max(now, timeOf(b)), inBar < 1e-6);
      }
    }
  }

  // ------------------------------------------------------------ immediate playing

  /** Audition a pitch (drawing feedback, piano-roll clicks). */
  async preview(trackId: string, midi: number, vel = 0.7, durSec = 0.35) {
    const g = await this.ensure();
    const t = this.getProject().tracks.find((x) => x.id === trackId);
    if (!t) return;
    g.sync(this.getProject());
    g.trigger(t, { id: 'preview', start: 0, dur: 0, midi, vel, origin: 'user' }, g.raw.currentTime + 0.005, durSec);
  }

  private held = new Map<string, Voice>();
  async noteOn(trackId: string, midi: number, vel: number) {
    const g = await this.ensure();
    const t = this.getProject().tracks.find((x) => x.id === trackId);
    const ch = g.channels.get(trackId);
    if (!t || !ch) return;
    const key = `${trackId}:${midi}`;
    this.held.get(key)?.release(g.raw.currentTime);
    const v = startVoice(g.raw, ch.input, t.patch, midi, vel, g.raw.currentTime + 0.003);
    ch.voices.add(v);
    this.held.set(key, v);
  }

  noteOff(trackId: string, midi: number) {
    const key = `${trackId}:${midi}`;
    const v = this.held.get(key);
    if (v && this.graph) v.release(this.graph.raw.currentTime);
    this.held.delete(key);
  }

  panic() {
    this.graph?.killAll(this.ctxTime);
    this.held.clear();
  }
}
