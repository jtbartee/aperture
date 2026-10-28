// Cheap, optional audio diagnostics for the Performance monitor. Nothing here runs unless the
// monitor is open: level taps are attached on open and removed on close, and everything else reads
// counters the engine keeps anyway. Values the browser does not expose are reported as missing,
// never estimated as if measured.

import type { AudioGraph } from './graph';

/** Output underruns as measured by the browser's audio sink (frames it filled with silence because
 *  rendering was late). Chrome ≥ 156 ships `AudioContext.playbackStats` (seconds); some earlier
 *  builds had `playoutStats` (milliseconds) behind a flag. Other browsers expose neither. */
export interface OutputStats { underruns: number; underrunMs: number; latencyMs: number | null }

export function outputStats(ctx: BaseAudioContext | undefined): OutputStats | null {
  const c = ctx as unknown as {
    playbackStats?: { underrunEvents: number; underrunDuration: number; averageLatency: number };
    playoutStats?: { fallbackFramesEvents: number; fallbackFramesDuration: number; averageLatency: number };
  } | undefined;
  try {
    const pb = c?.playbackStats;
    if (pb && typeof pb.underrunEvents === 'number') return { underruns: pb.underrunEvents, underrunMs: pb.underrunDuration * 1000, latencyMs: pb.averageLatency > 0 ? pb.averageLatency * 1000 : null };
    const ps = c?.playoutStats;
    if (ps && typeof ps.fallbackFramesEvents === 'number') return { underruns: ps.fallbackFramesEvents, underrunMs: ps.fallbackFramesDuration, latencyMs: ps.averageLatency > 0 ? ps.averageLatency : null };
  } catch { /* not supported */ }
  return null;
}

/** Peak and RMS of a block of samples, in dBFS. */
export function levels(buf: Float32Array): { peakDb: number; rmsDb: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const x = buf[i]; const a = x < 0 ? -x : x; if (a > peak) peak = a; sum += x * x; }
  const db = (v: number) => (v > 1e-9 ? 20 * Math.log10(v) : -180);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, buf.length))) };
}

/** Analyser taps before and after the master limiter, attached only while the monitor is open.
 *  Read once per animation frame: a 2048-sample window spans 43–46 ms, so at ≥ 24 frames/s every
 *  sample is seen (the monitor reports when frames are slower than that). */
export class LevelTaps {
  private pre: AnalyserNode;
  private post: AnalyserNode;
  private buf = new Float32Array(2048);
  constructor(private g: AudioGraph) {
    const ctx = g.raw;
    this.pre = ctx.createAnalyser();
    this.post = ctx.createAnalyser();
    for (const a of [this.pre, this.post]) { a.fftSize = 2048; a.smoothingTimeConstant = 0; }
    g.glue.connect(this.pre);
    g.out.connect(this.post);
  }
  read(): { pre: ReturnType<typeof levels>; post: ReturnType<typeof levels>; reductionDb: number } {
    this.pre.getFloatTimeDomainData(this.buf);
    const pre = levels(this.buf);
    this.post.getFloatTimeDomainData(this.buf);
    const post = levels(this.buf);
    const r = this.g.limiter.reduction;
    return { pre, post, reductionDb: typeof r === 'number' ? r : 0 };
  }
  dispose() {
    try { this.g.glue.disconnect(this.pre); } catch { /* graph rebuilt */ }
    try { this.g.out.disconnect(this.post); } catch { /* graph rebuilt */ }
  }
}
