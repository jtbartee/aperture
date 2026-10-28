// The mixing graph shared by live playback and offline rendering:
//   voices → channel input → automation filter (cutoff, resonance) → spectral tilt → automation gain → inserts → auto-pan → pan →
//   fader → mute → master;   fader → sends → reverb / delay buses → master
//   master → glue compressor → limiter (150 ms release) → destination

import * as Tone from 'tone';
import type { AutomationLane, ModTarget, NoteEvent, Project, Track } from '../core/types';
import { createFx, type FxUnit } from './fx';
import { type BusName, dbToGain, startVoice, type Voice, type VoiceOpts } from './voices';
import { defaultImageParams, unit } from './imageSynth';
import { audible } from './graph-audible';

export { audible };

export const cutoffFromNorm = (v: number) => 60 * Math.pow(2, Math.max(0, Math.min(1, v)) * 8.2);

export class Channel {
  readonly input: GainNode;
  readonly autoFilter: BiquadFilterNode;
  readonly tilt: BiquadFilterNode;
  readonly autoGain: GainNode;
  readonly autoPan: StereoPannerNode;
  readonly panner: Tone.Panner;
  readonly fader: Tone.Gain;
  readonly muteGain: Tone.Gain;
  readonly sendR: Tone.Gain;
  readonly sendD: Tone.Gain;
  readonly autoSendR: Tone.Gain;
  readonly autoSendD: Tone.Gain;
  meter?: Tone.Meter;
  fx: FxUnit[] = [];
  fxKey = '';
  voices = new Set<Voice>();
  lastMidi?: number;
  held = new Map<number, Voice>();
  /** constant-source buses that Image Synth voices follow while they sound */
  private buses = new Map<BusName, ConstantSourceNode>();
  /** the track's patch, for the buses' resting values */
  patch?: Track['patch'];

  constructor(readonly graph: AudioGraph, readonly id: string) {
    const raw = graph.raw;
    this.input = raw.createGain();
    this.autoFilter = raw.createBiquadFilter();
    this.autoFilter.type = 'lowpass';
    this.autoFilter.frequency.value = 20000;
    this.autoFilter.Q.value = 0.5;
    this.tilt = raw.createBiquadFilter();
    this.tilt.type = 'highshelf';
    this.tilt.frequency.value = 2500;
    this.tilt.gain.value = 0;
    this.autoGain = raw.createGain();
    this.autoPan = raw.createStereoPanner();
    this.panner = new Tone.Panner(0);
    this.fader = new Tone.Gain(1);
    this.muteGain = new Tone.Gain(1);
    this.sendR = new Tone.Gain(0);
    this.sendD = new Tone.Gain(0);
    this.autoSendR = new Tone.Gain(1);
    this.autoSendD = new Tone.Gain(1);
    this.input.connect(this.autoFilter).connect(this.tilt).connect(this.autoGain);
    Tone.connect(this.autoPan, this.panner);
    this.panner.connect(this.fader);
    this.fader.connect(this.muteGain);
    this.muteGain.connect(graph.master);
    this.muteGain.connect(this.sendR);
    this.muteGain.connect(this.sendD);
    this.sendR.chain(this.autoSendR, graph.reverbIn);
    this.sendD.chain(this.autoSendD, graph.delayIn);
    this.rewire();
    if (graph.live) {
      this.meter = new Tone.Meter({ smoothing: 0.85 });
      this.fader.connect(this.meter);
    }
  }

  /** (Re)connect the insert chain between the automation gain and the auto-pan. */
  rewire() {
    try { this.autoGain.disconnect(); } catch { /* first wire */ }
    let prev: Tone.OutputNode = this.autoGain;
    for (const u of this.fx) {
      Tone.connect(prev, u.input);
      prev = u.output;
    }
    Tone.connect(prev, this.autoPan);
  }

  setFx(units: FxUnit[], key: string) {
    for (const u of this.fx) { try { (u.output as Tone.ToneAudioNode).disconnect?.(); } catch { /* ignore */ } u.dispose(); }
    this.fx = units;
    this.fxKey = key;
    this.rewire();
  }

  /** Resting value of a bus: the patch's static Image Synth parameter. */
  private busBase(name: BusName): number {
    const ip = this.patch?.image ?? defaultImageParams();
    return { morph: ip.morph, detune: ip.detune, fmDepth: ip.fmDepth, noise: ip.noise, lfoRate: ip.lfoRate, lfoDepth: ip.lfoDepth, tremolo: ip.tremolo }[name];
  }

  bus(name: BusName): ConstantSourceNode {
    let b = this.buses.get(name);
    if (!b) {
      b = this.graph.raw.createConstantSource();
      b.offset.value = this.busBase(name);
      b.start();
      this.buses.set(name, b);
    }
    return b;
  }

  resetAutomation(time: number) {
    for (const [name, b] of this.buses) { b.offset.cancelScheduledValues(time); b.offset.setValueAtTime(this.busBase(name), time); }
    this.autoFilter.Q.cancelScheduledValues(time);
    this.autoFilter.Q.setValueAtTime(0.5, time);
    this.tilt.gain.cancelScheduledValues(time);
    this.tilt.gain.setValueAtTime(0, time);
    this.autoFilter.frequency.cancelScheduledValues(time);
    this.autoFilter.frequency.setValueAtTime(20000, time);
    this.autoGain.gain.cancelScheduledValues(time);
    this.autoGain.gain.setValueAtTime(1, time);
    this.autoPan.pan.cancelScheduledValues(time);
    this.autoPan.pan.setValueAtTime(0, time);
    this.autoSendR.gain.cancelScheduledValues(time);
    this.autoSendR.gain.setValueAtTime(1, time);
    this.autoSendD.gain.cancelScheduledValues(time);
    this.autoSendD.gain.setValueAtTime(1, time);
  }

  applyMod(target: ModTarget, v: number, time: number, tc = 0.04) {
    switch (target) {
      case 'cutoff': this.autoFilter.frequency.setTargetAtTime(cutoffFromNorm(v), time, tc); return;
      case 'volume': this.autoGain.gain.setTargetAtTime(Math.max(0, v) * 1.1, time, tc); return;
      case 'pan': this.autoPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, v * 2 - 1)), time, tc); return;
      case 'reverbSend': this.autoSendR.gain.setTargetAtTime(v * 1.5, time, tc); return;
      case 'delaySend': this.autoSendD.gain.setTargetAtTime(v * 1.5, time, tc); return;
      case 'resonance': this.autoFilter.Q.setTargetAtTime(unit.resonance(v), time, tc); return;
      case 'richness': this.tilt.gain.setTargetAtTime(unit.richness(v), time, tc); return;
      case 'morph': case 'detune': case 'fmDepth': case 'noise': case 'lfoRate': case 'lfoDepth': case 'tremolo':
        // only Image Synth voices listen; skip creating buses for other engines
        if (this.patch?.engine === 'image') this.bus(target).offset.setTargetAtTime(unit[target](v), time, tc);
        return;
      case 'attack': case 'release': case 'fmRatio': return; // read per note at its onset
      default:
        for (const u of this.fx) if (u.mod(target, v, time)) return;
    }
  }

  killAll(t: number) {
    for (const v of this.voices) v.kill(t);
    this.voices.clear();
    this.held.clear();
  }

  dispose() {
    this.killAll(this.graph.raw.currentTime);
    this.setFx([], '');
    for (const b of this.buses.values()) { try { b.stop(); b.disconnect(); } catch { /* ignore */ } }
    this.buses.clear();
    try { this.input.disconnect(); this.autoFilter.disconnect(); this.tilt.disconnect(); this.autoGain.disconnect(); this.autoPan.disconnect(); } catch { /* ignore */ }
    for (const n of [this.panner, this.fader, this.muteGain, this.sendR, this.sendD, this.autoSendR, this.autoSendD, this.meter]) n?.dispose();
  }
}

export class AudioGraph {
  readonly raw: BaseAudioContext;
  readonly master: Tone.Gain;
  readonly glue: Tone.Compressor;
  readonly limiter: Tone.Compressor;
  readonly out: Tone.Gain;
  readonly reverbIn: Tone.Gain;
  readonly delayIn: Tone.Gain;
  readonly reverb: Tone.Reverb;
  readonly delay: Tone.FeedbackDelay;
  readonly delayTone: Tone.Filter;
  readonly analyser?: Tone.Analyser;
  readonly masterMeter?: Tone.Meter;
  readonly channels = new Map<string, Channel>();
  /** seconds per beat (for per-note pitch bends) */
  spb = 0.5;
  private ready: Promise<void>;

  constructor(readonly live: boolean) {
    this.raw = Tone.getContext().rawContext as BaseAudioContext;
    this.master = new Tone.Gain(dbToGain(-1));
    this.glue = new Tone.Compressor({ threshold: -14, ratio: 2.5, attack: 0.02, release: 0.25, knee: 6 });
    this.limiter = new Tone.Compressor({ threshold: -1.5, ratio: 20, attack: 0.002, release: 0.15, knee: 1 });
    this.out = new Tone.Gain(1);
    this.master.chain(this.glue, this.limiter, this.out, Tone.getDestination());
    this.reverbIn = new Tone.Gain(1);
    this.reverb = new Tone.Reverb({ decay: 7, preDelay: 0.03, wet: 1 });
    this.reverbIn.chain(this.reverb, this.master);
    this.delayIn = new Tone.Gain(1);
    this.delay = new Tone.FeedbackDelay({ delayTime: 0.375, feedback: 0.42, wet: 1, maxDelay: 2.5 });
    this.delayTone = new Tone.Filter({ type: 'bandpass', frequency: 1400, Q: 0.6 });
    this.delayIn.chain(this.delay, this.delayTone, this.master);
    if (live) {
      this.analyser = new Tone.Analyser('waveform', 1024);
      this.masterMeter = new Tone.Meter({ smoothing: 0.8 });
      this.out.connect(this.analyser);
      this.out.connect(this.masterMeter);
    }
    this.ready = this.reverb.ready.then(() => undefined);
  }

  async whenReady() {
    await this.ready;
    await Promise.all([...this.channels.values()].flatMap((c) => c.fx.map((u) => u.ready)));
  }

  /** Bring channels in line with the project's tracks (create/remove, mix, inserts). */
  sync(project: Project) {
    const ids = new Set(project.tracks.map((t) => t.id));
    for (const [id, ch] of this.channels) if (!ids.has(id)) { ch.dispose(); this.channels.delete(id); }
    const anySolo = project.tracks.some((t) => t.mix.solo);
    const spb = 60 / project.settings.bpm;
    this.spb = spb;
    this.delay.delayTime.rampTo(Math.min(2.4, spb * 0.75), 0.05);
    for (const t of project.tracks) {
      let ch = this.channels.get(t.id);
      if (!ch) { ch = new Channel(this, t.id); this.channels.set(t.id, ch); }
      ch.patch = t.patch;
      ch.panner.pan.rampTo(t.mix.pan, 0.03);
      ch.fader.gain.rampTo(dbToGain(t.mix.volume), 0.03);
      ch.muteGain.gain.rampTo(audible(t, anySolo) ? 1 : 0, 0.02);
      ch.sendR.gain.rampTo(t.mix.reverb, 0.03);
      ch.sendD.gain.rampTo(t.mix.delay, 0.03);
      const key = t.fx.filter((f) => f.on).map((f) => `${f.id}:${f.type}`).join('|');
      if (key !== ch.fxKey) {
        ch.setFx(t.fx.filter((f) => f.on).map((f) => createFx(f)), key);
      } else {
        t.fx.filter((f) => f.on).forEach((f, i) => ch!.fx[i]?.set({ ...f.params }));
      }
    }
  }

  /** Schedule one note. `time`/`dur` are in context seconds; `fromBeat` is where the voice really
   *  starts when a held note is chased mid-way (its bend skips the part already past). */
  trigger(track: Track, note: NoteEvent, time: number, dur: number, fromBeat?: number): Voice | null {
    const ch = this.channels.get(track.id);
    if (!ch) return null;
    // polyphony: steal the oldest voice still sounding at `time`
    const p = track.patch;
    if (p.engine !== 'drums' && p.engine !== 'glitch') {
      const sounding = [...ch.voices].filter((v) => v.end > time);
      if (sounding.length >= Math.max(1, p.poly)) {
        sounding.sort((a, b) => a.start - b.start);
        for (let i = 0; i <= sounding.length - p.poly; i++) { sounding[i].kill(time); ch.voices.delete(sounding[i]); }
      }
    }
    const o: VoiceOpts = { glideFrom: p.poly === 1 ? ch.lastMidi : undefined, timbre: note.timbre, bend: note.bend, spb: this.spb, bendOffset: fromBeat !== undefined ? Math.max(0, fromBeat - note.start) : 0 };
    for (const lane of track.automation) {
      if (lane.target !== 'attack' && lane.target !== 'release' && lane.target !== 'fmRatio') continue;
      const v = laneValue(lane, note.start);
      if (v !== null) o[lane.target] = unit[lane.target](v);
    }
    if (p.engine === 'image') o.bus = (n) => ch.bus(n);
    const v = startVoice(this.raw, ch.input, p, note.midi, note.vel, time, dur, o);
    ch.lastMidi = note.midi;
    ch.voices.add(v);
    // prune finished voices so the set stays small
    if (ch.voices.size > 64) for (const x of ch.voices) if (x.end < time - 0.5) ch.voices.delete(x);
    return v;
  }

  activeVoices(at: number): number {
    let n = 0;
    for (const ch of this.channels.values()) for (const v of ch.voices) if (v.end > at) n++;
    return n;
  }

  killAll(t: number) {
    for (const ch of this.channels.values()) ch.killAll(t);
  }

  click(time: number, accent: boolean) {
    const o = this.raw.createOscillator();
    const g = this.raw.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(accent ? 0.35 : 0.22, time + 0.001);
    g.gain.setTargetAtTime(0, time + 0.002, 0.012);
    o.connect(g);
    Tone.connect(g, this.out);
    o.start(time);
    o.stop(time + 0.1);
  }

  dispose() {
    for (const ch of this.channels.values()) ch.dispose();
    this.channels.clear();
    for (const n of [this.master, this.glue, this.limiter, this.out, this.reverbIn, this.reverb, this.delayIn, this.delay, this.delayTone, this.analyser, this.masterMeter]) n?.dispose();
  }
}


/** Piecewise-linear lane value at a beat (holds the end values outside the points). */
export function laneValue(lane: AutomationLane, beat: number): number | null {
  const pts = lane.points;
  if (!pts.length) return null;
  if (beat <= pts[0].beat) return pts[0].value;
  if (beat >= pts[pts.length - 1].beat) return pts[pts.length - 1].value;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].beat <= beat) lo = mid; else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const t = (beat - a.beat) / Math.max(1e-9, b.beat - a.beat);
  return a.value + (b.value - a.value) * t;
}
