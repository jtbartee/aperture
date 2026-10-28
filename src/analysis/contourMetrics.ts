// Contour fidelity measurement against ground truth (used by tests and the evaluation report).
import type { ContourSet } from './contours';

export interface TruthMatch {
  /** share of ground-truth samples within `tol` px of an extracted contour */
  coverage: number;
  /** RMS distance (px) of the covered samples */
  rms: number;
  /** share of covered samples matched by the single most frequent contour (path continuity) */
  continuity: number;
  /** contours needed to cover 90 % of the covered samples */
  pieces: number;
  dominant?: string;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Distance from every truth sample (pixel coords, y down) to the nearest extracted polyline. */
export function matchTruth(set: ContourSet, truth: { x: number; y: number }[], tol = 2): TruthMatch {
  const W = set.width, H = set.height;
  const polys = set.contours.map((c) => ({ id: c.id, closed: c.closed, p: c.pts.map((q) => ({ x: q.x * W - 0.5, y: (1 - q.y) * H - 0.5 })) }));
  let covered = 0, sq = 0;
  const hits = new Map<string, number>();
  for (const s of truth) {
    let best = Infinity, bid = '';
    for (const pl of polys) {
      const n = pl.p.length;
      for (let i = 1; i < n + (pl.closed ? 1 : 0); i++) {
        const a = pl.p[i - 1], b = pl.p[i % n];
        const d = segDist(s.x, s.y, a.x, a.y, b.x, b.y);
        if (d < best) { best = d; bid = pl.id; }
      }
    }
    if (best <= tol) { covered++; sq += best * best; hits.set(bid, (hits.get(bid) ?? 0) + 1); }
  }
  const counts = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  let acc = 0, pieces = 0;
  for (const [, c] of counts) { if (acc >= covered * 0.9) break; acc += c; pieces++; }
  return {
    coverage: covered / Math.max(1, truth.length),
    rms: covered ? Math.sqrt(sq / covered) : Infinity,
    continuity: covered ? (counts[0]?.[1] ?? 0) / covered : 0,
    pieces,
    dominant: counts[0]?.[0],
  };
}
