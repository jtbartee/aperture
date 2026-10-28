import { useEffect, useRef, useState } from 'react';
import { engine, useStore } from '../../state/store';
import { LevelTaps, outputStats, type OutputStats } from '../../audio/diagnostics';
import { type AudioQuality, QUALITY } from '../../audio/quality';
import { renderOffline } from '../../audio/offline';
import type { AudioGraph } from '../../audio/graph';

// Audio performance monitor (bottom panel). Sampling only happens while this panel is mounted:
// counters every 500 ms, frame timing and the two level taps once per animation frame.

interface Snapshot {
  sampleRate: number;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  out: OutputStats | null;
  underruns: number;
  underrunMs: number;
  voices: number;
  cost: number;
  channels: number;
  notesPerSec: number;
  autoPerSec: number;
  marginMinMs: number;
  late: number;
  tickGapMaxMs: number;
  stolenTails: number;
  stolenHeld: number;
  overBudget: number;
  frameAvgMs: number;
  frameMaxMs: number;
  longFrames: number;
  prePeak: number;
  postPeak: number;
  postRms: number;
  reductionMaxDb: number;
  hot: number;
}

const fmt = (v: number | null | undefined, d = 0, unit = '') => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}${unit}`);
const dbf = (v: number) => (v <= -179 ? '−∞' : `${v.toFixed(1)}`);

export function PerfMonitor() {
  const [, force] = useState(0);
  useEffect(() => engine.onChange(() => force((x) => x + 1)), []);
  const playing = engine.state === 'playing';
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [quality, setQualityState] = useState<AudioQuality>(engine.quality.id);
  const [estimate, setEstimate] = useState<string>('');
  const acc = useRef({ frames: 0, frameSum: 0, frameMax: 0, longFrames: 0, prePeak: -180, postPeak: -180, postRms: -180, red: 0, hot: 0 });
  const base = useRef<{ underruns: number; underrunMs: number; stolenTails: number; stolenHeld: number; overBudget: number; late: number } | null>(null);
  // counters since the last reset (a drone piece schedules ~2 notes/s, so a 0.5 s window is often empty)
  const totals = useRef({ late: 0, marginMin: Infinity, gapMax: 0 });

  useEffect(() => {
    let taps: LevelTaps | null = null;
    let tapGraph: AudioGraph | null = null;
    let raf = 0;
    let last = performance.now();
    engine.takePerf(); // start a fresh scheduler window
    const frame = (now: number) => {
      const a = acc.current;
      const dt = now - last;
      last = now;
      a.frames++; a.frameSum += dt; a.frameMax = Math.max(a.frameMax, dt); if (dt > 50) a.longFrames++;
      const g = engine.graph;
      if (g !== tapGraph) { taps?.dispose(); taps = g ? new LevelTaps(g) : null; tapGraph = g; }
      if (taps) {
        const l = taps.read();
        a.prePeak = Math.max(a.prePeak, l.pre.peakDb);
        a.postPeak = Math.max(a.postPeak, l.post.peakDb);
        a.postRms = Math.max(a.postRms, l.post.rmsDb);
        a.red = Math.min(a.red, l.reductionDb);
        if (l.post.peakDb > -0.3) a.hot++;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const tick = () => {
      const g = engine.graph;
      const ctx = g?.raw;
      const out = outputStats(ctx);
      const perf = engine.takePerf();
      const st = g?.stats ?? { stolenTails: 0, stolenHeld: 0, overBudget: 0, triggered: 0 };
      totals.current.late += perf.late;
      totals.current.marginMin = Math.min(totals.current.marginMin, perf.marginMinMs);
      totals.current.gapMax = Math.max(totals.current.gapMax, perf.tickGapMaxMs);
      if (!base.current) base.current = { underruns: out?.underruns ?? 0, underrunMs: out?.underrunMs ?? 0, stolenTails: st.stolenTails, stolenHeld: st.stolenHeld, overBudget: st.overBudget, late: 0 };
      const b = base.current;
      const load = g ? g.load(g.raw.currentTime) : { voices: 0, cost: 0, channels: 0 };
      const a = acc.current;
      const secs = Math.max(0.001, perf.windowMs / 1000);
      const native = ctx as unknown as AudioContext | undefined;
      setSnap({
        sampleRate: ctx?.sampleRate ?? 0,
        baseLatencyMs: native && 'baseLatency' in native ? native.baseLatency * 1000 : null,
        outputLatencyMs: native && 'outputLatency' in native ? native.outputLatency * 1000 : null,
        out,
        underruns: out ? out.underruns - b.underruns : 0,
        underrunMs: out ? out.underrunMs - b.underrunMs : 0,
        voices: load.voices, cost: load.cost, channels: load.channels,
        notesPerSec: perf.notes / secs, autoPerSec: perf.automation / secs,
        marginMinMs: totals.current.marginMin, late: totals.current.late, tickGapMaxMs: totals.current.gapMax,
        stolenTails: st.stolenTails - b.stolenTails, stolenHeld: st.stolenHeld - b.stolenHeld, overBudget: st.overBudget - b.overBudget,
        frameAvgMs: a.frames ? a.frameSum / a.frames : 0, frameMaxMs: a.frameMax, longFrames: a.longFrames,
        prePeak: a.prePeak, postPeak: a.postPeak, postRms: a.postRms, reductionMaxDb: -a.red, hot: a.hot,
      });
      acc.current = { frames: 0, frameSum: 0, frameMax: 0, longFrames: 0, prePeak: -180, postPeak: -180, postRms: -180, red: 0, hot: 0 };
    };
    const id = setInterval(tick, 500);
    return () => { clearInterval(id); cancelAnimationFrame(raf); taps?.dispose(); };
  }, []);

  const reset = () => { base.current = null; totals.current = { late: 0, marginMin: Infinity, gapMax: 0 }; };
  const choose = async (q: AudioQuality) => {
    setQualityState(q);
    await engine.setQuality(q);
    reset();
  };
  const estimateLoad = async () => {
    const p = useStore.getState().project;
    const from = engine.position();
    const seconds = 4;
    setEstimate('Rendering 4 s offline…');
    const t0 = performance.now();
    try {
      await renderOffline(p, { from, to: from + (seconds * p.settings.bpm) / 60, tail: 0, quality: engine.quality.id, sampleRate: engine.graph?.raw.sampleRate ?? 48000 });
      const pct = ((performance.now() - t0) / 1000 / seconds) * 100;
      setEstimate(`≈ ${pct.toFixed(0)} % of one CPU core for this passage (offline render time; an estimate — the realtime thread adds overhead and has a hard deadline)`);
    } catch (e) {
      setEstimate(`Estimate failed: ${(e as Error).message}`);
    }
  };

  const s = snap;
  const budget = engine.quality.voiceBudget;
  const warnings: string[] = [];
  if (s) {
    if (s.underruns > 0) warnings.push(`${s.underruns} output underrun${s.underruns === 1 ? '' : 's'} (${s.underrunMs.toFixed(0)} ms of silence) since reset — the audio thread missed its deadline.${quality !== 'performance' ? ' Try the Performance profile.' : ''}`);
    if (s.late > 0) warnings.push(`${s.late} note${s.late === 1 ? '' : 's'} scheduled after their start time — the main thread was blocked for more than the 120 ms lookahead.`);
    if (s.postPeak > -0.3 || s.reductionMaxDb > 6) warnings.push(`Master is limiting hard (peak ${dbf(s.postPeak)} dBFS, up to ${s.reductionMaxDb.toFixed(1)} dB reduction) — lower track levels or sends.`);
    if (s.stolenHeld > 0) warnings.push(`${s.stolenHeld} held texture/arpeggio note${s.stolenHeld === 1 ? '' : 's'} were cut short by the voice budget.`);
    if (s.frameAvgMs > 42) warnings.push('The interface is drawing below 24 frames/s; level readings may miss short peaks.');
  }
  return (
    <div className="perf" role="region" aria-label="Audio performance monitor">
      <div className="perf-card wide">
        <h4>Processing profile</h4>
        <div className="seg" role="group" aria-label="Audio processing profile">
          {(['balanced', 'high', 'performance'] as const).map((q) => (
            <button key={q} aria-pressed={quality === q} onClick={() => void choose(q)}>{QUALITY[q].label}</button>
          ))}
        </div>
        <p className="note">{QUALITY[quality].description} The profile never changes notes or arrangement; it is stored in this browser, not in the project.</p>
        <div className="btnrow">
          <button className="btn small" onClick={reset}>Reset counters</button>
          <button className="btn small" disabled={playing} title={playing ? 'Stop playback first: the estimate renders offline and would compete with live audio' : undefined} onClick={() => void estimateLoad()}>Estimate load</button>
        </div>
        {estimate && <p className="note">{estimate}</p>}
      </div>
      <div className="perf-card">
        <h4>Output</h4>
        <dl>
          <dt>Sample rate</dt><dd>{s ? `${s.sampleRate} Hz` : '—'}</dd>
          <dt>Base / output latency</dt><dd>{fmt(s?.baseLatencyMs, 1)} / {fmt(s?.outputLatencyMs, 1)} ms</dd>
          <dt>Underruns</dt><dd className={s && s.underruns > 0 ? 'bad' : ''}>{s?.out ? `${s.underruns} (${s.underrunMs.toFixed(0)} ms)` : 'not reported by this browser'}</dd>
          <dt>Measured latency</dt><dd>{fmt(s?.out?.latencyMs, 1, ' ms')}</dd>
        </dl>
      </div>
      <div className="perf-card">
        <h4>Voices</h4>
        <dl>
          <dt>Sounding voices</dt><dd>{s?.voices ?? '—'}</dd>
          <dt>Channels with sound</dt><dd>{s?.channels ?? '—'}</dd>
          <dt>Voice cost / budget</dt><dd className={s && s.cost > budget * 0.9 ? 'warn' : ''}>{s ? `${s.cost.toFixed(0)} / ${budget}` : '—'}</dd>
          <dt>Tails / notes shortened</dt><dd>{s ? `${s.stolenTails} / ${s.stolenHeld}` : '—'}</dd>
        </dl>
        <p className="note">Cost is an estimate per voice (oscillators, filters, audio-rate modulation), not a CPU measurement.</p>
      </div>
      <div className="perf-card">
        <h4>Scheduler (since reset)</h4>
        <dl>
          <dt>Notes / s</dt><dd>{fmt(s?.notesPerSec, 1)}</dd>
          <dt>Automation events / s</dt><dd>{fmt(s?.autoPerSec, 0)}</dd>
          <dt>Least lookahead left</dt><dd className={s && s.marginMinMs < 20 ? 'warn' : ''}>{s && Number.isFinite(s.marginMinMs) ? `${s.marginMinMs.toFixed(0)} ms` : '—'}</dd>
          <dt>Late notes</dt><dd className={s && s.late > 0 ? 'bad' : ''}>{s?.late ?? '—'}</dd>
          <dt>Longest timer gap</dt><dd className={s && s.tickGapMaxMs > 100 ? 'warn' : ''}>{fmt(s?.tickGapMaxMs, 0, ' ms')}</dd>
        </dl>
      </div>
      <div className="perf-card">
        <h4>Interface</h4>
        <dl>
          <dt>Frame time (avg / max)</dt><dd>{fmt(s?.frameAvgMs, 1)} / {fmt(s?.frameMaxMs, 0)} ms</dd>
          <dt>Frames over 50 ms</dt><dd>{s?.longFrames ?? '—'}</dd>
        </dl>
      </div>
      <div className="perf-card">
        <h4>Master level (last 0.5 s)</h4>
        <dl>
          <dt>Before limiter (peak)</dt><dd>{s ? `${dbf(s.prePeak)} dBFS` : '—'}</dd>
          <dt>Output peak / RMS</dt><dd className={s && s.postPeak > -0.3 ? 'bad' : ''}>{s ? `${dbf(s.postPeak)} / ${dbf(s.postRms)} dBFS` : '—'}</dd>
          <dt>Limiter reduction (max)</dt><dd className={s && s.reductionMaxDb > 6 ? 'warn' : ''}>{s ? `${s.reductionMaxDb.toFixed(1)} dB` : '—'}</dd>
        </dl>
      </div>
      <div className="perf-card wide" aria-live="polite">
        <h4>Status</h4>
        {!s ? <p className="note">Collecting…</p> : warnings.length ? warnings.map((w) => <p key={w} className="note warn">{w}</p>) : <p className="note">No dropouts, late notes or hard limiting since the last reset.</p>}
        <p className="note">Underruns come from the browser's own output statistics (Chrome 156+); other values are counted by APERTURE. Diagnostics run only while this tab is open.</p>
      </div>
    </div>
  );
}
