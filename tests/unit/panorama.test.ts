import { describe, expect, test } from 'vitest';
import { panoramaLandscape, LANDSCAPE_ZONES } from '../../src/analysis/procedural';
import { computeGrid, regionCurve, fullMask } from '../../src/analysis/features';
import { defaultPanoramaSettings, defaultRegions, generatePanoramaLayers, panoramaBeats, panoramaSeconds, scanPoint, timeForX, viewportOffset } from '../../src/interpret/panorama';
import { testProject, mean } from './helpers';
import type { PanoramaSource } from '../../src/core/types';

const img = panoramaLandscape(1800, 300, 7);
const grid = computeGrid(img, 600, 32);

function source(patch: Partial<PanoramaSource['settings']> = {}): PanoramaSource {
  const regions = defaultRegions().map((r) => ({ ...r, enabled: true }));
  return { asset: { assetId: 'x', name: 'test', mime: 'image/png', width: 1800, height: 300, bytes: 0 }, settings: { ...defaultPanoramaSettings(), timing: 'beat', bars: 48, ...patch }, regions };
}

describe('panorama', () => {
  test('timing modes never contradict each other', () => {
    const ps = { bpm: 120, timeSig: '4/4' as const };
    const free = { ...defaultPanoramaSettings(), timing: 'free' as const, seconds: 240 };
    expect(panoramaBeats(free, ps)).toBe(480);
    expect(panoramaSeconds(free, { ...ps, bpm: 60 })).toBe(240); // seconds stay fixed in free time
    const sync = { ...defaultPanoramaSettings(), timing: 'beat' as const, bars: 32 };
    expect(panoramaBeats(sync, ps)).toBe(128);
    expect(panoramaSeconds(sync, { ...ps, bpm: 60 })).toBe(128); // bars stay fixed in beat sync
  });

  test('scan directions map time to image position', () => {
    const s = defaultPanoramaSettings();
    expect(scanPoint(0.25, s).x).toBe(0.25);
    expect(scanPoint(0.25, { ...s, direction: 'rtl' }).x).toBe(0.75);
    expect(scanPoint(0.75, { ...s, direction: 'pingpong' }).x).toBeCloseTo(0.5);
    expect(scanPoint(0.5, { ...s, direction: 'region', region: { x0: 0.2, x1: 0.6 } }).x).toBeCloseTo(0.4);
    const path = { ...s, direction: 'path' as const, path: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }] };
    expect(scanPoint(0.5, path).x).toBeCloseTo(0.5);
    expect(scanPoint(0.5, path).y).toBeCloseTo(0.5);
  });

  test('Example J: seeking to a normalised position aligns playhead, analysed strip and music', () => {
    const p = testProject();
    const src = source();
    const beats = panoramaBeats(src.settings, p.settings);
    const n = 256;
    const cv = regionCurve(grid, fullMask, { steps: n, sensitivity: 0.5, strip: 0.5, smoothing: 0, path: Array.from({ length: n }, (_, j) => scanPoint(j / (n - 1), src.settings)) });
    for (const x of [0.1, 0.37, 0.5, 0.82]) {
      const t = timeForX(x, src.settings);
      const beat = t * beats;
      // the display puts that image column exactly under the fixed playhead
      const dispW = 9000, vpW = 1200;
      expect(viewportOffset(scanPoint(beat / beats, src.settings).x, dispW, vpW) + vpW / 2).toBeCloseTo(x * dispW, 6);
      // the analysed strip at that moment is the strip at that image position
      const idx = Math.round((beat / beats) * (n - 1));
      const xAt = scanPoint(idx / (n - 1), src.settings).x;
      expect(xAt).toBeCloseTo(x, 2);
      const direct = regionCurve(grid, fullMask, { steps: n, sensitivity: 0.5, strip: 0.5, smoothing: 0, path: Array.from({ length: n }, () => ({ x: xAt })) });
      expect(cv.brightness[idx]).toBeCloseTo(direct.brightness[0], 6);
    }
  });

  test('Example D: the music changes as the playhead passes through distinct visual zones', () => {
    const p = testProject();
    const src = source();
    const beats = panoramaBeats(src.settings, p.settings);
    const layers = generatePanoramaLayers(grid, src, p.settings);
    expect(layers.length).toBe(5);
    const all = layers.flatMap((l) => l.notes.map((n) => ({ ...n, layer: l.key })));
    const zoneStats = LANDSCAPE_ZONES.map((z) => {
      const ns = all.filter((n) => n.start >= z.x0 * beats && n.start < z.x1 * beats);
      const perBeat = ns.length / ((z.x1 - z.x0) * beats);
      const perc = ns.filter((n) => n.layer === 'pano:reg_detail').length / ((z.x1 - z.x0) * beats);
      return { perBeat, perc, pitch: mean(ns.filter((n) => n.layer === 'pano:reg_middle').map((n) => n.midi)) };
    });
    // the dense forest is far busier than the still lake
    expect(zoneStats[1].perBeat).toBeGreaterThan(zoneStats[2].perBeat * 1.5);
    expect(zoneStats[1].perc).toBeGreaterThan(zoneStats[2].perc);
    // densities genuinely vary across the journey
    const d = zoneStats.map((z) => z.perBeat);
    expect(Math.max(...d) / Math.max(0.01, Math.min(...d))).toBeGreaterThan(2);
  });

  test('regions are coordinate-based and reassignable; one layer regenerates alone', () => {
    const p = testProject();
    const src = source();
    const swapped: PanoramaSource = { ...src, regions: src.regions.map((r) => (r.id === 'reg_upper' ? { ...r, role: 'arp' } : r)) };
    const a = generatePanoramaLayers(grid, src, p.settings).find((l) => l.key === 'pano:reg_upper')!;
    const b = generatePanoramaLayers(grid, swapped, p.settings).find((l) => l.key === 'pano:reg_upper')!;
    expect(a.role).toBe('pad');
    expect(b.role).toBe('arp');
    expect(b.notes.length).not.toBe(a.notes.length);
    expect(generatePanoramaLayers(grid, src, p.settings, 'pano:reg_lower').map((l) => l.key)).toEqual(['pano:reg_lower']);
  });

  test('scan resolution changes the amount of musical detail', () => {
    const p = testProject();
    const lo = generatePanoramaLayers(grid, source({ scanResolution: 32 }), p.settings).find((l) => l.key === 'pano:reg_middle')!;
    const hi = generatePanoramaLayers(grid, source({ scanResolution: 512 }), p.settings).find((l) => l.key === 'pano:reg_middle')!;
    expect(JSON.stringify(lo.notes)).not.toEqual(JSON.stringify(hi.notes));
  });
});
