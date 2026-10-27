// End-to-end checks of the BUILT app in a real Chromium (playwright-core + the cached Chrome for
// Testing). Usage: npm run build && npm run e2e [group ...]. Screenshots land in tests/e2e/out/.
// Audio is verified by measuring it (live analyser RMS, offline renders, decoded WAV files),
// not by trusting DOM state. Exits non-zero if any check fails.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import midiPkg from '@tonejs/midi';
const { Midi } = midiPkg;
import { unzipSync } from 'fflate';

const PORT = 8771;
const BASE = `http://localhost:${PORT}/spectral-atlas/`;
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ONLY = process.argv.slice(2);
const want = (g) => !ONLY.length || ONLY.includes(g);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const p = join(homedir(), 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  return existsSync(p) ? p : undefined;
}

function decodeWav(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ch = v.getUint16(22, true), sr = v.getUint32(24, true), bits = v.getUint16(34, true), bytes = v.getUint32(40, true);
  const n = bytes / (ch * bits / 8);
  let sum = 0, peak = 0;
  for (let i = 0; i < n * ch; i++) { const x = bits === 16 ? v.getInt16(44 + i * 2, true) / 32768 : 0; sum += x * x; peak = Math.max(peak, Math.abs(x)); }
  return { ch, sr, bits, seconds: n / sr, rms: Math.sqrt(sum / (n * ch)), peak };
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE); up = r.ok && (await r.text()).includes('APERTURE'); } catch { /* not yet */ } if (!up) await sleep(250); }
  if (!up) throw new Error(`preview server did not serve APERTURE on ${BASE}`);
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '?blank');
  await page.evaluate(async () => { localStorage.clear(); await new Promise((r) => { const q = indexedDB.deleteDatabase('aperture'); q.onsuccess = q.onerror = q.onblocked = r; }); });
  await page.goto(BASE + '?blank');
  await page.waitForFunction(() => window.__aperture?.store);
  const S = (fn, arg) => page.evaluate(fn, arg);
  await page.mouse.click(700, 400); // user gesture → audio
  await page.waitForFunction(() => window.__aperture.engine.ready, null, { timeout: 10000 });
  const rmsOver = async (ms) => { let m = 0; const t0 = Date.now(); while (Date.now() - t0 < ms) { m = Math.max(m, await S(() => window.__aperture.liveRms())); await sleep(80); } return m; };
  const stop = async () => { await S(() => { window.__aperture.engine.stop(); window.__aperture.engine.stop(); }); await sleep(300); };
  const download = async (clickSel) => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click(clickSel)]); const p = await d.path(); return { name: d.suggestedFilename(), bytes: readFileSync(p) }; };

  // ------------------------------------------------------------------ 1–4, 11: drawing instrument
  if (want('draw')) {
    await S(() => { const s = window.__aperture.store.getState(); s.newProject(); s.setWorkspace('draw'); });
    await sleep(400);
    const box = await page.locator('.stage canvas').boundingBox();
    // pencil: draw an ascending diagonal on the Lead layer
    await page.mouse.move(box.x + 80, box.y + box.height * 0.8);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + 80 + i * 15, box.y + box.height * (0.8 - i * 0.018));
    await page.mouse.up();
    await sleep(200);
    const lead = await S(() => { const p = window.__aperture.store.getState().project; return p.tracks[0].notes.map((n) => ({ s: n.start, m: n.midi })); });
    const asc = lead.length > 5 && lead.slice(1).every((n, i) => n.m >= lead[i].m);
    check('drawing an ascending line creates an ascending run of notes', asc, `${lead.length} notes, ${lead[0]?.m}→${lead[lead.length - 1]?.m}`);
    await page.screenshot({ path: `${OUT}draw-stroke.png` });
    await S(() => window.__aperture.engine.play(0));
    const rms = await rmsOver(1800);
    check('drawn notes are audible (live analyser RMS)', rms > 0.01, `peak RMS ${rms.toFixed(4)}`);
    await stop();
    const after = await rmsOver(400);
    check('stop silences playback', after < rms * 0.3, `RMS after stop ${after.toFixed(4)}`);
    // scale change re-pitches
    const before = lead.map((n) => n.m).join();
    await page.selectOption('select[aria-label="Scale"]', 'phrygian');
    await sleep(150);
    const re = await S(() => window.__aperture.store.getState().project.tracks[0].notes.map((n) => n.midi));
    const phr = [0, 1, 3, 5, 7, 8, 10].map((x) => (x + 9) % 12);
    check('changing the scale changes the pitches (and keeps them in the new scale)', re.join() !== before && re.every((m) => phr.includes(m % 12)), `${re.slice(0, 6).join(',')}…`);
    const strokes = await S(() => window.__aperture.store.getState().project.strokes.length);
    check('the source drawing is untouched by the scale change', strokes === 1);
    // tempo affects timing
    await S(() => window.__aperture.store.getState().setSettings({ bpm: 120 }));
    await S(() => window.__aperture.engine.play(0)); await sleep(1000);
    const p120 = await S(() => window.__aperture.engine.position()); await stop();
    await S(() => window.__aperture.store.getState().setSettings({ bpm: 60 }));
    await S(() => window.__aperture.engine.play(0)); await sleep(1000);
    const p60 = await S(() => window.__aperture.engine.position()); await stop();
    check('tempo changes actual musical timing', p120 > p60 * 1.6, `1 s → ${p120.toFixed(2)} beats @120 vs ${p60.toFixed(2)} @60`);
    // undo / redo
    await page.keyboard.press('Meta+z');
    await sleep(100);
    const undone = await S(() => window.__aperture.store.getState().project.settings.bpm);
    await page.keyboard.press('Meta+Shift+z');
    const redone = await S(() => window.__aperture.store.getState().project.settings.bpm);
    check('undo / redo via keyboard shortcuts', undone === 120 && redone === 60, `undo→${undone}, redo→${redone}`);
    // a drum layer drawn with the rhythm brush + mute/solo measured on channel meters
    await S(() => { const s = window.__aperture.store.getState(); s.setSettings({ bpm: 110 }); s.setUi({ selectedTrackId: s.project.tracks[3].id, brush: { ...s.ui.brush, kind: 'rhythm', density: 4 } }); });
    await page.mouse.move(box.x + 60, box.y + box.height * 0.95); await page.mouse.down();
    await page.mouse.move(box.x + 600, box.y + box.height * 0.95, { steps: 20 }); await page.mouse.up();
    await sleep(200);
    const ids = await S(() => window.__aperture.store.getState().project.tracks.map((t) => t.id));
    await S((id) => window.__aperture.store.getState().setMix(id, { solo: true }), ids[3]);
    await S(() => window.__aperture.engine.play(0)); await sleep(1500);
    const meters = await S((ids) => ids.map((id) => { const m = window.__aperture.engine.graph.channels.get(id)?.meter?.getValue(); return typeof m === 'number' ? m : Math.max(...m); }), ids);
    await stop();
    check('solo: only the soloed drum layer sounds', meters[3] > -50 && meters[0] < -80, `lead ${meters[0].toFixed(1)} dB, drums ${meters[3].toFixed(1)} dB`);
    await S((id) => { const s = window.__aperture.store.getState(); s.setMix(id, { solo: false, mute: true }); }, ids[3]);
    await S(() => window.__aperture.engine.play(0)); await sleep(1200);
    const m2 = await S((ids) => ids.map((id) => { const m = window.__aperture.engine.graph.channels.get(id)?.meter?.getValue(); return typeof m === 'number' ? m : Math.max(...m); }), ids);
    await stop();
    check('mute: the muted layer is silent while others play', m2[3] < -80 && m2[0] > -60, `lead ${m2[0].toFixed(1)} dB, drums ${m2[3].toFixed(1)} dB`);
    await S((id) => window.__aperture.store.getState().setMix(id, { mute: false }), ids[3]);
  }

  // ------------------------------------------------------------------ 3, 12: synthesis is real and varied
  if (want('synth')) {
    const res = await S(async () => {
      const { api, store } = window.__aperture;
      const base = store.getState().project;
      const feat = (buf) => {
        const d = buf.getChannelData(0);
        let zc = 0, s = 0, early = 0, late = 0, peak = 0;
        for (let i = 1; i < d.length; i++) { if ((d[i] >= 0) !== (d[i - 1] >= 0)) zc++; s += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); if (i < d.length / 4) early += d[i] * d[i]; else if (i > d.length / 2) late += d[i] * d[i]; }
        return { zcr: zc / d.length, rms: Math.sqrt(s / d.length), peak, decay: late / Math.max(1e-12, early) };
      };
      const one = async (patch, midi = 57) => {
        const t = { ...base.tracks[0], id: 'x', patch, mix: { ...base.tracks[0].mix, mute: false, solo: false, reverb: 0, delay: 0 }, fx: [], automation: [], notes: [{ id: 'n', start: 0, dur: 1.5, midi: patch.engine === 'drums' ? 38 : midi, vel: 0.9, origin: 'user' }, { id: 'm', start: 0, dur: 1.5, midi: patch.engine === 'drums' ? 42 : midi + 7, vel: 0.9, origin: 'user' }] };
        const p = { ...base, settings: { ...base.settings, bpm: 120, swing: 0 }, tracks: [t] };
        return feat(await api.renderOffline(p, { from: 0, to: 4, tail: 0.5, sampleRate: 22050 }));
      };
      const out = [];
      for (const inst of api.INSTRUMENTS) out.push({ name: inst.name, ...(await one(inst)) });
      const dark = await one({ ...api.instrument('Warm Analog Pad'), filter: { ...api.instrument('Warm Analog Pad').filter, cutoff: 200, envAmt: 0 } });
      const bright = await one({ ...api.instrument('Warm Analog Pad'), filter: { ...api.instrument('Warm Analog Pad').filter, cutoff: 9000, envAmt: 0 } });
      const longRel = await one({ ...api.instrument('Plucked Synth'), amp: { a: 0.002, d: 2, s: 0.8, r: 2 } });
      const shortRel = await one({ ...api.instrument('Plucked Synth'), amp: { a: 0.002, d: 0.1, s: 0, r: 0.05 } });
      return { out, dark, bright, longRel, shortRel };
    });
    // short percussive voices have a tiny average level over a 4.5 s render, so audibility = peak level
    const silent = res.out.filter((x) => !(x.peak > 0.03));
    check('all 13 instruments render audible audio offline', silent.length === 0, res.out.map((x) => `${x.name.split(' ')[0]} pk ${x.peak.toFixed(2)}`).join(' · '));
    const sig = res.out.map((x) => `${(x.zcr * 100).toFixed(0)}:${Math.round(Math.log10(x.decay + 1e-6) * 2)}`);
    const distinct = new Set(sig).size;
    check('instruments are meaningfully different (brightness × envelope fingerprints)', distinct >= 9, `${distinct}/13 distinct fingerprints`);
    check('filter cutoff control changes the sound', res.bright.zcr > res.dark.zcr * 2, `ZCR ${res.dark.zcr.toFixed(4)} → ${res.bright.zcr.toFixed(4)}`);
    check('envelope controls change the sound', res.longRel.decay > res.shortRel.decay * 5, `tail energy ratio ${res.shortRel.decay.toExponential(1)} → ${res.longRel.decay.toExponential(1)}`);
  }

  // ------------------------------------------------------------------ 5, 6: image upload + analysis
  if (want('image')) {
    await S(() => { const s = window.__aperture.store.getState(); s.newProject(); s.setWorkspace('image'); });
    await sleep(300);
    const pngB64 = async (kind) => S(async (kind) => {
      const { api } = window.__aperture;
      const img = kind === 'dark' ? api.darkUniform(480, 320) : api.colorfulTexture(480, 320);
      const blob = await api.rgbaToPng(img);
      const b = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (const x of b) s += String.fromCharCode(x);
      return btoa(s);
    }, kind);
    const loadVia = async (kind) => {
      const b64 = await pngB64(kind);
      await page.setInputFiles('.stage input[type=file]', { name: `${kind}.png`, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
      await page.waitForFunction(() => window.__aperture.store.getState().ui.analysis.image.status === 'done', null, { timeout: 30000 });
      await sleep(400);
      return S(() => { const p = window.__aperture.store.getState().project; const t = p.tracks.filter((x) => x.generator?.startsWith('image:')); return { layers: t.map((x) => x.name), notes: t.reduce((s, x) => s + x.notes.length, 0), vel: t.flatMap((x) => x.notes.map((n) => n.vel)) }; });
    };
    const bright = await loadVia('bright');
    check('uploading an image through the file input works (decode + worker analysis)', bright.layers.length >= 3, bright.layers.join(', '));
    await page.screenshot({ path: `${OUT}image-hybrid.png` });
    await S(() => window.__aperture.engine.play(0));
    const rms = await rmsOver(2000);
    await stop();
    check('image-derived music is audible', rms > 0.01, `RMS ${rms.toFixed(4)}`);
    await S(() => { const s = window.__aperture.store.getState(); s.newProject(); s.setWorkspace('image'); });
    await sleep(300);
    const dark = await loadVia('dark');
    check('a dark uniform image and a bright textured image produce very different music', bright.notes > dark.notes * 2 + 5, `${bright.notes} vs ${dark.notes} notes`);
    for (const mode of ['contour', 'color', 'atmos']) {
      await S((mode) => window.__aperture.store.getState().setImageSettings({ mode }, true), mode);
      await sleep(500);
      const n = await S(() => window.__aperture.store.getState().project.tracks.filter((t) => t.generator?.startsWith('image:')).map((t) => t.name));
      check(`image mode “${mode}” generates its own layers`, n.length >= 1, n.join(', '));
    }
    await page.screenshot({ path: `${OUT}image-atmos.png` });
    // the analysis cache: changing sound never re-analyses
    const before = await S(() => window.__aperture.api.getAnalysis(window.__aperture.store.getState().project.image.asset.assetId));
    await S(() => { const s = window.__aperture.store.getState(); const t = s.project.tracks.find((x) => x.generator?.startsWith('image:')); s.setPatch(t.id, window.__aperture.api.instrument('Bell / FM Tone')); });
    const same = await S(() => window.__aperture.store.getState().ui.analysis.image.status);
    check('changing a synth preset does not trigger image re-analysis', same === 'done' && !!before);
    const bad = await S(async () => { const s = window.__aperture.store.getState(); await s.importImage(new Blob(['not an image'], { type: 'image/png' }), 'broken.png', 'image'); return s.ui.toasts.map((t) => t.text).join(' | ') + window.__aperture.store.getState().ui.analysis.image.error; });
    check('an undecodable image gives a clear error instead of hanging', /could not decode/i.test(bad), bad.slice(0, 120));
  }

  // ------------------------------------------------------------------ 7, 8: panorama
  if (want('panorama')) {
    await S(() => window.__aperture.loadFactory('panorama'));
    await page.waitForFunction(() => { const p = window.__aperture.store.getState().project; return p.panorama && p.tracks.some((t) => t.generator?.startsWith('pano:')); }, null, { timeout: 60000 });
    await sleep(800);
    const info = await S(() => { const p = window.__aperture.store.getState().project; return { w: p.panorama.asset.width, layers: p.tracks.map((t) => `${t.name}:${t.notes.length}`), bars: p.settings.lengthBars, bpm: p.settings.bpm }; });
    check('Panoramic Journey loads a 4800-px generated panorama with region layers', info.w === 4800 && info.layers.length >= 4, `${info.layers.join(' · ')} · ${info.bars} bars`);
    const shot = async (name) => { await page.screenshot({ path: `${OUT}${name}.png` }); return page.locator('.stage canvas').screenshot(); };
    await S(() => window.__aperture.engine.play(0));
    await sleep(600);
    const a = await shot('pano-a');
    const pa = await S(() => window.__aperture.engine.position());
    await sleep(3000);
    const b = await shot('pano-b');
    const pb = await S(() => window.__aperture.engine.position());
    const rms = await rmsOver(600);
    await stop();
    check('the panorama scrolls during playback', !a.equals(b) && pb > pa, `position ${pa.toFixed(2)} → ${pb.toFixed(2)} beats`);
    check('panorama playback is audible', rms > 0.005, `RMS ${rms.toFixed(4)}`);
    // synchronisation: seek to normalised positions, compare the pixels under the playhead with the source image
    const sync = await S(async () => {
      const { store, engine, api } = window.__aperture;
      const p = store.getState().project;
      const beats = api.displayBeats(p.panorama.settings, p.settings);
      const lv = api.getLevels(p.panorama.asset.assetId);
      const src = new OffscreenCanvas(lv.display.width, lv.display.height);
      const sc = src.getContext('2d');
      sc.drawImage(lv.display, 0, 0);
      const stage = document.querySelector('.stage canvas');
      const out = [];
      for (const x of [0.12, 0.31, 0.55, 0.78, 0.93]) {
        engine.seek(x * beats);
        await new Promise((r) => setTimeout(r, 120));
        const pos = engine.position();
        const t = pos / beats;
        const at = api.scanPoint(t, p.panorama.settings).x;
        // stage pixel column 24 css px right of the playhead → image x
        const dpr = window.devicePixelRatio || 1;
        const sw = stage.width, sh = stage.height;
        const g = stage.getContext('2d');
        const col = g.getImageData(Math.round(sw / 2 + 24 * dpr), Math.round(sh * 0.35), 1, Math.round(sh * 0.5)).data;
        const vh = stage.clientHeight - 62;
        const dw = vh * (p.panorama.asset.width / p.panorama.asset.height);
        const ix = at + 24 / dw;
        const ref = sc.getImageData(Math.round(ix * lv.display.width), 0, 1, lv.display.height).data;
        const mean = (d) => { let r = 0, gg = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; } return [r / n, gg / n, b / n]; };
        out.push({ x, at, pos: pos / beats, stage: mean(col), ref: mean(ref.slice(Math.round(ref.length * 0.35 / 4) * 4, Math.round(ref.length * 0.85 / 4) * 4)) });
      }
      return out;
    });
    const posOk = sync.every((s) => Math.abs(s.at - s.x) < 0.002);
    check('seeking: playhead position ↔ image position mapping is exact', posOk, sync.map((s) => `${s.x}→${s.at.toFixed(4)}`).join(' '));
    const corr = (() => {
      const xs = sync.map((s) => s.stage.reduce((a, b) => a + b, 0)), ys = sync.map((s) => s.ref.reduce((a, b) => a + b, 0));
      const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
      let n = 0, dx = 0, dy = 0; for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
      return n / Math.sqrt(dx * dy);
    })();
    check('the image under the playhead is the image at that musical position (pixel correlation)', corr > 0.8, `r = ${corr.toFixed(3)}`);
    // the music changes across zones
    const zones = await S(() => {
      const p = window.__aperture.store.getState().project;
      const beats = window.__aperture.api.displayBeats(p.panorama.settings, p.settings);
      const z = [[0, 0.18], [0.18, 0.36], [0.36, 0.52], [0.52, 0.68], [0.68, 0.84], [0.84, 1]];
      const notes = p.tracks.filter((t) => t.generator?.startsWith('pano:')).flatMap((t) => t.notes);
      return z.map(([a, b]) => notes.filter((n) => n.start >= a * beats && n.start < b * beats).length / ((b - a) * beats));
    });
    check('the music changes as the playhead crosses the landscape zones', Math.max(...zones) > Math.min(...zones) * 1.8, zones.map((x) => x.toFixed(2)).join(' / ') + ' notes per beat');
    // free-time vs beat-sync
    const t1 = await S(() => { const s = window.__aperture.store.getState(); s.setPanoramaSettings({ timing: 'free', seconds: 60 }); s.generatePanorama(); const p = window.__aperture.store.getState().project; return p.settings.lengthBars * (p.settings.timeSig === '4/4' ? 4 : 3) * 60 / p.settings.bpm; });
    check('free-time: a 1-minute scan yields a ~60 s piece at the current tempo', Math.abs(t1 - 60) < 3.1, `${t1.toFixed(1)} s`);
    await page.click('.ws-tab:has-text("Panorama")');
    await sleep(400);
    await page.screenshot({ path: `${OUT}pano-final.png` });
  }

  // ------------------------------------------------------------------ 9, 10: generative
  if (want('generative')) {
    await S(() => window.__aperture.loadFactory('motorik'));
    await page.waitForFunction(() => window.__aperture.store.getState().project.tracks.some((t) => t.generator === 'gen:drums'), null, { timeout: 20000 });
    await sleep(500);
    await page.screenshot({ path: `${OUT}gen-motorik.png` });
    const fp = () => S(() => window.__aperture.store.getState().project.tracks.flatMap((t) => t.notes.map((n) => `${t.generator}:${n.start.toFixed(3)}:${n.midi}`)).join('|'));
    const a = await fp();
    await S(() => { const s = window.__aperture.store.getState(); s.setComposition({ seed: 99 }); s.generateComposition(); });
    const b = await fp();
    await S(() => { const s = window.__aperture.store.getState(); s.setComposition({ seed: 7 }); s.generateComposition(); });
    const c = await fp();
    check('regeneration with a new seed produces variation; the same seed reproduces exactly', a !== b && a === c);
    const styles = await S(() => {
      const out = {};
      for (const style of ['ambient', 'motorik', 'idm']) {
        const s = window.__aperture.store.getState();
        s.setComposition({ style, seed: 5, bars: 32 });
        s.generateComposition();
        const p = window.__aperture.store.getState().project;
        const notes = p.tracks.filter((t) => t.generator?.startsWith('gen:')).flatMap((t) => t.notes);
        out[style] = { n: notes.length, dur: notes.reduce((x, y) => x + y.dur, 0) / notes.length, layers: p.tracks.map((t) => t.generator).join(',') };
      }
      return out;
    });
    check('Ambient, Motorik and IDM produce structurally different pieces', styles.motorik.n > styles.ambient.n * 3 && styles.ambient.dur > styles.motorik.dur * 3 && styles.idm.layers !== styles.motorik.layers, JSON.stringify(styles));
    // live regeneration lands on a bar line
    await S(() => { const s = window.__aperture.store.getState(); s.setSettings({ switchAt: 'bar', bpm: 120 }); window.__aperture.engine.play(0); });
    await sleep(700);
    const queued = await S(() => { const s = window.__aperture.store.getState(); s.setComposition({ seed: 31 }); s.generateComposition(); return { pending: window.__aperture.store.getState().ui.pendingRegen, swaps: window.__aperture.engine.pendingSwaps }; });
    await sleep(2600);
    const landed = await S(() => ({ pending: window.__aperture.store.getState().ui.pendingRegen, seed: window.__aperture.store.getState().project.composition.seed }));
    const rms = await rmsOver(800);
    await stop();
    check('regenerating during playback waits for the next bar, then switches', !!queued.pending && queued.swaps[0]?.at === 4 && landed.pending === null, `queued at beat ${queued.swaps[0]?.at}`);
    check('generated music is audible', rms > 0.01, `RMS ${rms.toFixed(4)}`);
    // stop/seek/play stress: no stuck voices
    for (let i = 0; i < 12; i++) { await S((i) => { const e = window.__aperture.engine; if (i % 3 === 0) e.stop(); else if (i % 3 === 1) e.seek(i * 1.3); else void e.play(); }, i); await sleep(120); }
    await stop();
    await sleep(1200);
    const voices = await S(() => window.__aperture.engine.graph.activeVoices(window.__aperture.engine.ctxTime));
    const quiet = await rmsOver(300);
    check('stop/seek/play repeatedly leaves no stuck voices', voices === 0 && quiet < 0.003, `${voices} voices, RMS ${quiet.toFixed(4)}`);
  }

  // ------------------------------------------------------------------ 13–15: persistence and export
  if (want('export')) {
    await S(() => window.__aperture.loadFactory('geometry'));
    await page.waitForFunction(() => window.__aperture.store.getState().project.name === 'Geometry in Motion');
    await sleep(500);
    // MIDI
    await page.click('button:has-text("Export")');
    const mid = await download('button:has-text("Export MIDI")');
    const midi = new Midi(mid.bytes);
    const internal = await S(() => window.__aperture.store.getState().project.tracks.map((t) => ({ name: t.name, n: t.notes.length, first: [...t.notes].sort((a, b) => a.start - b.start || a.midi - b.midi)[0] })));
    const parity = internal.every((t, i) => midi.tracks[i]?.name === t.name && midi.tracks[i].notes.length === t.n && midi.tracks[i].notes.some((n) => n.midi === t.first.midi && n.ticks === Math.round(t.first.start * 480)));
    check('MIDI export: valid file, one track per layer, notes match the internal score', parity && midi.header.tempos[0].bpm > 117, `${midi.tracks.map((t) => `${t.name}:${t.notes.length}`).join(' ')} · drums ch ${midi.tracks[3]?.channel}`);
    check('MIDI drums are on General MIDI channel 10', midi.tracks[3]?.channel === 9);
    // WAV mix (loop region = 8 bars)
    const wav = await download('button:has-text("Export WAV mix")');
    const w = decodeWav(wav.bytes);
    check('WAV export renders real audio (decoded and measured)', w.ch === 2 && w.sr === 44100 && w.rms > 0.01 && w.peak < 1.0, `${w.seconds.toFixed(1)} s, RMS ${w.rms.toFixed(3)}, peak ${w.peak.toFixed(3)}`);
    const stems = await download('button:has-text("Export stems")');
    const files = unzipSync(new Uint8Array(stems.bytes));
    const wavs = Object.keys(files).filter((f) => f.endsWith('.wav'));
    const stemRms = wavs.map((f) => decodeWav(Buffer.from(files[f])).rms);
    check('stem export: one non-silent WAV per audible layer in a ZIP', wavs.length === 4 && stemRms.every((r) => r > 0.002), wavs.map((f, i) => `${f} ${stemRms[i].toFixed(3)}`).join(', '));
    // project file round trip
    const proj = await download('button:has-text("Project file")');
    check('portable project file is a zip containing project.json', !!unzipSync(new Uint8Array(proj.bytes))['project.json']);
    await page.keyboard.press('Escape');
    // save + reload restores the session
    await S(() => window.__aperture.store.getState().saveNow());
    const sig = await S(() => window.__aperture.store.getState().project.tracks.map((t) => t.notes.length).join());
    await page.goto(BASE);
    await page.waitForFunction(() => window.__aperture?.store.getState().project.name === 'Geometry in Motion', null, { timeout: 15000 });
    const sig2 = await S(() => window.__aperture.store.getState().project.tracks.map((t) => t.notes.length).join());
    check('saving and reopening restores the project', sig === sig2, sig2);
    await page.screenshot({ path: `${OUT}reloaded.png` });
  }

  // ------------------------------------------------------------------ factory projects all playable
  if (want('factory')) {
    await page.mouse.click(700, 400);
    for (const id of ['geometry', 'haze', 'motorik', 'fragmented', 'panorama']) {
      await S((id) => window.__aperture.loadFactory(id), id);
      await page.waitForFunction(() => window.__aperture.store.getState().project.tracks.some((t) => t.notes.length > 0), null, { timeout: 60000 });
      await sleep(600);
      await S(() => window.__aperture.engine.play(0));
      const r = await rmsOver(2200);
      await page.screenshot({ path: `${OUT}factory-${id}.png` });
      await stop();
      check(`factory project “${id}” plays immediately`, r > 0.004, `RMS ${r.toFixed(4)}`);
    }
  }

  // ------------------------------------------------------------------ UI sweep: every workspace × panel, plus key interactions
  if (want('ui')) {
    await S(() => window.__aperture.loadFactory('geometry'));
    await page.waitForFunction(() => window.__aperture.store.getState().project.name === 'Geometry in Motion');
    await sleep(400);
    let alerts = 0;
    for (const ws of ['Draw', 'Image', 'Panorama', 'Generative', 'Orbital', 'Particles']) {
      await page.click(`.ws-tab:has-text("${ws}")`);
      for (const tab of ['Source', 'Layer', 'Sound', 'FX', 'Mod']) {
        await page.click(`.right .tab:has-text("${tab}")`);
        await sleep(60);
        alerts += await page.locator('[role=alert]').count();
      }
      for (const bt of ['Piano roll', 'Scenes', 'Mixer']) { await page.click(`.bottom .tab:has-text("${bt}")`); await sleep(60); alerts += await page.locator('[role=alert]').count(); }
      await page.click('.right .tab:has-text("Source")');
      await page.screenshot({ path: `${OUT}ui-${ws.toLowerCase()}.png` });
    }
    check('every workspace × inspector tab × bottom tab renders without an error boundary', alerts === 0, `${alerts} alerts`);
    // orbital: draw an arc inside the circle
    await page.click('.ws-tab:has-text("Orbital")');
    await sleep(300);
    const ob = await page.locator('.stage canvas').boundingBox();
    const cx = ob.x + ob.width / 2, cy = ob.y + ob.height / 2, R = Math.min(ob.width, ob.height) / 2 - 24;
    await page.mouse.move(cx + R * 0.3, cy - R * 0.5); await page.mouse.down();
    for (let i = 0; i <= 20; i++) { const a = -Math.PI / 2 + (i / 20) * Math.PI; await page.mouse.move(cx + Math.cos(a) * R * (0.4 + i * 0.02), cy + Math.sin(a) * R * (0.4 + i * 0.02)); }
    await page.mouse.up();
    await sleep(200);
    const orb = await S(() => window.__aperture.store.getState().project.tracks.flatMap((t) => t.notes).filter((n) => n.origin === 'orbital').length);
    check('orbital sequencer: drawing in the circle creates notes', orb > 2, `${orb} orbital notes`);
    await page.screenshot({ path: `${OUT}ui-orbital-drawn.png` });
    // particles: drag a zone
    await page.click('.ws-tab:has-text("Particles")');
    await sleep(300);
    const pb = await page.locator('.stage canvas').boundingBox();
    await page.mouse.move(pb.x + pb.width * 0.3, pb.y + pb.height * 0.5); await page.mouse.down();
    await page.mouse.move(pb.x + pb.width * 0.7, pb.y + pb.height * 0.9, { steps: 6 }); await page.mouse.up();
    await sleep(300);
    const part = await S(() => window.__aperture.store.getState().project.tracks.flatMap((t) => t.notes).filter((n) => n.origin === 'particle').length);
    check('particle sequencer: a zone collects deterministic particle notes', part > 0, `${part} particle notes`);
    await page.screenshot({ path: `${OUT}ui-particles.png` });
    // piano roll: click to add a user note
    await page.click('.ws-tab:has-text("Draw")');
    await page.click('.bottom .tab:has-text("Piano roll")');
    await sleep(200);
    const before = await S(() => { const s = window.__aperture.store.getState(); return s.project.tracks.find((t) => t.id === s.ui.selectedTrackId).notes.filter((n) => n.origin === 'user').length; });
    const rb = await page.locator('.roll canvas').boundingBox();
    await page.mouse.click(rb.x + rb.width * 0.93, rb.y + rb.height * 0.5);
    await sleep(150);
    const after = await S(() => { const s = window.__aperture.store.getState(); return s.project.tracks.find((t) => t.id === s.ui.selectedTrackId).notes.filter((n) => n.origin === 'user').length; });
    check('piano roll: clicking empty space adds a user note', after === before + 1, `${before} → ${after}`);
    await page.screenshot({ path: `${OUT}ui-pianoroll.png` });
    // FX: add the Atmospheric Sweep from the FX tab
    await page.click('.right .tab:has-text("FX")');
    await page.selectOption('select[aria-label="Add effect"]', 'atmosSweep');
    await sleep(200);
    const fx = await S(() => { const s = window.__aperture.store.getState(); return s.project.tracks.find((t) => t.id === s.ui.selectedTrackId).fx.map((f) => f.type); });
    check('FX tab: adding the Atmospheric Sweep inserts it on the layer', fx.includes('atmosSweep'), fx.join(', '));
    await S(() => window.__aperture.engine.play(0));
    const r = await rmsOver(1200);
    await stop();
    check('playback still sounds with the Atmospheric Sweep inserted', r > 0.01, `RMS ${r.toFixed(4)}`);
    await page.screenshot({ path: `${OUT}ui-fx.png` });
    // shortcuts are ignored while typing
    await page.click('.proj-name');
    await page.keyboard.type('e');
    const tool = await S(() => window.__aperture.store.getState().ui.tool);
    check('keyboard shortcuts are not intercepted while typing in a field', tool !== 'eraser', `tool = ${tool}`);
    await page.keyboard.press('Backspace');
    // scenes → arrangement → print
    await page.click('.bottom .tab:has-text("Scenes")');
    await page.fill('input[aria-label="New scene name"]', 'A');
    await page.click('button:has-text("Save scene")');
    await page.click('button:has-text("+ Arr.")');
    await page.click('button:has-text("+ Arr.")');
    await page.click('button:has-text("Print arrangement")');
    await sleep(300);
    const bars = await S(() => window.__aperture.store.getState().project.settings.lengthBars);
    check('scenes: two copies of an 8-bar scene print to a 16-bar timeline', bars === 16, `${bars} bars`);
  }

  // ------------------------------------------------------------------ audio quality audit (offline)
  if (want('audio')) {
    for (const id of ['geometry', 'motorik', 'fragmented', 'haze']) {
      await S((id) => window.__aperture.loadFactory(id), id);
      await page.waitForFunction(() => window.__aperture.store.getState().project.tracks.some((t) => t.notes.length > 0), null, { timeout: 60000 });
      await sleep(500);
      const a = await S(async () => {
        const { api, store } = window.__aperture;
        const p = store.getState().project;
        const bb = p.settings.timeSig === '7/8' ? 3.5 : p.settings.timeSig === '3/4' ? 3 : 4;
        const to = Math.min(p.settings.lengthBars, 16) * bb;
        const mix = await api.renderOffline(p, { from: 0, to, tail: 2, sampleRate: 44100 });
        let peak = 0, dc = 0, over = 0, n = 0;
        for (let c = 0; c < 2; c++) { const d = mix.getChannelData(c); for (let i = 0; i < d.length; i++) { const x = d[i]; peak = Math.max(peak, Math.abs(x)); dc += x; if (Math.abs(x) > 0.83) over++; n++; } }
        // clicks: second-difference spikes on the tonal (non-percussion, non-glitch) layers
        const tonal = p.tracks.filter((t) => t.notes.length && t.patch.engine !== 'drums' && t.patch.engine !== 'glitch' && t.patch.engine !== 'noise').map((t) => t.id);
        let clicks = 0, worst = 0;
        if (tonal.length) {
          const b = await api.renderOffline(p, { from: 0, to, tail: 1, sampleRate: 44100, only: tonal });
          // a click is an ISOLATED discontinuity: a second-difference spike far above the local
          // high-frequency level (bright FM or resonant bass have large but steady second differences)
          const W = 256;
          for (let c = 0; c < 2; c++) {
            const d = b.getChannelData(c);
            const dd = new Float32Array(d.length);
            for (let i = 2; i < d.length; i++) dd[i] = Math.abs(d[i] - 2 * d[i - 1] + d[i - 2]);
            let acc = 0;
            for (let i = 0; i < Math.min(W, dd.length); i++) acc += dd[i];
            for (let i = W; i < dd.length - W; i++) {
              acc += dd[i + W] - dd[i - W];
              const local = acc / (2 * W);
              worst = Math.max(worst, dd[i] / Math.max(1e-4, local));
              if (dd[i] > 0.02 && dd[i] > local * 12) { clicks++; if (!window.__clickAt) window.__clickAt = []; if (window.__clickAt.length < 6) window.__clickAt.push(i / b.sampleRate); }
            }
          }
        }
        const at = window.__clickAt ?? []; window.__clickAt = []; return { peak, dc: dc / n, overPct: (over / n) * 100, clicks, worst, at, seconds: mix.duration };
      });
      check(`audio audit “${id}”: no clipping, limiter rarely engaged, no DC`, a.peak < 0.99 && a.overPct < 0.5 && Math.abs(a.dc) < 0.01, `peak ${(20 * Math.log10(a.peak)).toFixed(1)} dBFS, ${a.overPct.toFixed(3)}% near ceiling, DC ${a.dc.toExponential(1)}`);
      check(`audio audit “${id}”: no clicks on tonal layers`, a.clicks === 0, `${a.clicks} isolated spikes (worst ${a.worst.toFixed(1)}× local level)${a.at.length ? ' at ' + a.at.map((x) => x.toFixed(3)).join(', ') + ' s' : ''}`);
    }
  }

  check('no uncaught errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('suite ran to completion', false, String(e?.stack ?? e));
} finally {
  await browser?.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
