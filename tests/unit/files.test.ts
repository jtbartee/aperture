import { describe, expect, test } from 'vitest';
import { packProject, unpackProject } from '../../src/export/projectFile';
import { decodeWav, encodeWav } from '../../src/audio/wav';
import { simulateParticles, defaultParticles } from '../../src/interpret/particles';
import { orbitalNotes, polarFromXY, xyFromPolar } from '../../src/interpret/orbital';
import { captureScene, printArrangement } from '../../src/interpret/scenes';
import { bakeRoute } from '../../src/interpret/modmatrix';
import { computeGrid, fullMask, regionCurve } from '../../src/analysis/features';
import { panoramaLandscape } from '../../src/analysis/procedural';
import { stroke, testProject } from './helpers';
import { normalizeProject } from '../../src/state/project';

describe('project files', () => {
  test('portable project round-trips with its image; a missing image is an error, not silence', () => {
    const p = testProject();
    p.image = { asset: { assetId: 'img1', name: 'x.png', mime: 'image/png', width: 2, height: 2, bytes: 4 }, settings: normalizeProject({}).composition as any };
    const bytes = packProject(p, [{ id: 'img1', name: 'x.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const back = unpackProject(bytes);
    expect(back.project.tracks).toEqual(p.tracks);
    expect(Array.from(back.assets[0].bytes)).toEqual([1, 2, 3, 4]);
    expect(() => unpackProject(packProject(p, []))).toThrow(/not inside the file/);
    expect(() => unpackProject(new Uint8Array([1, 2, 3]))).toThrow(/not an APERTURE project/);
  });

  test('WAV encode/decode round trip (16 and 24 bit)', () => {
    const l = Float32Array.from({ length: 441 }, (_, i) => Math.sin(i / 7) * 0.5);
    const r = Float32Array.from({ length: 441 }, (_, i) => Math.cos(i / 9) * 0.25);
    for (const bits of [16, 24] as const) {
      const w = decodeWav(encodeWav([l, r], 44100, bits));
      expect(w.sampleRate).toBe(44100);
      expect(w.channels.length).toBe(2);
      for (let i = 0; i < 441; i += 37) expect(w.channels[0][i]).toBeCloseTo(l[i], bits === 16 ? 3 : 5);
    }
  });
});

describe('experimental sequencers', () => {
  test('particles are deterministic and trigger in zones', () => {
    const p = testProject();
    const src = { ...defaultParticles(), zones: [{ id: 'z', x: 0, y: 0.5, w: 1, h: 0.5, trackId: p.tracks[0].id }] };
    const a = simulateParticles(src, p.tracks, p.settings);
    const b = simulateParticles(src, p.tracks, p.settings);
    expect(a.notes.get(p.tracks[0].id)!.length).toBeGreaterThan(3);
    expect(a.notes).toEqual(b.notes);
    expect(simulateParticles({ ...src, seed: 99 }, p.tracks, p.settings).notes).not.toEqual(a.notes);
  });

  test('orbital: angle is time, radius is pitch, direction reverses time', () => {
    const p = testProject();
    const t = p.tracks[0];
    const s = stroke(t.id, [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.9 }], { kind: 'legato' });
    const cw = orbitalNotes({ bars: 4, direction: 'cw', trackId: t.id, strokes: [s] }, t, p.settings).notes;
    const ccw = orbitalNotes({ bars: 4, direction: 'ccw', trackId: t.id, strokes: [s] }, t, p.settings).notes;
    expect(cw[0].start).toBeLessThan(cw[cw.length - 1].start);
    expect(cw[cw.length - 1].midi).toBeGreaterThan(cw[0].midi);
    // counter-clockwise: the same arc is reached at 1 − angle, so it plays later and reversed
    expect(Math.min(...ccw.map((n) => n.start))).toBeGreaterThan(Math.max(...cw.map((n) => n.start)));
    expect(ccw[0].midi).toBeGreaterThan(ccw[ccw.length - 1].midi);
    const pol = polarFromXY(0.75, 0.5);
    expect(pol.angle).toBeCloseTo(0.25);
    const xy = xyFromPolar(pol.angle, pol.radius);
    expect(xy.x).toBeCloseTo(0.75); expect(xy.y).toBeCloseTo(0.5);
  });

  test('scenes print into a linear arrangement', () => {
    const p = testProject();
    p.tracks[0].notes = [{ id: 'a', start: 0, dur: 1, midi: 60, vel: 1, origin: 'user' }];
    const A = captureScene(p, 'A', 'Intro');
    p.tracks[0].notes = [{ id: 'b', start: 2, dur: 1, midi: 67, vel: 1, origin: 'user' }];
    const B = captureScene(p, 'B', 'Main');
    p.scenes = [A, B];
    const { tracks, bars } = printArrangement(p, [{ sceneId: 'A', repeats: 2 }, { sceneId: 'B', repeats: 1 }]);
    expect(bars).toBe(24);
    expect(tracks[0].notes.map((n) => [n.midi, n.start])).toEqual([[60, 0], [60, 32], [67, 66]]);
  });

  test('modulation routes bake smoothed automation from image features', () => {
    const grid = computeGrid(panoramaLandscape(600, 100, 2), 200, 16);
    const cv = regionCurve(grid, fullMask, { steps: 128, sensitivity: 0.5, strip: 0.5, smoothing: 0 });
    const lane = bakeRoute({ id: 'r', source: 'brightness', trackId: 't', target: 'cutoff', amount: 1, smoothing: 0.8, from: 'panorama' }, cv, 64);
    const raw = bakeRoute({ id: 'r', source: 'brightness', trackId: 't', target: 'cutoff', amount: 1, smoothing: 0, from: 'panorama' }, cv, 64);
    const jumps = (l: typeof lane) => Math.max(...l.points.slice(1).map((pt, i) => Math.abs(pt.value - l.points[i].value)));
    expect(jumps(lane)).toBeLessThan(jumps(raw));
    const inv = bakeRoute({ id: 'r', source: 'brightness', trackId: 't', target: 'cutoff', amount: -1, smoothing: 0, from: 'panorama' }, cv, 64);
    expect(inv.points[10].value + raw.points[10].value).toBeCloseTo(1, 5);
  });
});
