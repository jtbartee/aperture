import { describe, expect, test } from 'vitest';
import { colorfulTexture, darkUniform, geometricImage, hazeImage } from '../../src/analysis/procedural';
import { computeGrid, curveSummary, extractContours, fullMask, regionCurve } from '../../src/analysis/features';
import { defaultImageSettings, generateImageLayers } from '../../src/interpret/imageModes';
import { testProject, mean } from './helpers';
import type { ImageMode } from '../../src/core/types';

function analyse(img: ReturnType<typeof darkUniform>) {
  return { grid: computeGrid(img, 96, 24), gestures: extractContours(img, { sensitivity: 0.55, minLength: 24, detail: 0.5, maxGestures: 80 }) };
}

const dark = analyse(darkUniform(240, 160));
const bright = analyse(colorfulTexture(240, 160));
const haze = analyse(hazeImage(240, 160));

describe('image analysis', () => {
  test('features measure what they claim', () => {
    const d = curveSummary(regionCurve(dark.grid, fullMask, { steps: 32, sensitivity: 0.5, strip: 0, smoothing: 0 }));
    const b = curveSummary(regionCurve(bright.grid, fullMask, { steps: 32, sensitivity: 0.5, strip: 0, smoothing: 0 }));
    expect(b.brightness).toBeGreaterThan(d.brightness + 0.2);
    expect(b.saturation).toBeGreaterThan(d.saturation + 0.3);
    expect(b.edges).toBeGreaterThan(d.edges + 0.1);
    expect(b.texture).toBeGreaterThan(d.texture);
  });

  test('contours: the geometric image yields grouped gestures, not one note per edge pixel', () => {
    const g = extractContours(geometricImage(320, 200), { sensitivity: 0.5, minLength: 20, detail: 0.5, maxGestures: 80 });
    expect(g.length).toBeGreaterThan(2);
    expect(g.length).toBeLessThan(80);
    expect(Math.max(...g.map((x) => x.length))).toBeGreaterThan(50);
    expect(dark.gestures.length).toBeLessThan(g.length);
  });

  test('Example C: a dark uniform photo and a bright textured one make meaningfully different music in every mode', () => {
    const p = testProject();
    for (const mode of ['contour', 'color', 'atmos', 'hybrid'] as ImageMode[]) {
      const s = { ...defaultImageSettings(), mode, bars: 8 };
      const a = generateImageLayers(dark, s, p.settings).flatMap((l) => l.notes);
      const b = generateImageLayers(bright, s, p.settings).flatMap((l) => l.notes);
      // the textured image is much busier and louder
      expect(b.length, mode).toBeGreaterThan(a.length * 1.5 + 3);
      if (a.length && b.length && mode !== 'atmos') expect(mean(b.map((n) => n.vel)), mode).not.toBeCloseTo(mean(a.map((n) => n.vel)), 2);
    }
  });

  test('colour mapping is reassignable: mapping pitch to a different feature changes the music', () => {
    const p = testProject();
    const s = { ...defaultImageSettings(), mode: 'color' as const, bars: 8 };
    const a = generateImageLayers(bright, s, p.settings).flatMap((l) => l.notes.map((n) => n.midi));
    const b = generateImageLayers(bright, { ...s, mapping: { ...s.mapping, pitch: 'hue' } }, p.settings).flatMap((l) => l.notes.map((n) => n.midi));
    expect(a.join()).not.toEqual(b.join());
    // hue routing table moves notes between colour voices
    const routed = generateImageLayers(bright, { ...s, hueRoutes: [3, 3, 3, 3, 3, 3] }, p.settings);
    expect(routed.find((l) => l.key === 'image:color:3')!.notes.length).toBeGreaterThan(0);
  });

  test('atmospheric mode: a quiet region yields a sparser texture than a busy one, plus automation', () => {
    const p = testProject();
    const s = { ...defaultImageSettings(), mode: 'atmos' as const, bars: 8 };
    const q = generateImageLayers(haze, s, p.settings);
    const b = generateImageLayers(bright, s, p.settings);
    const qn = q.flatMap((l) => l.notes).length;
    const bn = b.flatMap((l) => l.notes).length;
    expect(bn).toBeGreaterThan(qn);
    expect(q.find((l) => l.key === 'image:atmos:pad')!.automation.some((a) => a.target === 'cutoff')).toBe(true);
  });

  test('atmospheric fragments follow luminous features: a soft haze gets a few, a dark frame fewer', () => {
    const p = testProject();
    const s = { ...defaultImageSettings(), mode: 'atmos' as const, bars: 24 };
    const frag = (a: typeof haze) => generateImageLayers(a, s, p.settings).find((l) => l.key === 'image:atmos:melody')!.notes;
    const h = frag(haze), d = frag(dark), b = frag(bright);
    expect(h.length).toBeGreaterThan(3);
    expect(d.length).toBeLessThan(h.length);
    expect(b.length).toBeGreaterThan(h.length);
    expect(Math.min(...h.map((n) => n.dur))).toBeGreaterThanOrEqual(3);
  });

  test('regeneration is deterministic; a new seed varies only what is random', () => {
    const p = testProject();
    const s = { ...defaultImageSettings(), mode: 'hybrid' as const, bars: 8 };
    expect(generateImageLayers(bright, s, p.settings)).toEqual(generateImageLayers(bright, s, p.settings));
    const other = generateImageLayers(bright, { ...s, seed: 99 }, p.settings);
    expect(JSON.stringify(other)).not.toEqual(JSON.stringify(generateImageLayers(bright, s, p.settings)));
    // single layer regeneration returns only that layer
    expect(generateImageLayers(bright, s, p.settings, 'image:hybrid:bass').map((l) => l.key)).toEqual(['image:hybrid:bass']);
  });
});
