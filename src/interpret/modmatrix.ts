// MODULATION MATRIX: image features → track parameters. Routes are baked into automation lanes
// (origin 'modmatrix') sampled from the cached feature curve, so playback, offline render and the
// UI all read the same values; smoothing avoids zipper noise and jumps.

import type { AutomationLane, FeatureKey, ModRoute, ModTarget } from '../core/types';
import { type Curve, type CurveKey, curveValue } from '../analysis/features';

export const MOD_TARGETS: { id: ModTarget; label: string; needs?: string }[] = [
  { id: 'cutoff', label: 'Filter cutoff' },
  { id: 'volume', label: 'Level' },
  { id: 'pan', label: 'Stereo pan' },
  { id: 'reverbSend', label: 'Reverb send' },
  { id: 'delaySend', label: 'Delay send' },
  { id: 'drive', label: 'Saturation drive', needs: 'distortion' },
  { id: 'delayFeedback', label: 'Delay feedback', needs: 'delay / ping-pong / atmospheric sweep' },
  { id: 'tremoloRate', label: 'Tremolo rate', needs: 'tremolo' },
  { id: 'chorusDepth', label: 'Chorus depth', needs: 'chorus' },
  { id: 'crush', label: 'Bitcrush amount', needs: 'bitcrusher' },
  { id: 'sweepDepth', label: 'Atmospheric sweep mix', needs: 'atmospheric sweep' },
];

export const FEATURE_KEYS: { id: FeatureKey; label: string }[] = [
  { id: 'brightness', label: 'Brightness' },
  { id: 'saturation', label: 'Saturation' },
  { id: 'hue', label: 'Hue' },
  { id: 'contrast', label: 'Contrast' },
  { id: 'edges', label: 'Edge activity' },
  { id: 'texture', label: 'Texture density' },
  { id: 'variation', label: 'Visual change' },
  { id: 'centroid', label: 'Vertical brightness position' },
];

export function bakeRoute(route: ModRoute, cv: Curve, beats: number): AutomationLane {
  const pts: { beat: number; value: number }[] = [];
  const a = 1 - Math.min(0.97, route.smoothing);
  let y = NaN;
  for (let b = 0; b <= beats + 1e-6; b += 0.25) {
    const f = route.source === 'none' ? 0.5 : curveValue(cv, route.source as CurveKey, b / beats);
    const target = Math.max(0, Math.min(1, 0.5 + route.amount * (f - 0.5) * 2));
    y = Number.isNaN(y) ? target : y + a * (target - y);
    pts.push({ beat: b, value: y });
  }
  return { id: `mod_${route.id}`, target: route.target, points: pts, origin: 'modmatrix' };
}
