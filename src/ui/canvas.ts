import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../state/store';

/** A canvas that fills its (position:relative) parent at device-pixel resolution. The canvas is
 *  absolutely positioned so its backing store can never feed back into layout. */
export function useStageCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  // a callback ref that also exposes .current: the canvas may mount later (views with empty states)
  const [el, setEl] = useState<HTMLCanvasElement | null>(null);
  const ref = useMemo(() => {
    const f = ((node: HTMLCanvasElement | null) => { f.current = node; setEl(node); }) as ((node: HTMLCanvasElement | null) => void) & { current: HTMLCanvasElement | null };
    f.current = null;
    return f;
  }, []);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const size = useRef({ w: 0, h: 0 });
  const dirty = useRef(true);
  useEffect(() => {
    const c = el;
    if (!c || !c.parentElement) return;
    const parent = c.parentElement;
    const render = () => {
      const ctx = c.getContext('2d');
      if (!ctx || !size.current.w) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current(ctx, size.current.w, size.current.h);
    };
    const ro = new ResizeObserver(() => {
      const r = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      render();
    });
    ro.observe(parent);
    let raf = 0;
    // redraw every frame while playing (the playhead moves); otherwise only when invalidated
    const loop = () => {
      if (engine.state === 'playing' || dirty.current) { dirty.current = false; render(); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const unsub = engine.onChange(() => { dirty.current = true; });
    return () => { ro.disconnect(); cancelAnimationFrame(raf); unsub(); };
  }, [el]);
  useEffect(() => { dirty.current = true; }, deps);
  const invalidate = () => { dirty.current = true; };
  return { ref, size, invalidate };
}

export function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function download(data: BlobPart, name: string, type: string) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const safeName = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'aperture';
