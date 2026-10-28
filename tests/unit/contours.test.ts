// Contour fidelity: the traced paths must reproduce the drawn geometry, not merely exist.
import { describe, expect, test } from 'vitest';
import { contourFixture, ridgesImage, uniformImage, hazeImage, strokeImage } from '../../src/analysis/procedural';
import { catmullRom, contourPreset, extractContourSet, monotonePieces, type ContourSet } from '../../src/analysis/contours';
import { matchTruth } from '../../src/analysis/contourMetrics';
import { extractContours as legacyExtract } from './legacy/oldFeatures';

const fx = contourFixture();
const set = extractContourSet(fx.img, contourPreset('lineart'));
const truth = (name: string) => fx.truth.find((t) => t.name === name)!.pts;

describe('contour fidelity fixture (rising, falling, sinusoid, two crossing lines, a branch)', () => {
  test('every drawn curve is covered, accurately, as one continuous path', () => {
    for (const t of fx.truth) {
      const m = matchTruth(set, t.pts);
      expect(m.coverage, `${t.name} coverage`).toBeGreaterThan(0.95);
      expect(m.rms, `${t.name} reconstruction error (px)`).toBeLessThan(1.5);
      expect(m.continuity, `${t.name} continuity`).toBeGreaterThan(0.9);
      expect(m.pieces, `${t.name} pieces`).toBe(1);
    }
  });

  test('the sinusoid keeps its oscillation: four peaks and troughs, ±22 px', () => {
    const c = set.contours.find((x) => x.id === matchTruth(set, truth('sine')).dominant)!;
    const ys = catmullRom(c.pts, 0.002).map((p) => (1 - p.y) * set.height);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(40);
    // extrema with at least 10 px prominence on the interpolated curve
    const ext: number[] = [];
    const R = 30;
    for (let i = R; i < ys.length - R; i++) {
      const win = ys.slice(i - R, i + R + 1);
      if ((ys[i] === Math.max(...win) || ys[i] === Math.min(...win)) && Math.abs(ys[i] - 272) > 10 && (!ext.length || Math.abs(ys[i] - ext[ext.length - 1]) > 10)) ext.push(ys[i]);
    }
    expect(ext.length).toBe(4);
    for (const e of ext) expect(Math.abs(Math.abs(e - 272) - 22)).toBeLessThan(3);
  });

  test('two overlapping lines that cross stay two independent contours through the crossing', () => {
    const a = matchTruth(set, truth('crossA')), b = matchTruth(set, truth('crossB'));
    expect(a.dominant).not.toBe(b.dominant);
    expect(a.continuity).toBeGreaterThan(0.95);
    expect(b.continuity).toBeGreaterThan(0.95);
    // and they overlap in time: both span the same x range
    const span = (id: string) => { const c = set.contours.find((x) => x.id === id)!; return [Math.min(...c.pts.map((p) => p.x)), Math.max(...c.pts.map((p) => p.x))]; };
    const [a0, a1] = span(a.dominant!), [b0, b1] = span(b.dominant!);
    expect(Math.min(a1, b1) - Math.max(a0, b0)).toBeGreaterThan(0.3);
  });

  test('the branching contour: a junction at the fork, the trunk continues into one arm, the other is a branch of it', () => {
    const fork = { x: 110 / 480, y: 1 - 190 / 320 };
    expect(set.junctions.some((j) => Math.hypot(j.x - fork.x, (j.y - fork.y) * (320 / 480)) < 0.03)).toBe(true);
    const trunk = matchTruth(set, truth('trunk')).dominant;
    const up = matchTruth(set, truth('branchUp')).dominant;
    const down = matchTruth(set, truth('branchDown')).dominant;
    // good continuation: the trunk joins the straighter arm
    expect(new Set([trunk, up, down]).size).toBe(2);
    const branch = set.contours.find((c) => c.parent !== undefined);
    expect(branch).toBeDefined();
    expect([up, down]).toContain(branch!.id);
  });

  test('a closed loop and a vertical edge are kept, not flattened', () => {
    const loop = Array.from({ length: 200 }, (_, i) => ({ x: 120 + 60 * Math.cos((i / 199) * Math.PI * 2), y: 100 + 40 * Math.sin((i / 199) * Math.PI * 2) }));
    const vertical = Array.from({ length: 140 }, (_, i) => ({ x: 300, y: 30 + i }));
    const s2 = extractContourSet(strokeImage(400, 200, [{ name: 'loop', pts: loop }, { name: 'v', pts: vertical }]), contourPreset('lineart'));
    const lc = s2.contours.find((c) => c.id === matchTruth(s2, loop).dominant)!;
    expect(lc.closed).toBe(true);
    // a loop becomes two simultaneous x-monotone lines (upper and lower arc)
    expect(monotonePieces(lc, 1.5 / 400).length).toBe(2);
    const vm = matchTruth(s2, vertical);
    expect(vm.coverage).toBeGreaterThan(0.9);
    const vc = s2.contours.find((c) => c.id === vm.dominant)!;
    expect(vc.orientation).toBeGreaterThan(0.9);
    expect(monotonePieces(vc, 1.5 / 400)[0].vertical).toBe(true);
  });

  test('coordinates are source-normalised: contours land where the curves were drawn', () => {
    const m = matchTruth(set, truth('falling'));
    const c = set.contours.find((x) => x.id === m.dominant)!;
    const xs = c.pts.map((p) => p.x * 480);
    expect(Math.min(...xs)).toBeLessThan(146);
    expect(Math.max(...xs)).toBeGreaterThan(234);
  });
});

describe('contours on photographs and empty images', () => {
  test('three overlapping mountain ridges → three independent, full-width contours in height order', () => {
    const { img, ridges } = ridgesImage(560, 320);
    const s = extractContourSet(img, contourPreset('photo'));
    const long = s.contours.filter((c) => c.length > 400);
    expect(long.length).toBe(3);
    const heights = long.map((c) => c.pts.reduce((a, p) => a + p.y, 0) / c.pts.length).sort();
    const expected = ridges.map((f) => 1 - Array.from({ length: 50 }, (_, i) => f(i / 49)).reduce((a, b) => a + b, 0) / 50).sort();
    heights.forEach((h, i) => expect(Math.abs(h - expected[i])).toBeLessThan(0.03));
  });

  test('a uniform image and a soft haze have no contours', () => {
    expect(extractContourSet(uniformImage(320, 200), contourPreset('photo')).contours.length).toBe(0);
    expect(extractContourSet(hazeImage(320, 200), contourPreset('photo')).contours.length).toBe(0);
  });

  test('controls do what they say', () => {
    const lo = extractContourSet(fx.img, { ...contourPreset('lineart'), detail: 0 });
    const hi = extractContourSet(fx.img, { ...contourPreset('lineart'), detail: 1 });
    const verts = (s: ContourSet) => s.contours.reduce((a, c) => a + c.pts.length, 0);
    expect(verts(hi)).toBeGreaterThan(verts(lo) * 1.5);
    expect(extractContourSet(fx.img, { ...contourPreset('lineart'), maxContours: 3 }).contours.length).toBe(3);
    expect(extractContourSet(fx.img, { ...contourPreset('lineart'), minLength: 200 }).contours.every((c) => c.length >= 200)).toBe(true);
    // high separation keeps both sides of a drawn line apart; low merges them into one centreline
    const thickLine = strokeImage(300, 120, [{ name: 'l', pts: Array.from({ length: 260 }, (_, i) => ({ x: 20 + i, y: 60 })) }], { width: 5 });
    expect(extractContourSet(thickLine, { ...contourPreset('lineart'), separation: 0 }).contours.length).toBe(1);
    expect(extractContourSet(thickLine, { ...contourPreset('lineart'), separation: 1 }).contours.length).toBe(2);
  });

  test('compared with the old bucketed extractor: crossings stay continuous, loops are traced, error drops', () => {
    const asSet = (old: ReturnType<typeof legacyExtract>, w: number, h: number): ContourSet => ({ contours: old.map((g, i) => ({ id: `g${i}`, pts: g.points, str: [], curv: [], closed: false, length: g.length, intensity: g.intensity, thickness: 0, curvature: 0, orientation: 0, coarse: 1, rank: i })), junctions: [], width: w, height: h, stats: { edgePixels: 0, skeletonPixels: 0, chains: 0, closed: 0, branched: 0 } });
    const legacy = asSet(legacyExtract(fx.img, { sensitivity: 0.55, minLength: 24, detail: 0.5, maxGestures: 80 }), 480, 320);
    for (const name of ['crossA', 'crossB']) {
      const o = matchTruth(legacy, truth(name), 2), n = matchTruth(set, truth(name), 2);
      expect(o.continuity, `${name} old`).toBeLessThan(0.8); // the old chains swap lines at the crossing
      expect(n.continuity, name).toBeGreaterThan(0.95);
    }
    const loop = Array.from({ length: 200 }, (_, i) => ({ x: 120 + 60 * Math.cos((i / 199) * Math.PI * 2), y: 100 + 40 * Math.sin((i / 199) * Math.PI * 2) }));
    const li = strokeImage(300, 200, [{ name: 'loop', pts: loop }]);
    const lo = matchTruth(asSet(legacyExtract(li, { sensitivity: 0.55, minLength: 24, detail: 0.5, maxGestures: 80 }), 300, 200), loop, 1.5);
    const ln = matchTruth(extractContourSet(li, contourPreset('lineart')), loop, 1.5);
    expect(lo.coverage).toBeLessThan(0.85); // the old x-buckets lose the loop's left and right ends
    expect(ln.coverage).toBeGreaterThan(0.97);
    expect(ln.pieces).toBe(1);
    const rms = (s: ContourSet) => fx.truth.reduce((a, t) => a + matchTruth(s, t.pts, 2).rms, 0) / fx.truth.length;
    expect(rms(set)).toBeLessThan(rms(legacy));
  });
});
