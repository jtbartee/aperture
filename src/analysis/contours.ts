// CONTOUR ENGINE. Traces the visible edges of an image as ordered paths that keep their real
// geometry — bends, loops, vertical runs, branches and junctions — instead of collapsing a strip
// of edge pixels into one averaged line.
//
//   gray → Gaussian (fine σ≈1.1, coarse σ≈1.9) → Sobel → non-maximum suppression → hysteresis
//   (Canny, per scale) → multi-scale agreement → merge near-parallel edges (dilation radius from
//   "separation") → Zhang–Suen skeleton → elbow cleanup → pixel graph (endpoints, junction
//   clusters, segments, loops) → junction merge + spur pruning (branch detection) → chains by good
//   continuation through junctions → gap bridging → corner splits → curvature-aware smoothing →
//   Douglas–Peucker with protected corners → per-vertex strength / curvature / orientation.
//
// Coordinates: every point is normalised to the analysed image, x 0..1 left→right and y 0..1
// bottom→top (the pitch convention used everywhere else). Multiply by the source asset's width and
// height to get source pixels. Pure functions on RGBA arrays: runs in the worker, on the main
// thread and in unit tests.

import type { ContourPreset, ContourSettings } from '../core/types';
import { blur5, sobel, toGray, type RGBAImage } from './features';

export interface Contour {
  id: string;
  /** simplified polyline in path order (normalised, y bottom-up) */
  pts: { x: number; y: number }[];
  /** per-point edge strength 0..1 */
  str: number[];
  /** per-point signed curvature, radians per analysis pixel */
  curv: number[];
  closed: boolean;
  /** arc length in analysis pixels */
  length: number;
  intensity: number; // 0..1 mean edge strength
  thickness: number; // 0..1 (1 ≈ a broad, doubled or textured edge)
  curvature: number; // mean |turning| per 10 px
  orientation: number; // 0 horizontal … 1 vertical
  coarse: number; // 0..1 share supported by the coarse scale (0 = fine detail only)
  /** the contour this one branches off, and the index on the parent where it leaves */
  parent?: string;
  branchAt?: number;
  rank: number;
}

export interface Junction { x: number; y: number; degree: number }

export interface ContourSet {
  contours: Contour[];
  junctions: Junction[];
  width: number;
  height: number;
  stats: { edgePixels: number; skeletonPixels: number; chains: number; closed: number; branched: number };
}

export const CONTOUR_PRESETS: Record<Exclude<ContourPreset, 'custom'>, { label: string; settings: Omit<ContourSettings, 'preset'> }> = {
  photo: { label: 'Photography', settings: { sensitivity: 0.45, minStrength: 0.2, minLength: 28, detail: 0.6, smoothing: 0.35, curvature: 0.6, separation: 0.45, branches: 0.5, maxContours: 24, multiScale: 0.6 } },
  lineart: { label: 'Line art', settings: { sensitivity: 0.7, minStrength: 0.15, minLength: 12, detail: 0.8, smoothing: 0.2, curvature: 0.8, separation: 0.2, branches: 0.8, maxContours: 40, multiScale: 0.1 } },
  abstract: { label: 'Abstract artwork', settings: { sensitivity: 0.6, minStrength: 0.1, minLength: 16, detail: 0.5, smoothing: 0.4, curvature: 0.5, separation: 0.6, branches: 0.6, maxContours: 32, multiScale: 0.3 } },
  panorama: { label: 'Panoramic landscape', settings: { sensitivity: 0.4, minStrength: 0.2, minLength: 40, detail: 0.55, smoothing: 0.5, curvature: 0.5, separation: 0.4, branches: 0.3, maxContours: 16, multiScale: 0.8 } },
};

export function contourPreset(id: Exclude<ContourPreset, 'custom'>): ContourSettings {
  return { preset: id, ...CONTOUR_PRESETS[id].settings };
}

const c01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ------------------------------------------------------------------ edges

interface EdgeMap { edge: Uint8Array; mag: Float32Array; hi: number }

/** One Canny pass on a blurred image. `floor` is the absolute minimum strong threshold. */
function canny(g: Float32Array, w: number, h: number, sensitivity: number, floor: number): EdgeMap {
  const { gx, gy, mag } = sobel(g, w, h);
  const thin = new Float32Array(mag.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < 0.006) continue;
      const ang = Math.atan2(gy[i], gx[i]);
      const d = ((Math.round((ang / Math.PI) * 4) % 4) + 4) % 4;
      const off = d === 0 ? 1 : d === 1 ? w + 1 : d === 2 ? w : w - 1;
      if (m >= mag[i + off] && m > mag[i - off] - 1e-7) thin[i] = m;
    }
  }
  // noise-relative strong threshold (a multiple of the median gradient, so busy textures need
  // stronger edges) with an absolute floor (so clean images keep every visible edge and a
  // uniform image keeps none)
  const vals: number[] = [];
  for (let i = 0; i < mag.length; i += 3) vals.push(mag[i]);
  vals.sort((a, b) => a - b);
  const noise = (vals[Math.floor(vals.length / 2)] ?? 0) / 0.6745;
  let any = false;
  for (let i = 0; i < thin.length && !any; i++) if (thin[i] >= floor) any = true;
  const hi = any ? Math.max(floor, noise * (2 + 7 * (1 - c01(sensitivity)))) : Infinity;
  const lo = hi * 0.45;
  const edge = new Uint8Array(thin.length);
  const stack: number[] = [];
  for (let i = 0; i < thin.length; i++) if (thin[i] >= hi) { edge[i] = 1; stack.push(i); }
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
  return { edge, mag, hi };
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src.slice();
  const out = new Uint8Array(src.length);
  const offs: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) offs.push([dx, dy]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!src[y * w + x]) continue;
    for (const [dx, dy] of offs) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h) out[yy * w + xx] = 1;
    }
  }
  return out;
}

/** Zhang–Suen thinning to an 8-connected one-pixel skeleton. */
function zhangSuen(img: Uint8Array, w: number, h: number): Uint8Array {
  const a = img.slice();
  for (let x = 0; x < w; x++) { a[x] = 0; a[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { a[y * w] = 0; a[y * w + w - 1] = 0; }
  const del: number[] = [];
  let changed = true;
  for (let iter = 0; changed && iter < 40; iter++) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!a[i]) continue;
          const p2 = a[i - w], p3 = a[i - w + 1], p4 = a[i + 1], p5 = a[i + w + 1], p6 = a[i + w], p7 = a[i + w - 1], p8 = a[i - 1], p9 = a[i - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
          if (A !== 1) continue;
          if (pass === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
          del.push(i);
        }
      }
      for (const i of del) a[i] = 0;
      if (del.length) changed = true;
    }
  }
  return a;
}

const N8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Remove "elbow" pixels: a pixel whose foreground neighbours form a single 8-connected group
 *  (and which is not an end) can go without changing the topology. Staircase corners otherwise
 *  look like 3-way junctions. */
function removeElbows(a: Uint8Array, w: number, h: number) {
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!a[i]) continue;
      const nb: [number, number][] = [];
      for (const [dx, dy] of N8) if (a[i + dy * w + dx]) nb.push([dx, dy]);
      if (nb.length < 2 || nb.length > 4) continue;
      // connected components among neighbours (8-adjacency between neighbour positions)
      const seen = new Array(nb.length).fill(false);
      let comps = 0;
      for (let k = 0; k < nb.length; k++) {
        if (seen[k]) continue;
        comps++;
        const st = [k];
        seen[k] = true;
        while (st.length) {
          const q = st.pop()!;
          for (let m = 0; m < nb.length; m++) {
            if (seen[m]) continue;
            if (Math.abs(nb[m][0] - nb[q][0]) <= 1 && Math.abs(nb[m][1] - nb[q][1]) <= 1) { seen[m] = true; st.push(m); }
          }
        }
      }
      if (comps === 1) a[i] = 0;
    }
  }
}

// ------------------------------------------------------------------ pixel graph

interface Seg { a: number; b: number; px: number[]; dead?: boolean }
interface GNode { x: number; y: number; px: number[]; end: boolean }

function buildGraph(sk: Uint8Array, w: number, h: number) {
  const deg = new Uint8Array(sk.length);
  for (let i = 0; i < sk.length; i++) {
    if (!sk[i]) continue;
    const x = i % w, y = (i / w) | 0;
    let d = 0;
    for (const [dx, dy] of N8) { const xx = x + dx, yy = y + dy; if (xx >= 0 && xx < w && yy >= 0 && yy < h && sk[yy * w + xx]) d++; }
    deg[i] = d;
  }
  const nodeOf = new Int32Array(sk.length).fill(-1);
  const nodes: GNode[] = [];
  for (let i = 0; i < sk.length; i++) {
    if (!sk[i] || deg[i] === 2 || deg[i] === 0 || nodeOf[i] >= 0) continue;
    const id = nodes.length;
    const px: number[] = [];
    const st = [i];
    nodeOf[i] = id;
    const isEnd = deg[i] === 1;
    while (st.length) {
      const k = st.pop()!;
      px.push(k);
      if (isEnd) break;
      const x = k % w, y = (k / w) | 0;
      for (const [dx, dy] of N8) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        const j = yy * w + xx;
        if (sk[j] && deg[j] >= 3 && nodeOf[j] < 0) { nodeOf[j] = id; st.push(j); }
      }
    }
    let sx = 0, sy = 0;
    for (const k of px) { sx += k % w; sy += (k / w) | 0; }
    nodes.push({ x: sx / px.length, y: sy / px.length, px, end: isEnd });
  }
  const segs: Seg[] = [];
  const visited = new Uint8Array(sk.length);
  const nbrs = (k: number) => {
    const x = k % w, y = (k / w) | 0;
    const out: number[] = [];
    for (const [dx, dy] of N8) { const xx = x + dx, yy = y + dy; if (xx >= 0 && xx < w && yy >= 0 && yy < h && sk[yy * w + xx]) out.push(yy * w + xx); }
    return out;
  };
  for (let nid = 0; nid < nodes.length; nid++) {
    for (const p of nodes[nid].px) {
      for (const q of nbrs(p)) {
        if (nodeOf[q] >= 0) {
          if (nodeOf[q] !== nid && p < q) segs.push({ a: nid, b: nodeOf[q], px: [p, q] });
          continue;
        }
        if (visited[q]) continue;
        const px = [p, q];
        visited[q] = 1;
        let prev = p, cur = q;
        let end = -1;
        for (let guard = 0; guard < sk.length; guard++) {
          const nx = nbrs(cur).filter((j) => j !== prev && !(nodeOf[j] === nid && j === p));
          const next = nx.find((j) => nodeOf[j] >= 0) ?? nx.find((j) => !visited[j]);
          if (next === undefined) break;
          px.push(next);
          if (nodeOf[next] >= 0) { end = nodeOf[next]; break; }
          visited[next] = 1;
          prev = cur;
          cur = next;
        }
        segs.push({ a: nid, b: end, px });
      }
    }
  }
  // closed loops made only of degree-2 pixels
  for (let i = 0; i < sk.length; i++) {
    if (!sk[i] || deg[i] !== 2 || visited[i]) continue;
    const px = [i];
    visited[i] = 1;
    let prev = -1, cur = i;
    for (let guard = 0; guard < sk.length; guard++) {
      const next = nbrs(cur).find((j) => j !== prev && !visited[j]);
      if (next === undefined) break;
      visited[next] = 1;
      px.push(next);
      prev = cur;
      cur = next;
    }
    segs.push({ a: -1, b: -1, px });
  }
  return { nodes, segs, deg };
}

// ------------------------------------------------------------------ main

export function extractContourSet(img: RGBAImage, s: ContourSettings): ContourSet {
  const { width: w, height: h } = img;
  const gray = toGray(img);
  const fineG = blur5(gray, w, h);
  // a step of contrast c measures ≈ 0.62·c after the fine blur, ≈ 0.45·c after the coarse one
  const floorFine = 0.62 * (0.03 + c01(s.minStrength) * 0.5);
  const fine = canny(fineG, w, h, s.sensitivity, floorFine);
  let edge = fine.edge;
  let coarseSupport: Uint8Array | null = null;
  const ms = c01(s.multiScale);
  if (ms > 0.02) {
    const coarseG = blur5(blur5(blur5(gray, w, h), w, h), w, h);
    const coarse = canny(coarseG, w, h, s.sensitivity, 0.45 * (0.03 + c01(s.minStrength) * 0.5));
    coarseSupport = dilate(coarse.edge, w, h, 2);
    const fineNear = ms > 0.5 ? dilate(fine.edge, w, h, 2) : null;
    const keepAlone = fine.hi * (1 + ms * 2.2);
    const out = new Uint8Array(edge.length);
    for (let i = 0; i < out.length; i++) {
      if (fine.edge[i] && (coarseSupport[i] || fine.mag[i] >= keepAlone)) out[i] = 1;
      // coarse structure fills gaps the fine scale missed (never doubling a fine edge)
      else if (fineNear && coarse.edge[i] && !fineNear[i]) out[i] = 1;
    }
    edge = out;
  }
  let edgePixels = 0;
  for (let i = 0; i < edge.length; i++) edgePixels += edge[i];

  // merge near-parallel edges (both sides of a thin line, doubled outlines) into one centreline
  const r = Math.round(2.4 * (1 - c01(s.separation)));
  const thick = dilate(edge, w, h, r);
  // close pinholes so the skeleton does not sprout tiny loops
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (thick[i]) continue;
    let n = 0;
    for (const [dx, dy] of N8) n += thick[i + dy * w + dx];
    if (n >= 7) thick[i] = 1;
  }
  const sk = zhangSuen(thick, w, h);
  removeElbows(sk, w, h);
  let skeletonPixels = 0;
  for (let i = 0; i < sk.length; i++) skeletonPixels += sk[i];

  const { nodes, segs } = buildGraph(sk, w, h);
  const segLen = (sg: Seg) => sg.px.length;

  // ---- junction merge: junction clusters joined by a very short segment are one junction
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const mergeD = 3 + 3 * r + Math.round(4 * (1 - c01(s.separation)));
  for (const sg of segs) {
    if (sg.a < 0 || sg.b < 0 || nodes[sg.a].end || nodes[sg.b].end) continue;
    if (segLen(sg) <= mergeD) { parent[find(sg.a)] = find(sg.b); sg.dead = true; }
  }
  for (const sg of segs) { if (sg.a >= 0) sg.a = find(sg.a); if (sg.b >= 0) sg.b = find(sg.b); }
  const posAcc = new Map<number, { x: number; y: number; n: number }>();
  nodes.forEach((nd, k) => {
    const root = find(k);
    const a = posAcc.get(root) ?? { x: 0, y: 0, n: 0 };
    a.x += nd.x * nd.px.length; a.y += nd.y * nd.px.length; a.n += nd.px.length;
    posAcc.set(root, a);
  });
  const nodePos = (id: number) => { const a = posAcc.get(id); return a && a.n ? { x: a.x / a.n, y: a.y / a.n } : { x: nodes[id].x, y: nodes[id].y }; };
  // tiny loops around a merged junction are dilation artefacts
  for (const sg of segs) if (!sg.dead && sg.a >= 0 && sg.a === sg.b && segLen(sg) <= mergeD * 4) sg.dead = true;

  // ---- spur pruning (branch detection): short end-to-junction twigs fold into their stem
  const spurLen = Math.round(lerp(26, 3, c01(s.branches)) + r);
  const incidence = () => {
    const inc = new Map<number, number>();
    for (const sg of segs) {
      if (sg.dead) continue;
      if (sg.a >= 0) inc.set(sg.a, (inc.get(sg.a) ?? 0) + 1);
      if (sg.b >= 0) inc.set(sg.b, (inc.get(sg.b) ?? 0) + 1);
    }
    return inc;
  };
  for (let pass = 0; pass < 2; pass++) {
    const inc = incidence();
    for (const sg of segs) {
      if (sg.dead || sg.a < 0 || sg.b < 0) continue;
      const da = inc.get(sg.a) ?? 0, db = inc.get(sg.b) ?? 0;
      const spur = (da === 1 && db >= 3) || (db === 1 && da >= 3);
      if (spur && segLen(sg) <= spurLen) { sg.dead = true; inc.set(sg.a, da - 1); inc.set(sg.b, db - 1); }
    }
  }
  const live = segs.filter((sg) => !sg.dead && segLen(sg) >= 2);
  const inc = incidence();

  // ---- good continuation: pair the segment ends that meet at each node
  type End = { seg: number; side: 0 | 1 };
  const ends = new Map<number, End[]>();
  live.forEach((sg, k) => {
    if (sg.a >= 0) { const l = ends.get(sg.a) ?? []; l.push({ seg: k, side: 0 }); ends.set(sg.a, l); }
    if (sg.b >= 0) { const l = ends.get(sg.b) ?? []; l.push({ seg: k, side: 1 }); ends.set(sg.b, l); }
  });
  const pxAt = (k: number) => ({ x: k % w, y: (k / w) | 0 });
  const endDir = (e: End) => {
    const px = live[e.seg].px;
    const n = px.length;
    const reach = Math.min(n - 1, 9);
    const p0 = pxAt(e.side === 0 ? px[0] : px[n - 1]);
    const p1 = pxAt(e.side === 0 ? px[reach] : px[n - 1 - reach]);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const L = Math.hypot(dx, dy) || 1;
    return { x: dx / L, y: dy / L };
  };
  const link = new Map<string, End>();
  const key = (e: End) => `${e.seg}:${e.side}`;
  const maxTurn = (lerp(80, 50, c01(s.separation)) * Math.PI) / 180;
  const cornerSplit = s.separation > 0.55 ? (lerp(160, 60, (s.separation - 0.55) / 0.45) * Math.PI) / 180 : Math.PI;
  const junctions: Junction[] = [];
  for (const [nid, list] of ends) {
    if (list.length >= 3) {
      const p = nodePos(nid);
      junctions.push({ x: (p.x + 0.5) / w, y: 1 - (p.y + 0.5) / h, degree: list.length });
    }
    if (list.length < 2) continue;
    const dirs = list.map(endDir);
    const pairs: { i: number; j: number; turn: number }[] = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (list[i].seg === list[j].seg && list.length > 2) continue;
      const dot = -(dirs[i].x * dirs[j].x + dirs[i].y * dirs[j].y);
      pairs.push({ i, j, turn: Math.acos(Math.max(-1, Math.min(1, dot))) });
    }
    pairs.sort((a, b) => a.turn - b.turn);
    const used = new Set<number>();
    for (const pr of pairs) {
      if (used.has(pr.i) || used.has(pr.j)) continue;
      const limit = list.length === 2 ? cornerSplit : maxTurn;
      if (pr.turn > limit) continue;
      used.add(pr.i);
      used.add(pr.j);
      link.set(key(list[pr.i]), list[pr.j]);
      link.set(key(list[pr.j]), list[pr.i]);
    }
  }

  // ---- walk chains
  type Chain = { px: number[]; closed: boolean; segs: number[]; startNode: number; endNode: number };
  const chains: Chain[] = [];
  const segUsed = new Uint8Array(live.length);
  const nodeAt = (e: End) => (e.side === 0 ? live[e.seg].a : live[e.seg].b);
  const walk = (start: End): Chain => {
    const px: number[] = [];
    const seglist: number[] = [];
    let e: End | undefined = start;
    let closed = false;
    let last: End = start;
    while (e && !segUsed[e.seg]) {
      segUsed[e.seg] = 1;
      seglist.push(e.seg);
      const sp = live[e.seg].px;
      const ordered = e.side === 0 ? sp : [...sp].reverse();
      for (const k of ordered) if (px[px.length - 1] !== k) px.push(k);
      const out: End = { seg: e.seg, side: e.side === 0 ? 1 : 0 };
      last = out;
      e = link.get(key(out));
      if (e && e.seg === start.seg && e.side === start.side) { closed = true; break; }
    }
    return { px, closed, segs: seglist, startNode: nodeAt(start), endNode: nodeAt(last) };
  };
  for (let k = 0; k < live.length; k++) {
    if (segUsed[k]) continue;
    for (const side of [0, 1] as const) {
      const e = { seg: k, side };
      if (segUsed[k] || link.has(key(e)) || (live[k].a < 0 && live[k].b < 0)) continue; // pure loops: below
      chains.push(walk(e));
    }
  }
  for (let k = 0; k < live.length; k++) {
    if (segUsed[k]) continue;
    const c = walk({ seg: k, side: 0 });
    if (live[k].a < 0 && live[k].b < 0) c.closed = true;
    chains.push(c);
  }

  // ---- gap bridging between open chain ends that face each other
  const gapD = lerp(10, 0, c01(s.separation));
  let joined = chains;
  if (gapD >= 1.5 && chains.length > 1) {
    const tangentOut = (px: number[], atEnd: boolean) => {
      const n = px.length;
      const reach = Math.min(n - 1, 8);
      const a = pxAt(atEnd ? px[n - 1 - reach] : px[reach]);
      const b = pxAt(atEnd ? px[n - 1] : px[0]);
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      return { x: dx / L, y: dy / L, p: b };
    };
    type CEnd = { c: number; e: 0 | 1; t: { x: number; y: number; p: { x: number; y: number } } };
    const cends: CEnd[] = [];
    chains.forEach((ch, c) => { if (!ch.closed && ch.px.length >= 4) for (const e of [0, 1] as const) cends.push({ c, e, t: tangentOut(ch.px, e === 1) }); });
    // spatial hash so long panoramas with thousands of fragments stay linear
    const cell = Math.max(2, gapD);
    const hash = new Map<string, number[]>();
    cends.forEach((ce, k) => { const kk = `${Math.floor(ce.t.p.x / cell)},${Math.floor(ce.t.p.y / cell)}`; const l = hash.get(kk) ?? []; l.push(k); hash.set(kk, l); });
    const cand: { i: number; j: number; d: number }[] = [];
    cends.forEach((A, i) => {
      const cx = Math.floor(A.t.p.x / cell), cy = Math.floor(A.t.p.y / cell);
      for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (const j of hash.get(`${gx},${gy}`) ?? []) {
          if (j <= i) continue;
          const B = cends[j];
          if (A.c === B.c && chains[A.c].px.length < gapD * 6) continue;
          const dx = B.t.p.x - A.t.p.x, dy = B.t.p.y - A.t.p.y;
          const d = Math.hypot(dx, dy);
          if (d > gapD || d < 1e-6) continue;
          const ux = dx / d, uy = dy / d;
          if (A.t.x * ux + A.t.y * uy < 0.5 || -(B.t.x * ux + B.t.y * uy) < 0.5) continue;
          cand.push({ i, j, d });
        }
      }
    });
    cand.sort((a, b) => a.d - b.d);
    const usedEnd = new Set<number>();
    const bridge = new Map<string, { c: number; e: 0 | 1 }>();
    const uf = chains.map((_, i) => i);
    const fr = (i: number): number => (uf[i] === i ? i : (uf[i] = fr(uf[i])));
    for (const cd of cand) {
      if (usedEnd.has(cd.i) || usedEnd.has(cd.j)) continue;
      const A = cends[cd.i], B = cends[cd.j];
      if (A.c === B.c) { chains[A.c].closed = true; usedEnd.add(cd.i); usedEnd.add(cd.j); continue; }
      if (fr(A.c) === fr(B.c)) continue; // would close a multi-chain ring; leave it open
      uf[fr(A.c)] = fr(B.c);
      usedEnd.add(cd.i); usedEnd.add(cd.j);
      bridge.set(`${A.c}:${A.e}`, { c: B.c, e: B.e });
      bridge.set(`${B.c}:${B.e}`, { c: A.c, e: A.e });
    }
    if (bridge.size) {
      joined = [];
      const seen = new Uint8Array(chains.length);
      const follow = (c0: number, enterEnd: 0 | 1) => {
        const px: number[] = [];
        const sg: number[] = [];
        let c = c0, e = enterEnd;
        const first = chains[c0];
        let lastNode = first.startNode;
        while (!seen[c]) {
          seen[c] = 1;
          const ch = chains[c];
          const ordered = e === 0 ? ch.px : [...ch.px].reverse();
          px.push(...ordered);
          sg.push(...ch.segs);
          lastNode = e === 0 ? ch.endNode : ch.startNode;
          const out = (e === 0 ? 1 : 0) as 0 | 1;
          const nb = bridge.get(`${c}:${out}`);
          if (!nb) break;
          c = nb.c;
          e = nb.e;
        }
        joined.push({ px, closed: false, segs: sg, startNode: enterEnd === 0 ? first.startNode : first.endNode, endNode: lastNode });
      };
      chains.forEach((ch, c) => {
        if (seen[c]) return;
        if (ch.closed) { seen[c] = 1; joined.push(ch); return; }
        if (!bridge.has(`${c}:0`)) follow(c, 0);
        else if (!bridge.has(`${c}:1`)) follow(c, 1);
      });
      chains.forEach((ch, c) => { if (!seen[c]) { seen[c] = 1; joined.push(ch); } });
    }
  }

  // ---- geometry per chain
  const allMag = fine.mag;
  const sample: number[] = [];
  for (let i = 0; i < edge.length; i += 3) if (edge[i]) sample.push(allMag[i]);
  sample.sort((a, b) => a - b);
  const normMag = Math.max(1e-6, sample[Math.floor(sample.length * 0.98)] ?? fine.hi * 2);
  const stamp = new Uint32Array(edge.length);
  let stampId = 0;
  type Built = Omit<Contour, 'id' | 'rank' | 'parent' | 'branchAt'> & { segs: number[]; startNode: number; endNode: number; salience: number };
  const built: Built[] = [];
  const turnAt = (P: { x: number; y: number }[], i: number, k: number, closed: boolean) => {
    const n = P.length;
    const ia = closed ? (i - k + n) % n : Math.max(0, i - k);
    const ib = closed ? (i + k) % n : Math.min(n - 1, i + k);
    if (ia === i || ib === i) return 0;
    const ax = P[i].x - P[ia].x, ay = P[i].y - P[ia].y;
    const bx = P[ib].x - P[i].x, by = P[ib].y - P[i].y;
    return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  };
  const processPath = (raw: { x: number; y: number }[], closed: boolean, ch: Chain) => {
    const n = raw.length;
    if (n < 3) return;
    const corner = raw.map((_, i) => c01(Math.abs(turnAt(raw, i, 3, closed)) / (Math.PI / 2.5)));
    const sigma = c01(s.smoothing) * 5;
    const sm = raw.map((p, i) => {
      const si = sigma * (1 - c01(s.curvature) * corner[i]);
      if (si < 0.3 || (!closed && (i === 0 || i === n - 1))) return { ...p };
      const R = Math.ceil(si * 2.5);
      let sx = 0, sy = 0, sw = 0;
      for (let d = -R; d <= R; d++) {
        let j = i + d;
        if (closed) j = (j + n) % n;
        else if (j < 0 || j >= n) continue;
        const wt = Math.exp((-d * d) / (2 * si * si));
        sx += raw[j].x * wt; sy += raw[j].y * wt; sw += wt;
      }
      return { x: sx / sw, y: sy / sw };
    });
    // arc length + orientation on the smoothed path
    let len = 0, adx = 0, ady = 0;
    for (let i = 1; i < n; i++) { const dx = sm[i].x - sm[i - 1].x, dy = sm[i].y - sm[i - 1].y; len += Math.hypot(dx, dy); adx += Math.abs(dx); ady += Math.abs(dy); }
    if (closed) len += Math.hypot(sm[0].x - sm[n - 1].x, sm[0].y - sm[n - 1].y);
    // protected corners: local maxima of turning that simplification must keep
    const protect = new Set<number>();
    if (s.curvature > 0.25) {
      const thr = lerp(0.85, 0.45, c01(s.curvature));
      for (let i = 1; i < n - 1; i++) if (corner[i] > thr && corner[i] >= corner[i - 1] && corner[i] >= corner[i + 1]) protect.add(i);
    }
    const tol = lerp(2.6, 0.3, c01(s.detail));
    const keep = rdp(sm, tol, protect, closed);
    const pts = keep.map((i) => sm[i]);
    // per-vertex strength from the nearest edge magnitude, curvature from the simplified polyline
    const str = keep.map((i) => {
      const p = raw[i];
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.round(p.x) + dx, yy = Math.round(p.y) + dy;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h) m = Math.max(m, allMag[yy * w + xx]);
      }
      return c01(m / normMag);
    });
    let turn = 0;
    const curv = pts.map((_, i) => {
      if (!closed && (i === 0 || i === pts.length - 1)) return 0;
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const t = Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y));
      turn += Math.abs(t);
      const seg = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
      return -t / Math.max(1, seg); // pixel y points down; flip so counter-clockwise stays positive
    });
    // thickness: raw edge pixels around the path per unit length
    stampId++;
    let cnt = 0;
    const tr = r + 1;
    for (let i = 0; i < n; i += 2) {
      const cx = Math.round(raw[i].x), cy = Math.round(raw[i].y);
      for (let dy = -tr; dy <= tr; dy++) for (let dx = -tr; dx <= tr; dx++) {
        const xx = cx + dx, yy = cy + dy;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        const j = yy * w + xx;
        if (edge[j] && stamp[j] !== stampId) { stamp[j] = stampId; cnt++; }
      }
    }
    let coarse = 1;
    if (coarseSupport) {
      let c = 0;
      for (const p of raw) c += coarseSupport[Math.round(p.y) * w + Math.round(p.x)] ?? 0;
      coarse = c / n;
    }
    const intensity = str.reduce((a, b) => a + b, 0) / Math.max(1, str.length);
    built.push({
      pts: pts.map((p) => ({ x: (p.x + 0.5) / w, y: 1 - (p.y + 0.5) / h })),
      str,
      curv,
      closed,
      length: len,
      intensity,
      thickness: c01((cnt / Math.max(1, len) - 0.8) / 2.2),
      curvature: (turn / Math.max(1, len)) * 10,
      orientation: adx + ady > 0 ? ady / (adx + ady) : 0.5,
      coarse,
      segs: ch.segs,
      startNode: ch.startNode,
      endNode: ch.endNode,
      salience: len * (0.4 + intensity) * (0.7 + 0.3 * coarse),
    });
  };
  for (const ch of joined) {
    const raw = ch.px.map(pxAt);
    if (raw.length < 3) continue;
    // corner splits (high separation): sharp turns end one contour and start the next
    if (cornerSplit < Math.PI) {
      const cuts: number[] = [];
      for (let i = 4; i < raw.length - 4; i++) {
        const t = Math.abs(turnAt(raw, i, 4, false));
        if (t > cornerSplit && t >= Math.abs(turnAt(raw, i - 1, 4, false)) && t >= Math.abs(turnAt(raw, i + 1, 4, false))) { cuts.push(i); i += 4; }
      }
      if (cuts.length) {
        let prev = 0;
        for (const c of [...cuts, raw.length - 1]) { processPath(raw.slice(prev, c + 1), false, ch); prev = c; }
        continue;
      }
    }
    processPath(raw, ch.closed, ch);
  }

  // ---- filter, rank, cap; branch relationships
  const kept = built.filter((b) => b.length >= Math.max(3, s.minLength)).sort((a, b) => b.salience - a.salience).slice(0, Math.max(1, Math.round(s.maxContours)));
  const contours: Contour[] = kept.map((b, i) => ({
    id: `c${i}`, pts: b.pts, str: b.str, curv: b.curv, closed: b.closed, length: b.length, intensity: b.intensity,
    thickness: b.thickness, curvature: b.curvature, orientation: b.orientation, coarse: b.coarse, rank: i,
  }));
  // a contour that stops at a junction another contour passes through is a branch of it
  const passNodes = kept.map((b) => {
    const set = new Set<number>();
    for (const sg of b.segs) { if (live[sg].a >= 0) set.add(live[sg].a); if (live[sg].b >= 0) set.add(live[sg].b); }
    set.delete(b.startNode);
    set.delete(b.endNode);
    return set;
  });
  let branched = 0;
  kept.forEach((b, i) => {
    for (const nd of [b.startNode, b.endNode]) {
      if (nd < 0 || (inc.get(nd) ?? 0) < 3 || contours[i].parent) continue;
      const pj = passNodes.findIndex((set, j) => j !== i && set.has(nd));
      if (pj < 0) continue;
      const np = nodePos(nd);
      const nx = (np.x + 0.5) / w, ny = 1 - (np.y + 0.5) / h;
      let bi = 0, bd = Infinity;
      contours[pj].pts.forEach((p, k) => { const d = Math.hypot(p.x - nx, (p.y - ny) * (h / w)); if (d < bd) { bd = d; bi = k; } });
      contours[i].parent = contours[pj].id;
      contours[i].branchAt = bi;
      branched++;
    }
  });
  return {
    contours, junctions, width: w, height: h,
    stats: { edgePixels, skeletonPixels, chains: joined.length, closed: contours.filter((c) => c.closed).length, branched },
  };
}

/** Douglas–Peucker that never removes protected indices. Returns kept indices in order. */
function rdp(P: { x: number; y: number }[], tol: number, protect: Set<number>, closed: boolean): number[] {
  const n = P.length;
  if (n <= 2) return P.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  if (closed) keep[Math.floor(n / 2)] = 1;
  for (const i of protect) keep[i] = 1;
  const anchors: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) anchors.push(i);
  const stack: [number, number][] = [];
  for (let k = 1; k < anchors.length; k++) stack.push([anchors[k - 1], anchors[k]]);
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = P[a].x, ay = P[a].y, bx = P[b].x, by = P[b].y;
    const L = Math.hypot(bx - ax, by - ay);
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = L < 1e-9 ? Math.hypot(P[i].x - ax, P[i].y - ay) : Math.abs((bx - ax) * (ay - P[i].y) - (ax - P[i].x) * (by - ay)) / L;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// ------------------------------------------------------------------ interpolation & pieces

/** Centripetal Catmull–Rom through a polyline: smooth curve samples for drawing and for reading
 *  pitch between vertices. `step` is the approximate spacing in the same units as the points. */
export function catmullRom(pts: { x: number; y: number }[], step: number, closed = false, aspect = 1): { x: number; y: number }[] {
  const n = pts.length;
  if (n < 3) return pts.map((p) => ({ ...p }));
  const P = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out: { x: number; y: number }[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const d = Math.hypot(p2.x - p1.x, (p2.y - p1.y) * aspect);
    const k = Math.max(1, Math.ceil(d / Math.max(1e-6, step)));
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, e: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - e) * t2 + (-a + 3 * b - 3 * c + e) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(closed ? { ...pts[0] } : { ...pts[n - 1] });
  return out;
}

export interface Piece {
  /** points ordered by increasing x (normalised) */
  pts: { x: number; y: number }[];
  str: number[];
  curv: number[];
  /** a near-vertical run: no horizontal extent to spread notes over */
  vertical: boolean;
}

/** Split a contour into x-monotone pieces at horizontal turning points, so a path that doubles
 *  back or closes on itself becomes several simultaneous lines instead of being flattened. Each
 *  piece is returned left→right. `tol` is the x-hysteresis (normalised). */
export function monotonePieces(c: Pick<Contour, 'pts' | 'str' | 'curv' | 'closed'>, tol: number): Piece[] {
  const n = c.pts.length;
  if (n < 2) return [];
  if (c.closed) {
    // start a loop at its leftmost point so it splits into exactly its upper and lower arcs
    let k = 0;
    for (let i = 1; i < n; i++) if (c.pts[i].x < c.pts[k].x) k = i;
    if (k) {
      const rot = <T,>(a: T[]) => [...a.slice(k), ...a.slice(0, k)];
      c = { pts: rot(c.pts), str: rot(c.str), curv: rot(c.curv), closed: true };
    }
  }
  const idx = Array.from({ length: c.closed ? n + 1 : n }, (_, i) => i % n);
  const out: Piece[] = [];
  let start = 0;
  let dir = 0;
  let ext = 0; // index (into idx) of the running extreme in the current direction
  const flush = (a: number, b: number) => {
    if (b <= a) return;
    const ids = idx.slice(a, b + 1);
    let pts = ids.map((i) => c.pts[i]);
    let str = ids.map((i) => c.str[i] ?? 0.5);
    let curv = ids.map((i) => c.curv[i] ?? 0);
    if (pts[pts.length - 1].x < pts[0].x) { pts = pts.reverse(); str = str.reverse(); curv = curv.reverse(); }
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const xSpan = Math.max(...xs) - Math.min(...xs);
    const ySpan = Math.max(...ys) - Math.min(...ys);
    // enforce strict monotonicity (tiny backward jitter inside the hysteresis band)
    for (let i = 1; i < pts.length; i++) if (pts[i].x < pts[i - 1].x) pts[i] = { ...pts[i], x: pts[i - 1].x };
    out.push({ pts, str, curv, vertical: xSpan < tol * 2 && ySpan > tol * 4 });
  };
  for (let k = 1; k < idx.length; k++) {
    const x = c.pts[idx[k]].x;
    const ex = c.pts[idx[ext]].x;
    if (dir === 0) {
      if (Math.abs(x - c.pts[idx[start]].x) > tol) { dir = Math.sign(x - c.pts[idx[start]].x); ext = k; }
      else if (Math.abs(x - c.pts[idx[start]].x) >= Math.abs(ex - c.pts[idx[start]].x)) ext = k;
      continue;
    }
    if ((x - ex) * dir >= 0) { ext = k; continue; }
    if ((ex - x) * dir > tol) {
      flush(start, ext);
      start = ext;
      dir = -dir;
      ext = k;
    }
  }
  flush(start, idx.length - 1);
  return out;
}
