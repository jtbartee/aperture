// Drawing of traced contours: the overlay shows the geometry that was detected — never piano-roll
// bars standing in for it. One colour per contour (golden-angle hues), smooth Catmull–Rom curves
// through the simplified vertices, junction markers and branch starts.

import { catmullRom, type ContourSet } from '../analysis/contours';

export const contourColor = (rank: number, alpha = 1) => `hsla(${(rank * 137.508 + 28) % 360}, 78%, 62%, ${alpha})`;

export interface ContourDrawOpts {
  /** image x (0..1) → canvas x, image y (0..1, bottom-up) → canvas y */
  X: (x: number) => number;
  Y: (y: number) => number;
  /** canvas pixels per unit x / unit y (for curve resolution) */
  sx: number;
  sy: number;
  width?: number;
  alpha?: number;
  /** contour ids that are sounding now (drawn bold) */
  active?: Set<string>;
  /** contour ids that have notes; others are drawn faint and dashed (detected but silent) */
  voiced?: Set<string>;
  junctions?: boolean;
  /** only draw where canvas x is within this range (panorama viewport) */
  clip?: [number, number];
}

export function drawContours(ctx: CanvasRenderingContext2D, set: ContourSet, o: ContourDrawOpts) {
  const step = 3 / Math.max(1, o.sx);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const c of set.contours) {
    const xs = c.pts.map((p) => o.X(p.x));
    if (o.clip && (Math.max(...xs) < o.clip[0] || Math.min(...xs) > o.clip[1])) continue;
    const on = o.active?.has(c.id);
    const silent = o.voiced && !o.voiced.has(c.id);
    const pts = catmullRom(c.pts, step, c.closed, o.sy / Math.max(1, o.sx));
    ctx.strokeStyle = contourColor(c.rank, on ? 1 : silent ? 0.4 : o.alpha ?? 0.9);
    ctx.lineWidth = (o.width ?? 1.8) * (on ? 2 : 1);
    ctx.setLineDash(silent ? [5, 4] : []);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(o.X(p.x), o.Y(p.y)) : ctx.moveTo(o.X(p.x), o.Y(p.y))));
    if (c.closed) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    if (c.parent !== undefined) {
      // branch start: a small open circle where it leaves its parent
      const p0 = c.pts[0];
      ctx.beginPath();
      ctx.arc(o.X(p0.x), o.Y(p0.y), 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (o.junctions) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    for (const j of set.junctions) {
      const x = o.X(j.x);
      if (o.clip && (x < o.clip[0] || x > o.clip[1])) continue;
      ctx.beginPath();
      ctx.arc(x, o.Y(j.y), 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
