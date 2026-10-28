// High-polyphony audio stress test: Generative Drone / Experimental + an imported photograph +
// image modulation routes on every layer (cutoff, level, sends, resonance, effect parameters).
//
//   npm run build && npm run stress            headless: correctness, resources, audits, equivalence
//   HEADFUL=1 npm run stress                   also measures real output underruns (opens a window;
//                                              the app's output is silenced, the device still runs)
//   CHROME_PATH=…  QUALITY=balanced|high|performance  SCALE=k (k× the layers)  LIVE_S=seconds
//
// Headless Chrome drives a fake audio sink that waits for the renderer instead of glitching, so
// dropouts can only be measured with HEADFUL=1 (AudioContext.playbackStats / playoutStats).

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = 8774;
const BASE = `http://localhost:${PORT}/aperture/`;
const OUT = new URL('./out/stress/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
// a real photograph (local, not committed: tests/e2e/fixtures/photo.jpg or PHOTO=…); without one the
// test falls back to the app's procedural landscape
const PHOTO = process.env.PHOTO ?? new URL('./fixtures/photo.jpg', import.meta.url).pathname;
const HEADFUL = !!process.env.HEADFUL;
const SCALE = Number(process.env.SCALE ?? 1);
const LIVE_S = Number(process.env.LIVE_S ?? 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const report = {};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const p = join(homedir(), 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  return existsSync(p) ? p : undefined;
}

// own process group, so the vite child dies with it (killing only npx leaves vite serving the port)
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ } };
let browser;
try {
  let up = false;
  // the server must be serving THIS checkout's build, not a stale server left on the port
  const localIndex = readFileSync(new URL('../../dist/index.html', import.meta.url), 'utf8');
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE); up = r.ok && (await r.text()) === localIndex; } catch { /* not yet */ } if (!up) await sleep(250); }
  if (!up) throw new Error(`port ${PORT} is not serving this checkout's dist/ (another server on the port, or no build)`);
  browser = await chromium.launch({
    executablePath: chromePath(), headless: !HEADFUL,
    ignoreDefaultArgs: HEADFUL ? ['--mute-audio'] : [],
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-blink-features=AudioContextPlayoutStats'],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // remember every native AudioContext so the sink's underrun counter can be read
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.__ctxs = [];
    window.AudioContext = new Proxy(Native, { construct(t, a, nt) { const c = Reflect.construct(t, a, nt); window.__ctxs.push(c); return c; } });
  });
  if (process.env.QUALITY) await page.addInitScript((q) => { try { localStorage.setItem('aperture.audioQuality', q); } catch { /* private mode */ } }, process.env.QUALITY);
  await page.goto(BASE + '?blank');
  await page.evaluate(async () => { await new Promise((r) => { const q = indexedDB.deleteDatabase('aperture'); q.onsuccess = q.onerror = q.onblocked = r; }); });
  await page.goto(BASE + '?blank');
  await page.waitForFunction(() => window.__aperture?.store);
  await page.mouse.click(700, 400);
  await page.waitForFunction(() => window.__aperture.engine.ready, null, { timeout: 10000 });
  const S = (fn, arg) => page.evaluate(fn, arg);
  if (HEADFUL) await S(() => { window.__aperture.engine.graph.out.gain.value = 0; });
  report.quality = await S(() => window.__aperture.engine.quality.id);
  report.browser = await S(() => navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0]);
  const cdp = await page.context().newCDPSession(page);

  // ------------------------------------------------------------------ native effects ≡ Tone.js
  const eq = await S(async () => {
    const { Tone, api } = window.__aperture;
    const N = api.nativeFx;
    const SR = 48000, SEC = 6;
    const render = async (build, impulse = false) => {
      const raw = new OfflineAudioContext(2, SR * SEC, SR);
      const prev = Tone.getContext();
      Tone.setContext(new Tone.OfflineContext(raw));
      let ready;
      try {
        let src;
        if (impulse) {
          const b = raw.createBuffer(2, SR, SR);
          b.getChannelData(0)[1000] = 1; b.getChannelData(1)[1000] = 1;
          src = raw.createBufferSource(); src.buffer = b; src.start();
        } else {
          const a = raw.createOscillator(); a.type = 'sawtooth'; a.frequency.value = 110;
          const b = raw.createOscillator(); b.type = 'square'; b.frequency.value = 164.5;
          const m = raw.createChannelMerger(2);
          const ga = raw.createGain(); ga.gain.value = 0.3; const gb = raw.createGain(); gb.gain.value = 0.2;
          a.connect(ga).connect(m, 0, 0); b.connect(gb).connect(m, 0, 1); a.start(); b.start();
          src = raw.createGain();
          src.gain.setValueAtTime(1, 0); for (let t = 0.5; t < SEC; t += 1) { src.gain.setValueAtTime(0, t); src.gain.setValueAtTime(1, t + 0.4); }
          m.connect(src);
        }
        ready = build(raw, src, raw.destination, Tone);
      } finally { Tone.setContext(prev); }
      // Tone.Reverb resolves `ready` when its impulse is rendered but assigns convolver.buffer one
      // await later; let that land before rendering the reference
      if (ready) { await ready; await new Promise((r) => setTimeout(r, 0)); }
      return raw.startRendering();
    };
    const errDb = (x, y) => { let e = 0, s = 0; for (let c = 0; c < 2; c++) { const p = x.getChannelData(c), q = y.getChannelData(c); for (let i = 0; i < p.length; i++) { e += (p[i] - q[i]) ** 2; s += p[i] ** 2; } } return 10 * Math.log10(e / Math.max(1e-20, s)); };
    const tone = (make) => (c, i, d, T) => { const x = make(T); T.connect(i, x); x.connect(d); return x.ready; };
    const nat = (make) => (c, i, d) => { const x = make(c); i.connect(x.input); x.output.connect(d); };
    const pairs = {
      phaser: [tone((T) => new T.Phaser({ frequency: 0.12, octaves: 3.8, baseFrequency: 280, wet: 0.6 })), nat((c) => new N.NativePhaser(c, { rate: 0.12, octaves: 3.8, base: 280, wet: 0.6 }))],
      chorus: [tone((T) => new T.Chorus({ frequency: 0.36, depth: 0.8, delayTime: 6, wet: 0.6, spread: 180 }).start()), nat((c) => new N.NativeChorus(c, { rate: 0.36, depth: 0.8, delayMs: 6, wet: 0.6 }))],
      autopan: [tone((T) => new T.AutoPanner({ frequency: 0.6, depth: 0.85, wet: 1 }).start()), nat((c) => new N.NativeAutoPanner(c, { rate: 0.6, depth: 0.85, wet: 1 }))],
      autofilter: [tone((T) => new T.AutoFilter({ frequency: 0.3, octaves: 3.7, baseFrequency: 180, wet: 1, filter: { type: 'lowpass', rolloff: -12, Q: 1.5 } }).start()), nat((c) => new N.NativeAutoFilter(c, { rate: 0.3, octaves: 3.7, base: 180, q: 1.5, wet: 1 }))],
      feedbackDelay: [tone((T) => new T.FeedbackDelay({ delayTime: 0.61, feedback: 0.45, wet: 0.35, maxDelay: 1.5 })), nat((c) => new N.NativeFeedbackDelay(c, { time: 0.61, feedback: 0.45, wet: 0.35, maxDelay: 1.5 }))],
      pingpongNoFeedback: [tone((T) => new T.PingPongDelay({ delayTime: 0.25, feedback: 0, wet: 0.3, maxDelay: 2.5 })), nat((c) => new N.NativePingPong(c, { time: 0.25, feedback: 0, wet: 0.3, maxDelay: 2.5 }))],
    };
    const out = { err: {} };
    for (const [k, [a, b]] of Object.entries(pairs)) out.err[k] = +errDb(await render(a), await render(b)).toFixed(1);
    // ping-pong with feedback: same echo gains; Tone's longer loop adds ≤ one render quantum per bounce
    const echoes = (buf) => { const ev = []; for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 1100; i < d.length; i++) if (Math.abs(d[i]) > 1e-3) { ev.push({ c, t: i / SR, a: d[i] }); i += 2000; } } return ev.sort((x, y) => x.t - y.t); };
    const pt = echoes(await render(tone((T) => new T.PingPongDelay({ delayTime: 0.25, feedback: 0.45, wet: 1, maxDelay: 2.5 })), true));
    const pn = echoes(await render(nat((c) => new N.NativePingPong(c, { time: 0.25, feedback: 0.45, wet: 1, maxDelay: 2.5 })), true));
    out.pingpong = { n: [pt.length, pn.length], maxGainDiff: +Math.max(...pt.map((e, i) => Math.abs(e.a - (pn[i]?.a ?? 0)))).toFixed(4), maxTimeDiffMs: +Math.max(...pt.map((e, i) => Math.abs(e.t - (pn[i]?.t ?? 0)) * 1000)).toFixed(2) };
    // reverb: different noise, so compare the impulse's energy envelope in 0.25 s windows
    const env = (b) => { const w = SR / 4, e = []; const L = b.getChannelData(0), R = b.getChannelData(1); for (let i = 0; i + w <= L.length; i += w) { let s = 0; for (let j = i; j < i + w; j++) s += L[j] * L[j] + R[j] * R[j]; e.push(10 * Math.log10(s / (2 * w) + 1e-30)); } return e; };
    out.reverb = {};
    for (const [decay, pre] of [[9, 0.04], [7, 0.03], [3, 0.02]]) {
      const en = env(await render(nat((c) => new N.NativeReverb(c, { decay, preDelay: pre, wet: 1 })), true));
      const compare = (et) => { const audible = et.map((v, i) => [v, en[i]]).filter(([v]) => v > et[0] - 60); return { windows: audible.length, maxDiffDb: +Math.max(...audible.map(([x, y]) => Math.abs(x - y))).toFixed(2) }; };
      // Tone's reference impulse is unseeded random noise generated asynchronously; a mismatch is
      // re-checked once against a fresh reference
      let r = compare(env(await render(tone((T) => new T.Reverb({ decay, preDelay: pre, wet: 1 })), true)));
      if (r.maxDiffDb >= 0.6) r = { ...compare(env(await render(tone((T) => new T.Reverb({ decay, preDelay: pre, wet: 1 })), true))), retried: true };
      out.reverb[decay] = r;
    }
    return out;
  });
  for (const [k, v] of Object.entries(eq.err)) check(`native ${k} matches Tone.js sample-for-sample`, v < (k.startsWith('pingpong') ? -35 : -60), `error ${v} dB`);
  check('native ping-pong: same echo gains, echo times within one render quantum per bounce', eq.pingpong.n[0] === eq.pingpong.n[1] && eq.pingpong.maxGainDiff < 0.01 && eq.pingpong.maxTimeDiffMs <= 2.7 * eq.pingpong.n[0] + 0.1, JSON.stringify(eq.pingpong));
  for (const [d, v] of Object.entries(eq.reverb)) check(`native reverb ${d} s: same level and decay as Tone.Reverb (first 60 dB of tail)`, v.maxDiffDb < 0.6, `${v.windows} windows, max ${v.maxDiffDb} dB`);

  // ------------------------------------------------------------------ scenario
  const b64 = existsSync(PHOTO) ? readFileSync(PHOTO).toString('base64') : await S(async () => {
    const { api } = window.__aperture;
    const b = new Uint8Array(await (await api.rgbaToPng(api.panoramaLandscape(1200, 760))).arrayBuffer());
    let s = ''; for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  });
  report.photo = existsSync(PHOTO) ? PHOTO.split('/').pop() : 'procedural landscape';
  const setup = () => S(async ({ b64, scale }) => {
    const s = window.__aperture.store.getState();
    s.newProject();
    s.setComposition({ style: 'drone', seed: 11, bars: 32, density: 0.75, complexity: 0.7, evolution: 0.7 });
    s.generateComposition(undefined, true);
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await s.importImage(new Blob([bin]), 'photo', 'image');
    const t0 = performance.now();
    while (window.__aperture.store.getState().ui.analysis.image.status !== 'done' && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 100));
    // SCALE=k duplicates every sounding layer (with its inserts) k−1 times, 6 dB quieter per doubling
    if (scale > 1) s.commit((p) => {
      const trim = (t) => ({ ...t, mix: { ...t.mix, volume: t.mix.volume - 6 * Math.log2(scale) } });
      const src = p.tracks.filter((t) => t.notes.length);
      const extra = [];
      for (let k = 1; k < scale; k++) for (const t of src) extra.push(trim({ ...structuredClone(t), id: `${t.id}_x${k}`, generator: `${t.generator ?? 'user'}_x${k}`, name: `${t.name} ×${k + 1}`, fx: t.fx.map((f) => ({ ...f, id: `${f.id}_x${k}` })) }));
      return { ...p, tracks: [...p.tracks.map((t) => (t.notes.length ? trim(t) : t)), ...extra] };
    });
  }, { b64, scale: SCALE });
  const routesOn = () => S(() => {
    const s = window.__aperture.store.getState();
    const routes = [];
    for (const t of s.project.tracks.filter((x) => x.notes.length)) {
      const add = (source, target, amount, smoothing) => routes.push({ id: `rt${routes.length}`, source, trackId: t.id, target, amount, smoothing, from: 'image' });
      add('brightness', 'cutoff', 0.8, 0.6); // the + Route default
      add('texture', 'volume', 0.4, 0.3); // depth ≥ 0.5 mutes a layer wherever the feature is near 0, by design
      add('edges', 'reverbSend', 1, 0.2);
      add('variation', 'delaySend', 1, 0); // unsmoothed: rapidly changing
      add('contrast', 'resonance', 0.9, 0.2);
      if (t.fx.some((f) => f.type === 'atmosSweep')) { add('saturation', 'sweepDepth', 1, 0); add('texture', 'delayFeedback', 1, 0); }
      if (t.patch.engine === 'image') { add('edges', 'fmDepth', 1, 0); add('hue', 'morph', 1, 0); add('variation', 'noise', 1, 0); }
    }
    s.commit((pp) => ({ ...pp, modRoutes: routes }));
    s.bakeModMatrix();
    return routes.length;
  });
  const routesOff = () => S(() => { const s = window.__aperture.store.getState(); s.commit((pp) => ({ ...pp, modRoutes: [] })); s.bakeModMatrix(); });
  await setup();
  const nRoutes = await routesOn();
  const shape = await S(() => {
    const p = window.__aperture.store.getState().project;
    const t = p.tracks.filter((x) => x.notes.length);
    return { layers: t.length, drones: t.filter((x) => x.role === 'drone').length, pads: t.filter((x) => x.role === 'pad').length, textures: t.filter((x) => x.role === 'texture').length, image: t.filter((x) => x.patch.engine === 'image').length, sweeps: t.filter((x) => x.fx.some((f) => f.type === 'atmosSweep')).length, longestBeats: Math.max(...t.flatMap((x) => x.notes.map((n) => n.dur))) };
  });
  report.scenario = { ...shape, routes: nRoutes, scale: SCALE };
  check('scenario: two drone layers, a pad, a texture, image layers and routes on every layer', shape.drones >= 2 * SCALE && shape.pads >= SCALE && shape.textures >= SCALE && shape.image >= 3 && nRoutes >= shape.layers * 5, JSON.stringify(report.scenario));

  // ------------------------------------------------------------------ offline audits
  const audit = (opts) => S(async (opts) => {
    const { api, store } = window.__aperture;
    const p = store.getState().project;
    let graph;
    const t0 = performance.now();
    const b = await api.renderOffline(p, { from: 0, to: opts.beats ?? 64, tail: 4, sampleRate: 48000, quality: opts.quality, voiceBudget: opts.budget, only: opts.tonal ? p.tracks.filter((t) => t.notes.length && !['drums', 'glitch', 'noise'].includes(t.patch.engine)).map((t) => t.id) : undefined, onGraph: (g) => { graph = g; } });
    const wall = (performance.now() - t0) / 1000;
    let peak = 0, over = 0, clip = 0, sq = 0, n = 0;
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const x = Math.abs(d[i]); if (x > peak) peak = x; if (x > 0.891) over++; if (x >= 0.999) clip++; sq += d[i] * d[i]; n++; } }
    // reproducibility: largest sample difference from the previous render that asked to be kept
    let diff = null;
    if (opts.compare && window.__kept) { diff = 0; for (let c = 0; c < 2; c++) { const d = b.getChannelData(c), k = window.__kept[c]; for (let i = 0; i < d.length; i++) diff = Math.max(diff, Math.abs(d[i] - k[i])); } }
    if (opts.keep) window.__kept = [b.getChannelData(0).slice(), b.getChannelData(1).slice()];
    // isolated discontinuities (see run.mjs): a second-difference spike far above the local level
    // and ≥ 4× every spike 0.7–6 ms away
    let clicks = 0;
    if (opts.tonal) {
      const W = 256;
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c), dd = new Float32Array(d.length);
        for (let i = 2; i < d.length; i++) dd[i] = Math.abs(d[i] - 2 * d[i - 1] + d[i - 2]);
        let acc = 0; for (let i = 0; i < W; i++) acc += dd[i];
        for (let i = W; i < dd.length - W; i++) {
          acc += dd[i + W] - dd[i - W];
          if (!(dd[i] > 0.002 && dd[i] > (acc / (2 * W)) * 12)) continue;
          let rival = 0; for (let j = i - W; j <= i + W; j++) if (Math.abs(j - i) > 32) rival = Math.max(rival, dd[j]);
          if (dd[i] >= rival * 4) { clicks++; i += 64; }
        }
      }
    }
    return { seconds: b.duration, loadPct: (wall / b.duration) * 100, peakDb: 20 * Math.log10(peak + 1e-12), rmsDb: 10 * Math.log10(sq / n + 1e-24), overPct: (over / n) * 100, clip, clicks, diff, stats: graph ? { ...graph.stats } : null };
  }, opts);
  const on = await audit({ keep: true });
  const on2 = await audit({ compare: true });
  check('offline render (MOD on): no clipping, limiter rarely reached', on.clip === 0 && on.overPct < 0.01, `peak ${on.peakDb.toFixed(1)} dBFS, ${on.overPct.toFixed(4)} % above −1 dBFS`);
  // seeded reverb impulses: two renders of one project agree to floating-point rounding
  check('offline renders are reproducible (same project → same audio, within −100 dBFS)', on2.diff !== null && on2.diff < 1e-5, `largest sample difference ${on2.diff?.toExponential(2)} (${(20 * Math.log10((on2.diff ?? 0) + 1e-12)).toFixed(0)} dBFS)`);
  const tonal = await audit({ tonal: true });
  check('tonal layers (MOD on): no isolated clicks', tonal.clicks === 0, `${tonal.clicks} clicks`);
  await routesOff();
  const off = await audit({});
  await routesOn();
  check('offline render (MOD off): no clipping', off.clip === 0 && off.overPct < 0.01, `peak ${off.peakDb.toFixed(1)} dBFS`);
  const load = {};
  for (const q of ['high', 'balanced']) load[q] = (await audit({ quality: q, beats: 32 })).loadPct;
  report.offline = { modOn: on, modOff: off, loadPct: load };
  console.log(`      offline load (render time ÷ audio time): high ${load.high.toFixed(1)} %, balanced ${load.balanced.toFixed(1)} %`);
  // voice budget: a deliberately tiny budget must take release tails first, never drop a note,
  // and fade what it takes without clicks
  const tight = await audit({ tonal: true, budget: 60 });
  check('tight voice budget: release tails are taken, faded without clicks', tight.stats.stolenTails > 0 && tight.clicks === 0, JSON.stringify({ ...tight.stats, clicks: tight.clicks }));

  // ------------------------------------------------------------------ live
  const ctxIds = [];
  cdp.on('WebAudio.contextCreated', (e) => { if (e.context.contextType === 'realtime') ctxIds.push(e.context.contextId); });
  const alive = new Map();
  cdp.on('WebAudio.audioNodeCreated', (e) => alive.set(e.node.nodeId, e.node.nodeType));
  cdp.on('WebAudio.audioNodeWillBeDestroyed', (e) => alive.delete(e.nodeId));
  await cdp.send('WebAudio.enable');
  await cdp.send('HeapProfiler.enable');
  const playout = () => S(() => {
    const et = window.__aperture.engine.ctxTime;
    const c = window.__ctxs.filter((x) => x.state === 'running').sort((a, b) => Math.abs(a.currentTime - et) - Math.abs(b.currentTime - et))[0];
    const pb = c?.playbackStats;
    if (pb) return { events: pb.underrunEvents, ms: pb.underrunDuration * 1000, latency: pb.averageLatency * 1000 };
    const ps = c?.playoutStats;
    return ps ? { events: ps.fallbackFramesEvents, ms: ps.fallbackFramesDuration, latency: ps.averageLatency } : null;
  });
  const capacity = async () => {
    const et = await S(() => window.__aperture.engine.ctxTime);
    let best = null;
    for (const id of ctxIds) { try { const r = (await cdp.send('WebAudio.getRealtimeData', { contextId: id })).realtimeData; if (!best || Math.abs(r.currentTime - et) < Math.abs(best.currentTime - et)) best = r; } catch { /* closed */ } }
    return best?.renderCapacity ?? null;
  };
  const live = async (seconds, label) => {
    await S(() => { const e = window.__aperture.engine; e.scheduledLog = []; e.logScheduling = true; e.takePerf(); void e.play(0); });
    const p0 = await playout();
    const caps = [], rms = [], voices = [];
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      await sleep(250);
      const c = await capacity(); if (c !== null) caps.push(c);
      const x = await S(() => { const e = window.__aperture.engine; return { r: window.__aperture.liveRms(), v: e.graph.activeVoices(e.ctxTime) }; });
      rms.push(x.r); voices.push(x.v);
    }
    const p1 = await playout();
    const res = await S(() => {
      const e = window.__aperture.engine;
      const perf = e.takePerf();
      const covered = e.position();
      const log = e.scheduledLog;
      e.logScheduling = false;
      e.stop();
      // the notes the offline renderer would schedule for the same span (audible tracks, start < covered)
      const p = window.__aperture.store.getState().project;
      const expected = p.tracks.flatMap((t) => t.notes.filter((n) => n.start < covered - 0.05).map((n) => n.id));
      const got = new Set(log.map((x) => x.id));
      return { perf, log, covered, missing: expected.filter((id) => !got.has(id)).length, expected: expected.length };
    });
    caps.sort((x, y) => x - y);
    const keys = res.log.map((x) => `${x.id}@${x.beat}`);
    const r = {
      label, notes: res.log.length, duplicates: keys.length - new Set(keys).size, missing: res.missing, expected: res.expected,
      late: res.perf.late, marginMinMs: res.perf.marginMinMs, tickGapMaxMs: res.perf.tickGapMaxMs,
      voicesMax: Math.max(...voices), rmsDb: 20 * Math.log10(rms.reduce((x, y) => x + y, 0) / rms.length + 1e-12),
      capMean: caps.length ? caps.reduce((x, y) => x + y, 0) / caps.length : null, capP95: caps.length ? caps[Math.floor(caps.length * 0.95)] : null,
      underruns: p0 && p1 ? p1.events - p0.events : null, underrunMs: p0 && p1 ? p1.ms - p0.ms : null, outLatencyMs: p1?.latency ?? null,
    };
    console.log(`      live ${label}: ${r.notes} notes, ${r.voicesMax} voices max, RMS ${r.rmsDb.toFixed(1)} dBFS, render capacity mean ${r.capMean?.toFixed(2)} p95 ${r.capP95?.toFixed(2)}, underruns ${r.underruns ?? 'n/a'}${r.underruns ? ` (${r.underrunMs.toFixed(0)} ms)` : ''}, least lookahead ${r.marginMinMs.toFixed(0)} ms, timer gap ≤ ${r.tickGapMaxMs.toFixed(0)} ms`);
    return r;
  };
  const a = await live(LIVE_S, `MOD on ×${SCALE}`);
  report.live = a;
  check('live: every note scheduled ahead of its start, none twice, none missing vs the offline event list', a.late === 0 && a.duplicates === 0 && a.missing === 0 && a.notes > 20, `${a.notes} scheduled / ${a.expected} expected, ${a.late} late, ${a.duplicates} duplicated, ${a.missing} missing, least lookahead ${a.marginMinMs.toFixed(0)} ms`);
  if (!HEADFUL) check('live: routed playback is audible', a.rmsDb > -70, `RMS ${a.rmsDb.toFixed(1)} dBFS`);
  if (HEADFUL) check(`live (real output device): no underruns at ×${SCALE}`, a.underruns === 0, `${a.underruns} underruns, ${a.underrunMs?.toFixed(0)} ms, output latency ${a.outLatencyMs?.toFixed(1)} ms`);

  // node leak check across repeated playbacks (finished voices must be collectable)
  const snapNodes = async () => { await cdp.send('HeapProfiler.collectGarbage'); await sleep(600); await cdp.send('HeapProfiler.collectGarbage'); await sleep(600); return alive.size; };
  const n0 = await snapNodes();
  const cycles = [];
  for (let k = 0; k < 3; k++) {
    await S(() => window.__aperture.engine.play(0));
    await sleep(12000);
    await S(() => window.__aperture.engine.stop());
    await sleep(11000); // longest release tail
    cycles.push(await snapNodes());
  }
  report.nodes = [n0, ...cycles];
  check('no audio nodes accumulate across playbacks', cycles[2] - cycles[0] < 150, `live nodes after GC: ${[n0, ...cycles].join(' → ')}`);
  for (let i = 0; i < 10; i++) { await S((i) => { const e = window.__aperture.engine; if (i % 2) e.stop(); else void e.play(i * 0.7); }, i); await sleep(150); }
  await S(() => window.__aperture.engine.stop());
  await sleep(300);
  const stuck = await S(() => window.__aperture.engine.graph.activeVoices(window.__aperture.engine.ctxTime));
  check('repeated play/stop leaves no voices sounding', stuck === 0, `${stuck} voices`);
  const switched = await S(async () => {
    const e = window.__aperture.engine;
    const start = e.quality.id;
    await e.play(4);
    const seen = [];
    for (const q of ['high', 'performance', 'balanced', start]) {
      await new Promise((r) => setTimeout(r, 700));
      await e.setQuality(q);
      await new Promise((r) => setTimeout(r, 900));
      seen.push({ q: e.quality.id, playing: e.state === 'playing', pos: +e.position().toFixed(2) });
    }
    e.stop();
    return seen;
  });
  if (HEADFUL) await S(() => { window.__aperture.engine.graph.out.gain.value = 0; });
  check('switching the processing profile while playing keeps playing from the same place', switched.every((x, i) => x.playing && (i === 0 || x.pos > switched[i - 1].pos)), switched.map((x) => `${x.q}@${x.pos}`).join(' → '));

  // project switching: a factory project plays through a rebuilt mix
  await S(async () => { await window.__aperture.loadFactory('haze'); });
  await page.waitForFunction(() => window.__aperture.store.getState().project.tracks.some((t) => t.notes.length), null, { timeout: 60000 });
  await S(() => window.__aperture.engine.play(0));
  await sleep(2500);
  const other = await S(() => ({ rms: +window.__aperture.liveRms().toFixed(4), channels: window.__aperture.engine.graph.channels.size, tracks: window.__aperture.store.getState().project.tracks.length }));
  await S(() => window.__aperture.engine.stop());
  check('switching projects rebuilds the mix (one channel per track) and plays', other.channels === other.tracks && (HEADFUL || other.rms > 0.0005), JSON.stringify(other));

  // diagnostics panel
  await setup();
  await routesOn();
  await S(() => { window.__aperture.store.getState().setUi({ bottomTab: 'perf', bottomOpen: true }); void window.__aperture.engine.play(0); });
  await sleep(7000);
  const panel = await S(() => document.querySelector('.perf')?.innerText ?? '');
  await page.screenshot({ path: `${OUT}performance-monitor.png` });
  await S(() => window.__aperture.engine.stop());
  check('Performance monitor shows voices, scheduler and level readings', /Sounding voices\s*\n?\s*[1-9]/.test(panel) && /Least lookahead left\s*\n?\s*\d+ ms/.test(panel) && /dBFS/.test(panel), panel.replace(/\s+/g, ' ').replace(/^.*?(OUTPUT)/, '$1').slice(0, 420));

  check('no uncaught errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
  writeFileSync(`${OUT}report-${HEADFUL ? 'device' : 'headless'}-x${SCALE}-${report.quality}.json`, JSON.stringify(report, null, 1));
} finally {
  await browser?.close();
  stopServer();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
