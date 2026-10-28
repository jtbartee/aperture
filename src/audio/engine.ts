// Live transport: a lookahead scheduler on the audio clock. A 25 ms JS timer looks 120 ms
// ahead and schedules every note whose performed start falls in the new window, exactly once
// (the cursor only moves forward). The visual playhead is derived from the audio clock, not
// from animation frames. Loop wraps and tempo changes append "segments" mapping audio time to beats.

import * as Tone from 'tone';
import type { NoteEvent, Project, Track } from '../core/types';
import { TIME_SIGS, barBeats, projectBeats } from '../core/time';
import { AudioGraph, type Channel, laneValue } from './graph';
import { chaseNotes, eventsInWindow } from './schedule';
import { startVoice, type Voice } from './voices';
import { type AudioQuality, QUALITY, type QualityProfile, loadQuality, saveQuality } from './quality';

const LOOKAHEAD = 0.12;
const TICK_MS = 25;
/** a lane value is re-sent only when it moved by more than this (normalised units) */
const LANE_EPS = 1 / 1024;

/** The live context wraps a *native* AudioContext. Tone's default (standardized-audio-context)
 *  wraps every node and parameter in JS objects whose AudioParams have no `automationRate`, so
 *  block-rate modulation (audio/quality.ts) could not reach the real nodes. Offline renders already
 *  use a native OfflineAudioContext. */
function liveContext(hint: AudioContextLatencyCategory | number): Tone.Context {
  // Tone only records the hint (its type omits the numeric form the native constructor accepts)
  return new Tone.Context({ context: new AudioContext({ latencyHint: hint }), latencyHint: hint as AudioContextLatencyCategory, lookAhead: 0 });
}

/** Scheduler counters for the performance monitor. Cheap to keep (a few compares per note);
 *  `takePerf()` returns them and starts a new window. */
export interface SchedulerPerf {
  /** wall-clock window length, ms */
  windowMs: number;
  ticks: number;
  /** largest gap between scheduler ticks (main-thread stalls show up here), ms */
  tickGapMaxMs: number;
  notes: number;
  /** smallest remaining lookahead when a note was handed to the audio graph, ms (Infinity = none) */
  marginMinMs: number;
  /** notes whose start time had already passed when scheduled (they start late) */
  late: number;
  /** lane automation events sent to AudioParams */
  automation: number;
}

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
  quality: QualityProfile = QUALITY[loadQuality()];
  /** last value sent per lane, per channel object (a rebuilt channel starts empty and gets every lane) */
  private laneSent = new WeakMap<Channel, Map<string, number>>();
  private ownContext = false;
  private perf = { t0: 0, ticks: 0, lastTick: 0, gapMax: 0, notes: 0, marginMin: Infinity, late: 0, automation: 0 };

  constructor(private getProject: () => Project) {}

  /** Scheduler counters since the previous call (see SchedulerPerf). */
  takePerf(): SchedulerPerf {
    const now = performance.now();
    const p = this.perf;
    const out = { windowMs: p.t0 ? now - p.t0 : 0, ticks: p.ticks, tickGapMaxMs: p.gapMax, notes: p.notes, marginMinMs: p.marginMin * 1000, late: p.late, automation: p.automation };
    this.perf = { t0: now, ticks: 0, lastTick: p.lastTick, gapMax: 0, notes: 0, marginMin: Infinity, late: 0, automation: 0 };
    return out;
  }

  /** Switch the performance profile: rebuilds the audio graph (and the AudioContext when the
   *  latency hint differs) and resumes playback where it was. */
  async setQuality(q: AudioQuality) {
    if (q === this.quality.id) return;
    const prev = this.quality;
    this.quality = QUALITY[q];
    saveQuality(q);
    if (!this.graph) return;
    const wasPlaying = this.state === 'playing';
    const pos = this.position();
    if (wasPlaying) { this.halt(); this.state = 'paused'; this.parked = pos; }
    this.held.clear();
    const old = this.graph;
    this.graph = null;
    old.dispose();
    if (prev.latencyHint !== this.quality.latencyHint) {
      const oldCtx = Tone.getContext();
      Tone.setContext(liveContext(this.quality.latencyHint));
      try { await oldCtx.dispose(); } catch { /* already closed */ }
    }
    await this.ensure();
    if (wasPlaying) await this.play(pos);
    this.emit();
  }

  get ready() { return !!this.graph; }

  /** Must be called from a user gesture the first time (browser autoplay policy). */
  async ensure(): Promise<AudioGraph> {
    if (this.graph) {
      if (this.graph.live && Tone.getContext().state !== 'running') await Tone.start();
      return this.graph;
    }
    if (!this.ownContext) {
      // Tone creates a default context when it loads; replace it (and close it, so an idle second
      // audio stream is not left running) with one using the profile's latency hint
      const initial = Tone.getContext();
      Tone.setContext(liveContext(this.quality.latencyHint));
      this.ownContext = true;
      try { void initial.dispose(); } catch { /* never started */ }
    }
    await Tone.start();
    this.graph = new AudioGraph(true, this.quality);
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
    this.laneSent = new WeakMap();
    this.applyAutomation(p, beat, now);
    for (const ev of chaseNotes(p, beat)) this.fire(ev.track, ev.note, now, (ev.endBeat - beat) / bps, beat);
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
    this.perf.lastTick = 0;
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

  private fire(track: Track, note: NoteEvent, time: number, durSec: number, fromBeat?: number, intended = time) {
    const margin = intended - this.ctxTime;
    if (margin < this.perf.marginMin) this.perf.marginMin = margin;
    if (margin < 0) this.perf.late++;
    this.perf.notes++;
    this.graph!.trigger(track, note, time, durSec, fromBeat);
    this.scheduledCount++;
    if (this.logScheduling) this.scheduledLog.push({ id: note.id, beat: note.start });
  }

  private applyAutomation(p: Project, beat: number, time: number) {
    const g = this.graph!;
    for (const t of p.tracks) {
      if (!t.automation.length) continue;
      const ch = g.channels.get(t.id);
      if (!ch) continue;
      let sent = this.laneSent.get(ch);
      if (!sent) { sent = new Map(); this.laneSent.set(ch, sent); }
      for (const lane of t.automation) {
        const v = laneValue(lane, beat);
        if (v === null) continue;
        // a value the parameter is already gliding to needs no new event (most ticks, for slow lanes)
        const last = sent.get(lane.id);
        if (last !== undefined && Math.abs(last - v) <= LANE_EPS) continue;
        sent.set(lane.id, v);
        ch.applyMod(lane.target, v, time, 0.06);
        this.perf.automation++;
      }
    }
  }

  tick() {
    if (this.state !== 'playing' || !this.graph) return;
    const wall = performance.now();
    if (this.perf.lastTick && wall - this.perf.lastTick > this.perf.gapMax) this.perf.gapMax = wall - this.perf.lastTick;
    this.perf.lastTick = wall;
    this.perf.ticks++;
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
      const at = timeOf(ev.beat);
      this.fire(ev.track, ev.note, Math.max(now, at), (ev.endBeat - ev.beat) / seg.bps, undefined, at);
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
