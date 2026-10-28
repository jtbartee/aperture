// FROZEN COPY of the pre-overhaul analysis (commit 9dc8cf1), kept only so tests can compare
// the old bucketed gesture extractor with the new contour engine. Not used by the app.
// Deterministic, explainable image features. Everything here works on plain RGBA arrays so it
// runs identically in the analysis worker, on the main thread (fallback) and in unit tests.
// Nothing here pretends to recognise objects: features are luminance, colour, contrast, edges
// and texture measured over coordinates.

export interface RGBAImage { width: number; height: number; data: Uint8ClampedArray | Uint8Array }

export const EDGE_BINS = [0.02, 0.035, 0.055, 0.08, 0.12, 0.17, 0.25, 0.36];

/** Compact per-cell statistics of an image. Musical regeneration only ever reads this grid,
 *  never the pixels, so changing scale/sound/regions/seed needs no image reprocessing. */
export interface FeatureGrid {
  cols: number;
  rows: number;
  width: number; // analysed image size
  height: number;
  count: Float32Array;
  lum: Float32Array; // sum L
  lum2: Float32Array; // sum L²
  sat: Float32Array; // sum S
  hueX: Float32Array; // sum S·cos(h)
  hueY: Float32Array; // sum S·sin(h)
  grad: Float32Array; // sum gradient magnitude
  gradV: Float32Array; // sum |gx| (vertical edges)
  gradH: Float32Array; // sum |gy| (horizontal edges)
  hist: Float32Array; // cols*rows*EDGE_BINS: count of pixels with magnitude ≥ bin threshold
}

export function toGray(img: RGBAImage): Float32Array {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) / 255;
  return g;
}

/** Separable 5-tap Gaussian (σ ≈ 1.1). */
export function blur5(src: Float32Array, w: number, h: number): Float32Array {
  const k = [0.0625, 0.25, 0.375, 0.25, 0.0625];
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += src[row + Math.min(w - 1, Math.max(0, x + i))] * k[i + 2];
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + 2];
      out[y * w + x] = s;
    }
  }
  return out;
}

/** Sobel gradients, magnitude normalised so a full black→white step is ≈ 1. */
export function sobel(g: Float32Array, w: number, h: number) {
  const gx = new Float32Array(g.length);
  const gy = new Float32Array(g.length);
  const mag = new Float32Array(g.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1];
      const d = g[i - 1], f = g[i + 1];
      const p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
      const sx = (c + 2 * f + r - a - 2 * d - p) / 4;
      const sy = (p + 2 * q + r - a - 2 * b - c) / 4;
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return { gx, gy, mag };
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max <= 0 ? 0 : d / max, max];
}

export function computeGrid(img: RGBAImage, cols: number, rows: number): FeatureGrid {
  const { width: w, height: h, data } = img;
  const n = cols * rows;
  const grid: FeatureGrid = {
    cols, rows, width: w, height: h,
    count: new Float32Array(n), lum: new Float32Array(n), lum2: new Float32Array(n), sat: new Float32Array(n),
    hueX: new Float32Array(n), hueY: new Float32Array(n), grad: new Float32Array(n), gradV: new Float32Array(n),
    gradH: new Float32Array(n), hist: new Float32Array(n * EDGE_BINS.length),
  };
  const gray = blur5(toGray(img), w, h);
  const { gx, gy, mag } = sobel(gray, w, h);
  const colOf = new Int32Array(w);
  for (let x = 0; x < w; x++) colOf[x] = Math.min(cols - 1, Math.floor((x * cols) / w));
  for (let y = 0; y < h; y++) {
    const r = Math.min(rows - 1, Math.floor((y * rows) / h));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = r * cols + colOf[x];
      const j = i * 4;
      const [hh, s, v] = rgbToHsv(data[j] / 255, data[j + 1] / 255, data[j + 2] / 255);
      const L = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) / 255;
      grid.count[c]++;
      grid.lum[c] += L;
      grid.lum2[c] += L * L;
      // saturation of near-black pixels is meaningless noise; weight by value
      const sw = s * Math.min(1, v * 2.5);
      grid.sat[c] += sw;
      grid.hueX[c] += sw * Math.cos(hh * 2 * Math.PI);
      grid.hueY[c] += sw * Math.sin(hh * 2 * Math.PI);
      const m = mag[i];
      grid.grad[c] += m;
      grid.gradV[c] += Math.abs(gx[i]);
      grid.gradH[c] += Math.abs(gy[i]);
      const hb = c * EDGE_BINS.length;
      for (let k = 0; k < EDGE_BINS.length && m >= EDGE_BINS[k]; k++) grid.hist[hb + k]++;
    }
  }
  return grid;
}

/** Edge threshold for a sensitivity 0..1 (1 = most sensitive = lowest threshold). */
export function edgeThreshold(sensitivity: number): number {
  const s = Math.max(0, Math.min(1, sensitivity));
  return EDGE_BINS[0] * Math.pow(EDGE_BINS[EDGE_BINS.length - 1] / EDGE_BINS[0], 1 - s);
}

function histFraction(grid: FeatureGrid, cell: number, threshold: number): number {
  const nb = EDGE_BINS.length;
  const cnt = grid.count[cell];
  if (!cnt) return 0;
  // log-interpolate between the cumulative bins
  let k = 0;
  while (k < nb - 1 && EDGE_BINS[k + 1] <= threshold) k++;
  const a = grid.hist[cell * nb + k] / cnt;
  if (k >= nb - 1 || threshold <= EDGE_BINS[0]) return threshold <= EDGE_BINS[0] ? grid.hist[cell * nb] / cnt : a;
  const b = grid.hist[cell * nb + k + 1] / cnt;
  const t = Math.log(threshold / EDGE_BINS[k]) / Math.log(EDGE_BINS[k + 1] / EDGE_BINS[k]);
  return a + (b - a) * t;
}

/** Per-time-step features of one region of the image (a band, a mask, or the whole frame). */
export interface Curve {
  n: number;
  brightness: Float32Array;
  saturation: Float32Array;
  hue: Float32Array; // 0..1
  hueStrength: Float32Array; // 0..1 colour coherence
  contrast: Float32Array;
  edges: Float32Array; // edge density at the chosen sensitivity
  texture: Float32Array; // mean gradient magnitude (normalised)
  variation: Float32Array; // change from the previous step
  centroid: Float32Array; // brightness-weighted vertical centre, 0 bottom .. 1 top
  orientation: Float32Array; // 0 horizontal edges … 1 vertical edges
  /** brightness profile over rows (top→bottom) per step, for melodic pitch picking */
  profile: Float32Array[];
}

export type MaskFn = (col: number, row: number) => number;
export const fullMask: MaskFn = () => 1;
export const bandMask = (y0: number, y1: number, rows: number): MaskFn => (_c, r) => {
  const top = r / rows;
  const bot = (r + 1) / rows;
  const ov = Math.max(0, Math.min(bot, y1) - Math.max(top, y0));
  return ov * rows;
};
export function bitsMask(mask: { cols: number; rows: number; bits: string }, gridCols: number, gridRows: number): MaskFn {
  return (c, r) => {
    const mc = Math.min(mask.cols - 1, Math.floor((c / gridCols) * mask.cols));
    const mr = Math.min(mask.rows - 1, Math.floor((r / gridRows) * mask.rows));
    return mask.bits.charCodeAt(mr * mask.cols + mc) === 49 ? 1 : 0;
  };
}

export interface CurveOptions {
  steps: number;
  sensitivity: number;
  /** extra neighbourhood (fraction of a step on each side) — the analysis strip width */
  strip: number;
  /** 0..1 temporal smoothing */
  smoothing: number;
  /** sample only a horizontal sub-range (normalised) */
  x0?: number;
  x1?: number;
  /** scan positions in time order: per step the normalised x the strip is centred on, and for a
   *  custom path also the y it follows (rows near y are weighted). Curve index = musical time. */
  path?: { x: number; y?: number }[];
}

export function regionCurve(grid: FeatureGrid, mask: MaskFn, o: CurveOptions): Curve {
  const n = Math.max(2, Math.round(o.steps));
  const mk = () => new Float32Array(n);
  const cv: Curve = {
    n, brightness: mk(), saturation: mk(), hue: mk(), hueStrength: mk(), contrast: mk(), edges: mk(), texture: mk(),
    variation: mk(), centroid: mk(), orientation: mk(), profile: [],
  };
  const thr = edgeThreshold(o.sensitivity);
  const x0 = o.x0 ?? 0;
  const x1 = o.x1 ?? 1;
  for (let j = 0; j < n; j++) {
    let cx: number;
    let pathY: number | undefined;
    if (o.path && o.path.length) {
      const p = o.path[Math.min(o.path.length - 1, Math.round((j / (n - 1)) * (o.path.length - 1)))];
      cx = p.x;
      pathY = p.y;
    } else {
      cx = x0 + ((j + 0.5) / n) * (x1 - x0);
    }
    const half = ((x1 - x0) / n) * (0.5 + o.strip);
    const c0 = Math.max(0, Math.floor((cx - half) * grid.cols));
    const c1 = Math.min(grid.cols - 1, Math.max(c0, Math.ceil((cx + half) * grid.cols) - 1));
    let W = 0, L = 0, L2 = 0, S = 0, HX = 0, HY = 0, G = 0, GV = 0, GH = 0, E = 0, CY = 0, CW = 0;
    const prof = new Float32Array(grid.rows);
    const profW = new Float32Array(grid.rows);
    for (let c = c0; c <= c1; c++) {
      for (let r = 0; r < grid.rows; r++) {
        let m = mask(c, r);
        if (pathY !== undefined) {
          // path mode: weight rows near the path point (the strip follows the drawn path)
          const ry = 1 - (r + 0.5) / grid.rows;
          m *= Math.max(0, 1 - Math.abs(ry - pathY) * 4);
        }
        if (m <= 0) continue;
        const cell = r * grid.cols + c;
        const cnt = grid.count[cell];
        if (!cnt) continue;
        const w = m * cnt;
        W += w;
        L += m * grid.lum[cell];
        L2 += m * grid.lum2[cell];
        S += m * grid.sat[cell];
        HX += m * grid.hueX[cell];
        HY += m * grid.hueY[cell];
        G += m * grid.grad[cell];
        GV += m * grid.gradV[cell];
        GH += m * grid.gradH[cell];
        E += w * histFraction(grid, cell, thr);
        const meanL = grid.lum[cell] / cnt;
        const ry = 1 - (r + 0.5) / grid.rows;
        CY += ry * meanL * w;
        CW += meanL * w;
        prof[r] += grid.lum[cell] * m;
        profW[r] += w;
      }
    }
    if (W <= 0) { cv.profile.push(prof); continue; }
    const mean = L / W;
    cv.brightness[j] = mean;
    cv.contrast[j] = Math.sqrt(Math.max(0, L2 / W - mean * mean)) * 2;
    cv.saturation[j] = S / W;
    const hx = HX / W;
    const hy = HY / W;
    let hue = Math.atan2(hy, hx) / (2 * Math.PI);
    if (hue < 0) hue += 1;
    cv.hue[j] = hue;
    cv.hueStrength[j] = Math.min(1, Math.sqrt(hx * hx + hy * hy) / Math.max(1e-6, S / W));
    cv.texture[j] = Math.min(1, (G / W) * 6);
    cv.edges[j] = E / W;
    cv.orientation[j] = GV + GH > 0 ? GV / (GV + GH) : 0.5;
    cv.centroid[j] = CW > 0 ? CY / CW : 0.5;
    for (let r = 0; r < grid.rows; r++) prof[r] = profW[r] > 0 ? prof[r] / profW[r] : 0;
    cv.profile.push(prof);
  }
  if (o.smoothing > 0) {
    const a = 1 - Math.min(0.95, o.smoothing);
    for (const key of ['brightness', 'saturation', 'contrast', 'edges', 'texture', 'centroid', 'orientation'] as const) {
      const arr = cv[key];
      // forward-backward one-pole: smooth without shifting features in time
      for (let j = 1; j < n; j++) arr[j] = arr[j - 1] + a * (arr[j] - arr[j - 1]);
      for (let j = n - 2; j >= 0; j--) arr[j] = arr[j + 1] + a * (arr[j] - arr[j + 1]);
    }
  }
  for (let j = 1; j < n; j++) {
    const dh = Math.min(Math.abs(cv.hue[j] - cv.hue[j - 1]), 1 - Math.abs(cv.hue[j] - cv.hue[j - 1]));
    cv.variation[j] = Math.min(1, Math.abs(cv.brightness[j] - cv.brightness[j - 1]) * 3 + Math.abs(cv.saturation[j] - cv.saturation[j - 1]) * 2 + dh * cv.saturation[j] * 2 + Math.abs(cv.edges[j] - cv.edges[j - 1]) * 2);
  }
  cv.variation[0] = cv.variation[1] ?? 0;
  return cv;
}

export type CurveKey = 'brightness' | 'saturation' | 'hue' | 'contrast' | 'edges' | 'texture' | 'variation' | 'centroid' | 'orientation';

export function curveValue(cv: Curve, key: CurveKey | 'none', t01: number): number {
  if (key === 'none') return 0.5;
  const arr = cv[key];
  const x = Math.max(0, Math.min(1, t01)) * (cv.n - 1);
  const i = Math.floor(x);
  const f = x - i;
  return i >= cv.n - 1 ? arr[cv.n - 1] : arr[i] * (1 - f) + arr[i + 1] * f;
}

/** Summary statistics of a whole curve (used to compare images and to set global character). */
export function curveSummary(cv: Curve) {
  const avg = (a: Float32Array) => a.reduce((s, x) => s + x, 0) / a.length;
  return {
    brightness: avg(cv.brightness), saturation: avg(cv.saturation), contrast: avg(cv.contrast), edges: avg(cv.edges),
    texture: avg(cv.texture), variation: avg(cv.variation),
  };
}

// ------------------------------------------------------------------ contours

export interface Gesture {
  id: string;
  /** normalised points, x 0..1 left→right, y 0..1 bottom→top, ordered by x */
  points: { x: number; y: number }[];
  length: number; // pixels in the gesture
  intensity: number; // 0..1 mean edge strength
  thickness: number; // pixels per column
  curvature: number; // mean absolute turning per segment (radians)
  vertical: boolean;
}

export interface ContourOptions {
  sensitivity: number; // 0..1
  minLength: number; // pixels
  detail: number; // 0..1: finer buckets with higher detail
  maxGestures: number;
}

/** Canny-style edges (blur → Sobel → non-maximum suppression → hysteresis), then connected
 *  components, then each component is split into x-monotone chains — musical gestures. */
export function extractContours(img: RGBAImage, o: ContourOptions): Gesture[] {
  const { width: w, height: h } = img;
  const gray = blur5(toGray(img), w, h);
  const { gx, gy, mag } = sobel(gray, w, h);
  // non-maximum suppression along the quantised gradient direction
  const thin = new Float32Array(mag.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < 0.01) continue;
      const ang = Math.atan2(gy[i], gx[i]);
      const d = ((Math.round((ang / Math.PI) * 4) % 4) + 4) % 4;
      const off = d === 0 ? 1 : d === 1 ? w + 1 : d === 2 ? w : w - 1;
      if (m >= mag[i + off] && m >= mag[i - off]) thin[i] = m;
    }
  }
  // threshold from the distribution: keep the strongest fraction of edge pixels
  const vals: number[] = [];
  for (let i = 0; i < thin.length; i += 3) if (thin[i] > 0.015) vals.push(thin[i]);
  vals.sort((a, b) => b - a);
  const keep = 0.08 + Math.max(0, Math.min(1, o.sensitivity)) * 0.5;
  const hi = Math.max(0.03, vals[Math.min(vals.length - 1, Math.floor(vals.length * keep))] ?? 0.1);
  const lo = hi * 0.5;
  const edge = new Uint8Array(thin.length);
  const stack: number[] = [];
  for (let i = 0; i < thin.length; i++) if (thin[i] >= hi) { edge[i] = 2; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const j = i + dy * w + dx;
      if (j < 0 || j >= thin.length || edge[j] || thin[j] < lo) continue;
      edge[j] = 1;
      stack.push(j);
    }
  }
  // connected components
  const label = new Int32Array(edge.length).fill(-1);
  const comps: number[][] = [];
  for (let i = 0; i < edge.length; i++) {
    if (!edge[i] || label[i] >= 0) continue;
    const comp: number[] = [];
    const id = comps.length;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const x = k % w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const j = k + dy * w + dx;
        if (j < 0 || j >= edge.length || !edge[j] || label[j] >= 0) continue;
        label[j] = id;
        stack.push(j);
      }
    }
    if (comp.length >= o.minLength) comps.push(comp);
    else for (const k of comp) label[k] = -2;
  }
  const maxMag = vals[0] ?? 1;
  const bw = Math.max(1, Math.round(10 - Math.max(0, Math.min(1, o.detail)) * 8));
  const gapPx = Math.max(3, bw * 1.5);
  const gestures: Gesture[] = [];
  comps.forEach((comp, ci) => {
    // bucket by x, split each bucket into y-clusters, link clusters into chains
    const bins = new Map<number, { y: number; m: number }[]>();
    for (const k of comp) {
      const b = Math.floor((k % w) / bw);
      const arr = bins.get(b) ?? [];
      arr.push({ y: Math.floor(k / w), m: thin[k] || mag[k] });
      bins.set(b, arr);
    }
    type Node = { x: number; y: number; n: number; m: number };
    const chains: Node[][] = [];
    const lastBin = new Map<Node[], number>();
    for (const b of [...bins.keys()].sort((a, z) => a - z)) {
      const pts = bins.get(b)!.sort((a, z) => a.y - z.y);
      const clusters: Node[] = [];
      let cur: { y: number; m: number }[] = [];
      const flush = () => {
        if (!cur.length) return;
        clusters.push({ x: (b + 0.5) * bw, y: cur.reduce((s, p) => s + p.y, 0) / cur.length, n: cur.length, m: cur.reduce((s, p) => s + p.m, 0) / cur.length });
        cur = [];
      };
      for (const p of pts) {
        if (cur.length && p.y - cur[cur.length - 1].y > gapPx) flush();
        cur.push(p);
      }
      flush();
      for (const node of clusters) {
        let best: Node[] | null = null;
        let bestD = gapPx * 3;
        for (const ch of chains) {
          const lb = lastBin.get(ch)!;
          if (b - lb > 2 || b === lb) continue;
          const d = Math.abs(ch[ch.length - 1].y - node.y);
          if (d < bestD) { bestD = d; best = ch; }
        }
        if (best) { best.push(node); lastBin.set(best, b); }
        else { const ch = [node]; chains.push(ch); lastBin.set(ch, b); }
      }
    }
    chains.forEach((ch, k) => {
      const px = ch.reduce((s, nd) => s + nd.n, 0);
      if (px < o.minLength * 0.5) return;
      const xs = ch.map((nd) => nd.x);
      const ys = ch.map((nd) => nd.y);
      const xSpan = Math.max(...xs) - Math.min(...xs);
      const ySpan = Math.max(...ys) - Math.min(...ys);
      let turn = 0;
      for (let i = 2; i < ch.length; i++) {
        const a1 = Math.atan2(ch[i - 1].y - ch[i - 2].y, ch[i - 1].x - ch[i - 2].x);
        const a2 = Math.atan2(ch[i].y - ch[i - 1].y, ch[i].x - ch[i - 1].x);
        let d = Math.abs(a2 - a1);
        if (d > Math.PI) d = 2 * Math.PI - d;
        turn += d;
      }
      const vertical = ch.length <= 2 && ySpan > 8;
      gestures.push({
        id: `g${ci}_${k}`,
        points: ch.map((nd) => ({ x: nd.x / w, y: 1 - nd.y / h })),
        length: px,
        intensity: Math.min(1, ch.reduce((s, nd) => s + nd.m, 0) / ch.length / maxMag),
        thickness: px / Math.max(1, ch.length * bw),
        curvature: ch.length > 2 ? turn / (ch.length - 2) : 0,
        vertical: vertical || (xSpan < bw * 2 && ySpan > 10),
      });
      if (gestures[gestures.length - 1].vertical) {
        // a vertical gesture keeps its vertical extent (it becomes a chord / strum)
        const g = gestures[gestures.length - 1];
        const comp01 = comp.map((kk) => 1 - Math.floor(kk / w) / h);
        const mx = ch.reduce((s, nd) => s + nd.x, 0) / ch.length / w;
        g.points = [{ x: mx, y: Math.min(...comp01) }, { x: mx, y: Math.max(...comp01) }];
      }
    });
  });
  gestures.sort((a, b) => b.length * (0.5 + b.intensity) - a.length * (0.5 + a.intensity));
  return gestures.slice(0, o.maxGestures);
}
