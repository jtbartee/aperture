// Original procedurally generated images for the factory projects and tests — no third-party
// artwork. Pure functions producing RGBA arrays.

import type { RGBAImage } from './features';
import { hash32 } from '../core/rng';

function valueNoise(seed: number) {
  // integer lattice hash (fast; string hashing per lookup would take tens of seconds on a panorama)
  const s0 = hash32(seed) | 0;
  const H = (x: number, y: number) => {
    let t = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + s0) | 0;
    t = Math.imul(t ^ (t >>> 13), 1274126177);
    t ^= t >>> 16;
    return (t >>> 0) / 4294967295;
  };
  const sm = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = sm(x - xi), yf = sm(y - yi);
    const a = H(xi, yi), b = H(xi + 1, yi), c = H(xi, yi + 1), d = H(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, oct: number) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += amp * noise(x * f, y * f); norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp255 = (x: number) => Math.max(0, Math.min(255, Math.round(x)));

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function blank(w: number, h: number): RGBAImage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

/** Near-black, visually uniform frame with faint grain. */
export function darkUniform(w: number, h: number, seed = 1): RGBAImage {
  const img = blank(w, h);
  const n = valueNoise(seed);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = 14 + n(x * 0.05, y * 0.05) * 6;
    const j = (y * w + x) * 4;
    img.data[j] = v; img.data[j + 1] = v; img.data[j + 2] = v + 2; img.data[j + 3] = 255;
  }
  return img;
}

/** Bright, saturated, highly textured abstract: stripes, discs and fine grain. */
export function colorfulTexture(w: number, h: number, seed = 2): RGBAImage {
  const img = blank(w, h);
  const n = valueNoise(seed);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const stripe = Math.sin(x * 0.18 + Math.sin(y * 0.07) * 3) > 0 ? 1 : 0;
    const hue = (x / w + fbm(n, x * 0.02, y * 0.02, 3) * 0.6 + stripe * 0.15) % 1;
    const grain = n(x * 0.9, y * 0.9);
    const [r, g, b] = hsl(hue, 0.85, 0.35 + stripe * 0.25 + grain * 0.2);
    const j = (y * w + x) * 4;
    img.data[j] = clamp255(r); img.data[j + 1] = clamp255(g); img.data[j + 2] = clamp255(b); img.data[j + 3] = 255;
  }
  return img;
}

/** Soft atmospheric haze: slow colour gradients, luminous blobs, almost no edges. */
export function hazeImage(w: number, h: number, seed = 3): RGBAImage {
  const img = blank(w, h);
  const n = valueNoise(seed);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h;
    const fog = fbm(n, u * 3, v * 2, 4);
    const glow = Math.exp(-(((u - 0.3) ** 2) / 0.02 + ((v - 0.35) ** 2) / 0.03)) * 0.5 + Math.exp(-(((u - 0.75) ** 2) / 0.03 + ((v - 0.6) ** 2) / 0.02)) * 0.4;
    const hue = mix(0.58, 0.82, u) + fog * 0.08;
    const [r, g, b] = hsl(hue % 1, 0.35 + glow * 0.2, 0.18 + fog * 0.25 + glow * 0.35 + (1 - v) * 0.08);
    const j = (y * w + x) * 4;
    img.data[j] = clamp255(r); img.data[j + 1] = clamp255(g); img.data[j + 2] = clamp255(b); img.data[j + 3] = 255;
  }
  return img;
}

/** Bold geometric composition (circles, bars, diagonal), used by "Geometry in Motion" art. */
export function geometricImage(w: number, h: number): RGBAImage {
  const img = blank(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h;
    let c: [number, number, number] = [24, 26, 30];
    if (Math.hypot(u - 0.25, v - 0.4) < 0.15) c = [230, 120, 60];
    if (Math.abs(u - 0.55) < 0.03 && v > 0.15 && v < 0.85) c = [90, 180, 220];
    if (Math.abs(v - (1 - u) * 0.9) < 0.015) c = [240, 220, 120];
    if (u > 0.68 && u < 0.92 && v > 0.55 && v < 0.75) c = [140, 220, 140];
    const j = (y * w + x) * 4;
    img.data[j] = c[0]; img.data[j + 1] = c[1]; img.data[j + 2] = c[2]; img.data[j + 3] = 255;
  }
  return img;
}

export const LANDSCAPE_ZONES = [
  { name: 'Dawn ridges', x0: 0, x1: 0.18 },
  { name: 'Dense forest', x0: 0.18, x1: 0.36 },
  { name: 'Still lake', x0: 0.36, x1: 0.52 },
  { name: 'Snow crags', x0: 0.52, x1: 0.68 },
  { name: 'Dune sea at dusk', x0: 0.68, x1: 0.84 },
  { name: 'Night lights', x0: 0.84, x1: 1 },
];

/** A wide landscape with six visually distinct zones: the sky's light travels dawn → night and
 *  the terrain changes character (smooth, dense texture, mirror-flat, jagged, rolling, sparse lights). */
export function panoramaLandscape(w: number, h: number, seed = 7): RGBAImage {
  const img = blank(w, h);
  const n = valueNoise(seed);
  const zoneAt = (u: number) => LANDSCAPE_ZONES.findIndex((z) => u >= z.x0 && u < z.x1 + 1e-9);
  // horizon height per column from ridged fbm, shaped per zone
  const horizon = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const u = x / w;
    const z = zoneAt(u);
    const base = fbm(n, u * 22, 0.5, 5);
    const ridge = 1 - Math.abs(fbm(n, u * 60, 3.3, 4) * 2 - 1);
    const shape = [0.45 + base * 0.2, 0.5 + base * 0.08, 0.62, 0.3 + ridge * 0.3, 0.55 + Math.sin(u * 140) * 0.04 + base * 0.05, 0.62 + base * 0.04][Math.max(0, z)];
    horizon[x] = shape;
  }
  // smooth the transitions between zones
  const sm = new Float32Array(w);
  const k = Math.max(1, Math.round(w * 0.004));
  for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let d = -k; d <= k; d++) { const xx = Math.min(w - 1, Math.max(0, x + d)); s += horizon[xx]; c++; }
    sm[x] = s / c;
  }
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const z = zoneAt(u);
      const hz = sm[x];
      // sky: dawn rose → day blue → dusk amber → night indigo
      const skyHue = u < 0.5 ? mix(0.95, 1.58, u * 2) % 1 : mix(0.08, 0.68, (u - 0.5) * 2);
      const skyL = u < 0.84 ? mix(0.62, 0.42, v / Math.max(0.01, hz)) * (u > 0.68 ? mix(1, 0.6, (u - 0.68) / 0.16) : 1) : 0.1 + (1 - v) * 0.05;
      let r: number, g: number, b: number;
      if (v < hz) {
        const cloud = fbm(n, u * 40, v * 6, 4);
        [r, g, b] = hsl(skyHue, 0.45, Math.min(0.9, skyL + (cloud - 0.5) * (z === 5 ? 0.02 : 0.12)));
        if (z === 5 && n(x * 0.7, y * 0.7) > 0.985) { r = g = b = 235; }
      } else {
        const d = (v - hz) / Math.max(0.01, 1 - hz); // depth below the horizon
        switch (z) {
          case 0: { const t = fbm(n, u * 30, v * 8, 3); [r, g, b] = hsl(0.85, 0.25, 0.2 + t * 0.15 - d * 0.08); break; }
          case 1: { const t = n(x * 0.35, y * 0.35); const tt = fbm(n, x * 0.08, y * 0.08, 3); [r, g, b] = hsl(0.3 + tt * 0.06, 0.6, 0.1 + t * 0.28 * tt + 0.04); break; }
          case 2: {
            // mirror of the sky, very smooth
            const mv = hz - (v - hz) * 0.8;
            const ripple = Math.sin(v * 300 + u * 20) * 0.01;
            [r, g, b] = hsl(skyHue, 0.4, mix(0.62, 0.42, Math.max(0, mv) / Math.max(0.01, hz)) * 0.8 + ripple);
            break;
          }
          case 3: { const t = fbm(n, x * 0.05, y * 0.05, 5); const snow = d < 0.25 + t * 0.2 ? 1 : 0; [r, g, b] = snow ? hsl(0.6, 0.1, 0.78 + t * 0.15) : hsl(0.08, 0.1, 0.18 + t * 0.35); break; }
          case 4: { const dune = Math.sin(u * 900 + fbm(n, u * 20, v * 3, 3) * 6 + v * 30) * 0.5 + 0.5; [r, g, b] = hsl(0.07, 0.7, 0.32 + dune * 0.22 - d * 0.1); break; }
          default: {
            const lit = n(x * 0.25, y * 0.25) > 0.9 ? 1 : 0;
            [r, g, b] = lit ? hsl(0.12 + n(x, y) * 0.1, 0.9, 0.65) : hsl(0.68, 0.3, 0.06 + d * 0.03);
          }
        }
      }
      const j = (y * w + x) * 4;
      img.data[j] = clamp255(r); img.data[j + 1] = clamp255(g); img.data[j + 2] = clamp255(b); img.data[j + 3] = 255;
    }
  }
  return img;
}

// ------------------------------------------------------------------ evaluation fixtures

export interface TruthCurve { name: string; /** pixel coordinates, y down, ~1 px apart */ pts: { x: number; y: number }[] }

/** Stroke polylines onto an image as anti-aliased lines (ink on paper or light on dark). */
export function strokeImage(w: number, h: number, curves: TruthCurve[], o: { width?: number; ink?: number; paper?: number; seed?: number; grain?: number } = {}): RGBAImage {
  const img = blank(w, h);
  const half = (o.width ?? 2.6) / 2;
  const ink = o.ink ?? 40, paper = o.paper ?? 222;
  const dist = new Float32Array(w * h).fill(1e9);
  for (const c of curves) {
    for (let i = 1; i < c.pts.length; i++) {
      const a = c.pts[i - 1], b = c.pts[i];
      const x0 = Math.floor(Math.min(a.x, b.x) - half - 2), x1 = Math.ceil(Math.max(a.x, b.x) + half + 2);
      const y0 = Math.floor(Math.min(a.y, b.y) - half - 2), y1 = Math.ceil(Math.max(a.y, b.y) + half + 2);
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
      for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
        const t = Math.max(0, Math.min(1, ((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / L2));
        const d = Math.hypot(x + 0.5 - a.x - t * dx, y + 0.5 - a.y - t * dy);
        if (d < dist[y * w + x]) dist[y * w + x] = d;
      }
    }
  }
  const n = valueNoise(o.seed ?? 5);
  for (let i = 0; i < w * h; i++) {
    const cover = Math.max(0, Math.min(1, half + 0.5 - dist[i]));
    const v = paper + (ink - paper) * cover + (o.grain ? (n((i % w) * 0.7, Math.floor(i / w) * 0.7) - 0.5) * o.grain : 0);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = clamp255(v);
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

const curvePts = (f: (t: number) => { x: number; y: number }, n = 400) => {
  const raw = Array.from({ length: n + 1 }, (_, i) => f(i / n));
  // resample to ~1 px spacing
  const out = [raw[0]];
  for (const p of raw) { const q = out[out.length - 1]; if (Math.hypot(p.x - q.x, p.y - q.y) >= 1) out.push(p); }
  return out;
};

/** Contour fidelity fixture (480×320): rising curve, falling curve, sinusoid, two crossing lines
 *  sharing the same time span, and a branching Y. Returns the image and the ground truth. */
export function contourFixture(): { img: RGBAImage; truth: TruthCurve[] } {
  const truth: TruthCurve[] = [
    { name: 'rising', pts: curvePts((t) => ({ x: 20 + t * 100, y: 140 - t * 100 + Math.sin(t * Math.PI) * 14 })) },
    { name: 'falling', pts: curvePts((t) => ({ x: 140 + t * 100, y: 30 + t * 80 - Math.sin(t * Math.PI) * 10 })) },
    { name: 'sine', pts: curvePts((t) => ({ x: 20 + t * 440, y: 272 + 22 * Math.sin(t * 4 * Math.PI) }), 900) },
    { name: 'crossA', pts: curvePts((t) => ({ x: 270 + t * 190, y: 40 + t * 120 })) },
    { name: 'crossB', pts: curvePts((t) => ({ x: 270 + t * 190, y: 160 - t * 120 })) },
    { name: 'trunk', pts: curvePts((t) => ({ x: 20 + t * 90, y: 220 - t * 30 })) },
    { name: 'branchUp', pts: curvePts((t) => ({ x: 110 + t * 110, y: 190 - t * 45 + Math.sin(t * Math.PI) * -6 })) },
    { name: 'branchDown', pts: curvePts((t) => ({ x: 110 + t * 110, y: 190 + t * 38 })) },
  ];
  return { img: strokeImage(480, 320, truth), truth };
}

/** Uniform grey frame — no edges at all. */
export function uniformImage(w: number, h: number, v = 128): RGBAImage {
  const img = blank(w, h);
  for (let i = 0; i < w * h; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  return img;
}

/** Vertical bars at irregular x positions (free-time fixture). Returns the bar centres (normalised). */
export function irregularBars(w: number, h: number, xs: number[], width = 4): { img: RGBAImage; xs: number[] } {
  const img = uniformImage(w, h, 30);
  for (const u of xs) {
    const cx = u * w;
    for (let y = Math.floor(h * 0.2); y < Math.floor(h * 0.8); y++) for (let x = Math.floor(cx - width / 2); x < Math.ceil(cx + width / 2); x++) {
      if (x < 0 || x >= w) continue;
      const j = (y * w + x) * 4;
      img.data[j] = img.data[j + 1] = img.data[j + 2] = 230;
    }
  }
  return { img, xs };
}

/** Three overlapping mountain ridges (layered silhouettes) — three independent ridgelines. */
export function ridgesImage(w: number, h: number, seed = 4): { img: RGBAImage; ridges: ((u: number) => number)[] } {
  const img = blank(w, h);
  const n = valueNoise(seed);
  const ridges = [
    (u: number) => 0.32 + 0.1 * Math.sin(u * 5.1 + 0.4) + (fbm(n, u * 8, 1.1, 3) - 0.5) * 0.1,
    (u: number) => 0.52 + 0.08 * Math.sin(u * 7.3 + 2.0) + (fbm(n, u * 10, 4.2, 3) - 0.5) * 0.1,
    (u: number) => 0.72 + 0.06 * Math.sin(u * 9.7 + 4.1) + (fbm(n, u * 12, 7.7, 3) - 0.5) * 0.08,
  ];
  const tones = [[205, 190, 175], [130, 120, 135], [80, 74, 92], [40, 36, 50]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h;
    let layer = 0;
    for (let k = 0; k < 3; k++) if (v > ridges[k](u)) layer = k + 1;
    const c = tones[layer];
    const j = (y * w + x) * 4;
    img.data[j] = c[0]; img.data[j + 1] = c[1]; img.data[j + 2] = c[2]; img.data[j + 3] = 255;
  }
  return { img, ridges };
}
