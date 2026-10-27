// Deterministic pseudo-random streams. Every generator takes an explicit Rng so that
// the same inputs + seed always produce identical event data.

export interface Rng {
  (): number;
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
  weighted<T>(xs: readonly T[], w: readonly number[]): T;
  gauss(): number;
  fork(label: string | number): Rng;
  readonly seed: number;
}

/** 32-bit FNV-1a hash, used to derive child seeds from labels. */
export function hash32(s: string | number): number {
  const str = String(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = (() => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = (xs) => xs[Math.floor(next() * xs.length)];
  next.chance = (p) => next() < p;
  next.weighted = (xs, w) => {
    const total = w.reduce((s, x) => s + Math.max(0, x), 0);
    if (total <= 0) return xs[0];
    let r = next() * total;
    for (let i = 0; i < xs.length; i++) {
      r -= Math.max(0, w[i]);
      if (r <= 0) return xs[i];
    }
    return xs[xs.length - 1];
  };
  next.gauss = () => {
    const u = Math.max(1e-9, next());
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  next.fork = (label) => rng(hash32(`${seed}:${label}`));
  Object.defineProperty(next, 'seed', { value: seed >>> 0 });
  return next;
}

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
