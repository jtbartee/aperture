// Musical results, not just code paths: does the music follow the picture?
import { describe, expect, test } from 'vitest';
import type { ImageSettings, NoteEvent, PanoramaSource } from '../../src/core/types';
import { colorfulTexture, contourFixture, hazeImage, irregularBars, panoramaLandscape, LANDSCAPE_ZONES, ridgesImage, uniformImage, type RGBAImageLike } from './sonifyFixtures';
import { computeGrid } from '../../src/analysis/features';
import { contourPreset, extractContourSet } from '../../src/analysis/contours';
import { matchTruth } from '../../src/analysis/contourMetrics';
import { defaultImageSettings, generateImageLayers } from '../../src/interpret/imageModes';
import { defaultPanoramaSettings, defaultRegions, generatePanoramaLayers, panoramaBeats } from '../../src/interpret/panorama';
import { laneValue } from '../../src/audio/graph';
import { normalizeImageSettings, normalizePanoramaSettings } from '../../src/state/project';
import { mean, testProject } from './helpers';

const analyse = (img: RGBAImageLike, preset: Parameters<typeof contourPreset>[0] = 'photo') => ({ grid: computeGrid(img, Math.min(192, img.width), 24), contours: extractContourSet(img, contourPreset(preset)) });
const p = testProject();
const BARS = 16, BEATS = BARS * 4;
const img = (patch: Partial<ImageSettings> = {}): ImageSettings => ({ ...defaultImageSettings(), bars: BARS, ...patch });
const notesOf = (layers: { key: string; notes: NoteEvent[] }[], prefix = 'image:contour') => layers.filter((l) => l.key.startsWith(prefix)).flatMap((l) => l.notes);
const spearman = (a: number[], b: number[]) => {
  const rank = (x: number[]) => { const idx = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]); const r = new Array(x.length); idx.forEach(([, i], k) => (r[i] = k)); return r as number[]; };
  const ra = rank(a), rb = rank(b), ma = mean(ra), mb = mean(rb);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return n / Math.sqrt(da * db || 1);
};

const fx = contourFixture();
const fxA = analyse(fx.img, 'lineart');
const cidFor = (name: string) => matchTruth(fxA.contours, fx.truth.find((t) => t.name === name)!.pts).dominant!;

describe('curves sound like curves (literal contour mode)', () => {
  const literal = img({ interpretation: 0, fidelity: 1, structure: 0.35, density: 1, contour: contourPreset('lineart') });
  const notes = notesOf(generateImageLayers(fxA, literal, p.settings));

  test('pitch follows height: every contour note sits at the image height it was read from', () => {
    expect(notes.length).toBeGreaterThan(40);
    const ys = notes.map((n) => n.src![1]);
    const ms = notes.map((n) => n.midi);
    expect(spearman(ys, ms)).toBeGreaterThan(0.97);
    // and time follows x
    expect(spearman(notes.map((n) => n.src![0]), notes.map((n) => n.start))).toBeGreaterThan(0.99);
  });

  test('a rising curve rises, a falling curve falls, the sinusoid oscillates', () => {
    const of = (name: string) => notes.filter((n) => n.cid === cidFor(name)).sort((a, b) => a.start - b.start);
    const rising = of('rising'), falling = of('falling'), sine = of('sine');
    expect(spearman(rising.map((n) => n.start), rising.map((n) => n.midi))).toBeGreaterThan(0.9);
    expect(spearman(falling.map((n) => n.start), falling.map((n) => n.midi))).toBeLessThan(-0.9);
    // direction changes of the melodic line match the drawn peaks and troughs
    const m = sine.map((n) => n.midi);
    let turns = 0, dir = 0;
    for (let i = 1; i < m.length; i++) { const d = Math.sign(m[i] - m[i - 1]); if (d && dir && d !== dir) turns++; if (d) dir = d; }
    expect(turns).toBeGreaterThanOrEqual(4);
    expect(turns).toBeLessThanOrEqual(5);
  });

  test('two overlapping contours sound together as independent lines (one up, one down)', () => {
    const a = notes.filter((n) => n.cid === cidFor('crossA')), b = notes.filter((n) => n.cid === cidFor('crossB'));
    const t = (Math.max(mean(a.map((n) => n.start)), mean(b.map((n) => n.start))));
    const at = (xs: NoteEvent[]) => xs.some((n) => n.start <= t + 0.5 && n.start + n.dur >= t - 0.5);
    expect(at(a) && at(b)).toBe(true);
    // crossA runs top-left → bottom-right in pixels (falls in pitch); crossB rises
    expect(spearman(a.map((n) => n.start), a.map((n) => n.midi))).toBeLessThan(-0.9);
    expect(spearman(b.map((n) => n.start), b.map((n) => n.midi))).toBeGreaterThan(0.9);
  });

  test('gaps between contours are silence; nothing lands on a metrical grid', () => {
    // the fixture's left 4 % is empty paper: no contour notes there
    expect(notes.filter((n) => n.start < 0.035 * BEATS).length).toBe(0);
    const onGrid = notes.filter((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) < 0.02).length / notes.length;
    expect(onGrid).toBeLessThan(0.5);
  });

  test('continuous pitch: with glide and structure < 20 % the notes bend microtonally along the contour', () => {
    const g = notesOf(generateImageLayers(fxA, { ...literal, glide: true, structure: 0.1 }, p.settings));
    const bent = g.filter((n) => n.bend && n.bend.length > 3);
    expect(bent.length).toBeGreaterThan(3);
    expect(bent.some((n) => n.bend!.some(([, st]) => Math.abs(st - Math.round(st)) > 0.1))).toBe(true);
    // fewer, longer notes than the discrete reading: the shape is carried by the bend
    expect(g.length).toBeLessThan(notes.length);
  });
});

describe('literal ↔ musical interpretation', () => {
  test('you can hear and see the difference, and the shape stays recognisable', () => {
    const lit = notesOf(generateImageLayers(fxA, img({ interpretation: 0, fidelity: 0.6, contour: contourPreset('lineart'), density: 1 }), p.settings));
    const mus = notesOf(generateImageLayers(fxA, img({ interpretation: 1, fidelity: 0.6, contour: contourPreset('lineart'), density: 1 }), p.settings));
    // musical: fewer pitch changes, longer grouped notes
    expect(mus.length).toBeLessThan(lit.length * 0.75);
    expect(mean(mus.map((n) => n.dur))).toBeGreaterThan(mean(lit.map((n) => n.dur)) * 1.3);
    // still recognisably the same shape
    const own = mus.filter((n) => !n.id.endsWith('h'));
    expect(spearman(own.map((n) => n.src![1]), own.map((n) => n.midi))).toBeGreaterThan(0.85);
  });
});

describe('free time', () => {
  const xs = [0.06, 0.1, 0.27, 0.31, 0.44, 0.71, 0.74, 0.93];
  const bars = analyse(irregularBars(480, 240, xs, 5).img);
  test('onsets reflect the irregular spacing of the image; no drum pattern is inserted', () => {
    const layers = generateImageLayers(bars, img({ rhythm: 'free', density: 0.6 }), p.settings);
    expect(layers.some((l) => l.patch.engine === 'drums' || l.role === 'percussion')).toBe(false);
    const ev = layers.find((l) => l.key === 'image:rhythm')!;
    expect(ev).toBeDefined();
    const onsets = [...new Set(ev.notes.map((n) => Math.round(n.start * 100) / 100))].sort((a, b) => a - b);
    // every bar is heard where it begins (its leading edge, 2.5 px left of its centre) within ~2 px
    const edge = (x: number) => ((x * 480 - 2.5) / 480) * BEATS;
    for (const x of xs) expect(onsets.some((t) => Math.abs(t - edge(x)) < 0.27), `bar at ${x}`).toBe(true);
    // and nothing else: no filler between the bars
    for (const t of onsets) expect(xs.some((x) => Math.abs(t - edge(x)) < 0.27), `onset at ${t}`).toBe(true);
    // the inter-onset intervals are as irregular as the picture
    const gaps = xs.slice(1).map((x, i) => (x - xs[i]) * BEATS);
    const cv = Math.sqrt(mean(gaps.map((g) => (g - mean(gaps)) ** 2))) / mean(gaps);
    expect(cv).toBeGreaterThan(0.6);
  });

  test('image texture mode: events come from the image detail, dense where it is dense', () => {
    const tex = analyse(colorfulTexture(480, 320));
    const l = generateImageLayers(tex, img({ rhythm: 'texture', density: 0.7 }), p.settings).find((x) => x.key === 'image:rhythm')!;
    expect(l.notes.length).toBeGreaterThan(20);
    expect(l.patch.engine).toBe('glitch');
    const smooth = generateImageLayers(analyse(hazeImage(480, 320)), img({ rhythm: 'texture', density: 0.7 }), p.settings).find((x) => x.key === 'image:rhythm');
    expect(smooth?.notes.length ?? 0).toBeLessThan(l.notes.length / 4);
  });

  test('metric rhythm is an explicit opt-in and keeps the conventional drum engine', () => {
    const tex = analyse(colorfulTexture(480, 320));
    const l = generateImageLayers(tex, img({ rhythm: 'metric', density: 0.6 }), p.settings).find((x) => x.key === 'image:hybrid:perc')!;
    expect(l.patch.engine).toBe('drums');
    expect(l.notes.every((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) < 1e-6)).toBe(true);
  });
});

describe('an empty image stays silent', () => {
  const flat = analyse(uniformImage(480, 320));
  test('literal contour mode: no contour notes, no events, no invented sound', () => {
    const layers = generateImageLayers(flat, img({ interpretation: 0 }), p.settings);
    expect(layers.flatMap((l) => l.notes).length).toBe(0);
    for (const rhythm of ['free', 'texture'] as const) expect(generateImageLayers(flat, img({ rhythm }), p.settings).flatMap((l) => l.notes).length).toBe(0);
  });
  test('the atmosphere drone sounds only when explicitly configured (hybrid, atmosphere on)', () => {
    const on = generateImageLayers(flat, img({ mode: 'hybrid' }), p.settings);
    expect(on.find((l) => l.key === 'image:atmos:bed')!.notes.length).toBeGreaterThan(0);
    const off = generateImageLayers(flat, img({ mode: 'hybrid', hybrid: { ...defaultImageSettings().hybrid, atmosphere: false } }), p.settings);
    expect(off.flatMap((l) => l.notes).length).toBe(0);
  });
});

describe('the image shapes the synthesiser', () => {
  const dark = analyse(hazeImage(480, 320, 9));
  const bright = analyse(colorfulTexture(480, 320));
  const s = img({ mode: 'hybrid', evolution: 0.6 });
  const bed = (a: typeof dark) => generateImageLayers(a, s, p.settings).find((l) => l.key === 'image:atmos:bed')!;
  const laneMean = (l: ReturnType<typeof bed>, target: string) => { const lane = l.automation.find((a) => a.target === target)!; return mean(lane.points.map((x) => x.value)); };

  test('different photographs → different patches (wavetables, filter, FM, attack, noise)', () => {
    const a = bed(dark), b = bed(bright);
    expect(a.patch.engine).toBe('image');
    expect(a.patch.image!.wavesB.join()).not.toEqual(b.patch.image!.wavesB.join());
    expect(laneMean(b, 'cutoff')).toBeGreaterThan(laneMean(a, 'cutoff') + 0.08); // brighter image, brighter filter
    expect(laneMean(b, 'fmDepth')).toBeGreaterThan(laneMean(a, 'fmDepth') + 0.05); // textured image, more FM
    expect(laneMean(b, 'noise')).toBeGreaterThan(laneMean(a, 'noise'));
    expect(laneMean(b, 'attack')).toBeLessThan(laneMean(a, 'attack')); // contrast sharpens the attack
  });

  test('evolution: 0 % = a static, repeatable patch; higher = lanes that move with the image', () => {
    const still = generateImageLayers(bright, { ...s, evolution: 0 }, p.settings).find((l) => l.key === 'image:atmos:bed')!;
    expect(still.automation.filter((a) => a.origin === 'image').every((a) => a.points.length === 2 && a.points[0].value === a.points[1].value)).toBe(true);
    const moving = bed(bright);
    const cut = moving.automation.find((a) => a.target === 'cutoff')!;
    const v = cut.points.map((x) => x.value);
    expect(Math.max(...v) - Math.min(...v)).toBeGreaterThan(0.03);
  });

  test('mappings are reassignable: routing cutoff to saturation instead of brightness changes the lane', () => {
    const re = generateImageLayers(bright, { ...s, synthMap: s.synthMap.map((m) => (m.target === 'cutoff' ? { ...m, source: 'saturation' as const } : m)) }, p.settings).find((l) => l.key === 'image:atmos:bed')!;
    expect(JSON.stringify(re.automation.find((a) => a.target === 'cutoff'))).not.toEqual(JSON.stringify(bed(bright).automation.find((a) => a.target === 'cutoff')));
  });

  test('presets mode uses fixed instruments and no image timbre lanes', () => {
    const l = generateImageLayers(bright, { ...s, synth: 'presets' }, p.settings).find((x) => x.key === 'image:atmos:bed')!;
    expect(l.patch.engine).not.toBe('image');
    expect(l.automation.some((a) => a.target === 'morph')).toBe(false);
  });
});

describe('panorama: the scan travels through distinct regions', () => {
  const pimg = panoramaLandscape(2400, 300, 7);
  const pa = { grid: computeGrid(pimg, 800, 32), contours: extractContourSet(pimg, { ...contourPreset('panorama'), maxContours: 40 }) };
  const src: PanoramaSource = { asset: { assetId: 'x', name: 't', mime: 'image/png', width: 2400, height: 300, bytes: 0 }, settings: { ...defaultPanoramaSettings(), timing: 'beat', bars: 48 }, regions: defaultRegions() };
  const beats = panoramaBeats(src.settings, p.settings);
  const layers = generatePanoramaLayers(pa, src, p.settings);

  test('defaults favour contour voices, an evolving atmosphere and image-timed events — no drum kit', () => {
    const keys = layers.map((l) => l.key);
    expect(keys).toContain('pano:atmos');
    expect(keys.some((k) => k.startsWith('pano:contour:'))).toBe(true);
    expect(layers.some((l) => l.patch.engine === 'drums')).toBe(false);
    expect(keys.some((k) => k.startsWith('pano:reg_'))).toBe(false);
  });

  test('synthesis parameters, note activity and features change from zone to zone', () => {
    const atm = layers.find((l) => l.key === 'pano:atmos')!;
    const cut = atm.automation.find((a) => a.target === 'cutoff')!;
    const zoneCut = LANDSCAPE_ZONES.map((z) => mean(Array.from({ length: 20 }, (_, k) => laneValue(cut, (z.x0 + ((z.x1 - z.x0) * (k + 0.5)) / 20) * beats)!)));
    expect(Math.max(...zoneCut) - Math.min(...zoneCut)).toBeGreaterThan(0.1);
    const all = layers.flatMap((l) => l.notes);
    const perBeat = LANDSCAPE_ZONES.map((z) => all.filter((n) => n.start >= z.x0 * beats && n.start < z.x1 * beats).length / ((z.x1 - z.x0) * beats));
    expect(Math.max(...perBeat) / Math.max(0.01, Math.min(...perBeat))).toBeGreaterThan(2);
  });

  test('the atmosphere holds long notes while its timbre moves: a long scan is a timbral journey', () => {
    const atm = layers.find((l) => l.key === 'pano:atmos')!;
    expect(mean(atm.notes.map((n) => n.dur))).toBeGreaterThan(12);
    const morph = atm.automation.find((a) => a.target === 'morph')!;
    expect(morph.points.length).toBeGreaterThan(100);
  });

  test('independent ridges → independent layers: the three-ridge image gives low, middle and upper voices', () => {
    const r = ridgesImage(2400, 300);
    const ra = { grid: computeGrid(r.img, 800, 32), contours: extractContourSet(r.img, { ...contourPreset('panorama'), maxContours: 40 }) };
    const ls = generatePanoramaLayers(ra, { ...src, settings: { ...src.settings, density: 1 } }, p.settings);
    const voices = ls.filter((l) => l.key.startsWith('pano:contour:')).map((l) => l.key);
    expect(voices).toEqual(expect.arrayContaining(['pano:contour:low', 'pano:contour:mid', 'pano:contour:high']));
    // each takes its timing from its own ridge: their onsets are not the same grid
    const onsets = (k: string) => ls.find((l) => l.key === k)!.notes.map((n) => Math.round(n.start * 8) / 8);
    const a = new Set(onsets('pano:contour:mid')), b = onsets('pano:contour:high');
    expect(b.filter((t) => a.has(t)).length / b.length).toBeLessThan(0.5);
  });
});

describe('musical diversity without random noise', () => {
  const images = {
    ridges: ridgesImage(480, 320).img,
    lines: contourFixture().img,
    texture: colorfulTexture(480, 320),
    haze: hazeImage(480, 320),
    bars: irregularBars(480, 320, [0.1, 0.13, 0.4, 0.42, 0.8], 6).img,
  };
  const s = img({ mode: 'hybrid', seed: 5 });
  const describeMusic = (a: ReturnType<typeof analyse>) => {
    const layers = generateImageLayers(a, s, p.settings);
    const notes = layers.flatMap((l) => l.notes).filter((n) => n.dur < 32);
    const starts = [...new Set(notes.map((n) => n.start))].sort((x, y) => x - y);
    const ioi = starts.slice(1).map((t, i) => t - starts[i]);
    const bed = layers.find((l) => l.key === 'image:atmos:bed');
    const lane = (t: string) => { const x = bed?.automation.find((q) => q.target === t); return x ? mean(x.points.map((q) => q.value)) : 0.5; };
    return {
      density: notes.length / BEATS,
      pitch: mean(notes.map((n) => n.midi)) / 12,
      spread: Math.sqrt(mean(notes.map((n) => (n.midi - mean(notes.map((m) => m.midi))) ** 2))) / 12,
      regularity: ioi.length ? Math.sqrt(mean(ioi.map((g) => (g - mean(ioi)) ** 2))) / Math.max(1e-6, mean(ioi)) : 0,
      dur: mean(notes.map((n) => n.dur)),
      cutoff: lane('cutoff') * 4,
      morph: lane('morph') * 4,
      fm: lane('fmDepth') * 4,
    };
  };
  const desc = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, describeMusic(analyse(v))]));

  test('identical settings and seed, visually distinct images → measurably distinct music', () => {
    const keys = Object.keys(desc);
    const dist = (a: Record<string, number>, b: Record<string, number>) => Math.sqrt(Object.keys(a).reduce((acc, k) => acc + (a[k] - b[k]) ** 2, 0));
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      expect(dist(desc[keys[i]], desc[keys[j]]), `${keys[i]} vs ${keys[j]}`).toBeGreaterThan(0.25);
    }
  });

  test('the same image and seed always give the same music (no hidden randomness)', () => {
    expect(describeMusic(analyse(images.texture))).toEqual(desc.texture);
  });
});

describe('the four shaping controls', () => {
  const tex = analyse(colorfulTexture(480, 320));
  test('event density: 0 % is sparse with silences, 100 % is dense — and not a grid probability', () => {
    const lo = generateImageLayers(tex, img({ density: 0 }), p.settings).flatMap((l) => l.notes);
    const hi = generateImageLayers(tex, img({ density: 1 }), p.settings).flatMap((l) => l.notes);
    expect(hi.length).toBeGreaterThan(lo.length * 2);
    const onGrid = (ns: NoteEvent[]) => ns.filter((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) < 0.02).length / Math.max(1, ns.length);
    expect(onGrid(hi)).toBeLessThan(0.5);
  });
  test('musical structure: more structure pulls onsets toward the grid and keeps pitches in the scale', () => {
    const free = notesOf(generateImageLayers(fxA, img({ structure: 0, fidelity: 0, contour: contourPreset('lineart') }), p.settings));
    const tight = notesOf(generateImageLayers(fxA, img({ structure: 1, fidelity: 0, contour: contourPreset('lineart') }), p.settings));
    const off = (ns: NoteEvent[]) => mean(ns.map((n) => Math.abs(n.start * 2 - Math.round(n.start * 2))));
    expect(off(tight)).toBeLessThan(off(free) * 0.5);
    const scale = [0, 2, 4, 5, 7, 9, 11];
    expect(tight.every((n) => scale.includes(n.midi % 12))).toBe(true);
  });
  test('visual fidelity: high fidelity keeps register and timing close to the picture; low allows transformation', () => {
    const at = (fidelity: number) => notesOf(generateImageLayers(fxA, img({ fidelity, interpretation: 1, structure: 0.9, contour: contourPreset('lineart'), seed: 3 }), p.settings));
    const strict = at(1), loose = at(0);
    const err = (ns: NoteEvent[]) => mean(ns.filter((n) => !n.id.endsWith('h')).map((n) => Math.abs(n.start / BEATS - n.src![0])));
    expect(err(strict)).toBeLessThan(err(loose));
    expect(loose.filter((n) => n.id.endsWith('h')).length).toBeGreaterThan(strict.filter((n) => n.id.endsWith('h')).length);
  });
});

describe('older projects are not silently rewritten', () => {
  test('settings saved before the overhaul keep metric percussion, presets and classic layers', () => {
    const old = normalizeImageSettings({ mode: 'hybrid', bars: 16, edgeSensitivity: 0.7, minContour: 30, detail: 0.4, density: 0.5, smoothing: 0.3, grouping: 0.6, mapping: defaultImageSettings().mapping, hueRoutes: [0, 1, 2, 3, 1, 2], hybrid: { contour: true, bass: true, pads: true, percussion: true, filter: true }, seed: 4 });
    expect(old.rhythm).toBe('metric');
    expect(old.synth).toBe('presets');
    expect(old.hybrid.atmosphere).toBe(false);
    expect(old.contour.sensitivity).toBe(0.7);
    expect(old.contour.minLength).toBe(30);
    expect('edgeSensitivity' in old).toBe(false);
    const op = normalizePanoramaSettings({ timing: 'free', seconds: 60, bars: 32, direction: 'ltr', region: { x0: 0, x1: 1 }, path: [], scanResolution: 256, stripWidth: 0.5, sensitivity: 0.5, density: 0.5, smoothing: 0.4, polyphony: 5, threshold: 0.45, quantize: 4, seed: 1 });
    expect(op.layers).toEqual({ contours: false, atmosphere: false, events: false, regions: true });
    expect(op.rhythm).toBe('metric');
    // new projects get the new defaults
    expect(normalizeImageSettings(defaultImageSettings()).rhythm).toBe('free');
  });
});
