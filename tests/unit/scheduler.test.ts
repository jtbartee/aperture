import { describe, expect, test } from 'vitest';
import { LiveEngine } from '../../src/audio/engine';
import { eventsInWindow } from '../../src/audio/schedule';
import { testProject } from './helpers';
import type { Project } from '../../src/core/types';

/** A fake audio graph with a controllable clock: records every triggered note. */
function rig(p: Project) {
  let now = 0;
  const triggered: { id: string; time: number; killed: boolean }[] = [];
  const live = new Set<{ start: number; end: number }>();
  const ch = { voices: new Set<any>(), resetAutomation() {}, applyMod() {} };
  const graph: any = {
    live: false,
    raw: { get currentTime() { return now; } },
    channels: new Map([['c', ch]]),
    sync() {},
    trigger(_t: any, n: any, time: number, dur: number) {
      const rec = { id: n.id, time, killed: false };
      triggered.push(rec);
      const v = { start: time, end: time + dur + 0.3, kill(t: number) { if (t <= time) rec.killed = true; v.end = Math.min(v.end, t); } };
      live.add(v); ch.voices.add(v);
      return v;
    },
    killAll(t: number) { for (const v of live) (v as any).kill(t); ch.voices.clear(); },
    click() {},
  };
  const project = { current: p };
  const eng = new LiveEngine(() => project.current);
  eng.graph = graph;
  const advance = (sec: number) => { const end = now + sec; while (now < end) { now = Math.min(end, now + 0.025); eng.tick(); } };
  const voices = () => [...live].filter((v) => v.end > now).length;
  return { eng, triggered, advance, voices, project, get now() { return now; } };
}

function grid(p: Project) {
  p.settings.bpm = 120;
  p.settings.lengthBars = 2;
  p.settings.loop = { on: true, start: 0, end: 8 };
  p.tracks[0].notes = Array.from({ length: 16 }, (_, i) => ({ id: `n${i}`, start: i * 0.5, dur: 0.25, midi: 60, vel: 0.8, origin: 'user' as const }));
  return p;
}

describe('transport / scheduler', () => {
  test('each note is scheduled exactly once per loop pass', async () => {
    const r = rig(grid(testProject()));
    await r.eng.play(0);
    r.advance(4 * 2 + 0.01); // two full loops at 120 bpm (8 beats = 4 s)
    const counts = new Map<string, number>();
    for (const t of r.triggered) counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
    for (let i = 0; i < 16; i++) expect(counts.get(`n${i}`)).toBeGreaterThanOrEqual(2);
    for (const c of counts.values()) expect(c).toBeLessThanOrEqual(3);
    // strictly increasing scheduled times: no doubled events
    for (let i = 1; i < r.triggered.length; i++) expect(r.triggered[i].time).toBeGreaterThan(r.triggered[i - 1].time - 1e-9);
  });

  test('Example I: stop / seek / play repeatedly → no doubled events, no stuck voices', async () => {
    const r = rig(grid(testProject()));
    for (let k = 0; k < 20; k++) {
      await r.eng.play();
      r.advance(0.3 + (k % 3) * 0.2);
      if (k % 2) r.eng.seek((k * 1.7) % 8); else r.eng.stop();
      r.advance(0.05);
    }
    r.eng.stop();
    r.advance(1);
    expect(r.voices()).toBe(0);
    // within any 10 ms window, a note id never fires twice
    const seen = new Map<string, number>();
    for (const t of r.triggered) {
      const prev = seen.get(t.id);
      if (prev !== undefined) expect(t.time - prev).toBeGreaterThan(0.01);
      seen.set(t.id, t.time);
    }
  });

  test('tempo affects actual timing and a tempo change mid-play does not double notes', async () => {
    const p = grid(testProject());
    const r = rig(p);
    await r.eng.play(0);
    r.advance(1.0);
    const at120 = r.triggered.length;
    r.project.current = { ...p, settings: { ...p.settings, bpm: 60 } };
    r.eng.retempo();
    r.advance(1.0);
    const at60 = r.triggered.length - at120;
    expect(at60).toBeLessThan(at120);
    // a note scheduled in the lookahead at the old tempo is cancelled before it sounds and rescheduled once
    const ids = r.triggered.filter((t) => !t.killed).map((t) => t.id);
    const n4 = ids.filter((x) => x === 'n4').length;
    expect(n4).toBeLessThanOrEqual(1);
    // the position follows the audio clock
    expect(r.eng.position()).toBeGreaterThan(2.5);
    expect(r.eng.position()).toBeLessThan(3.5);
  });

  test('regeneration queued for the next bar lands on the bar line', async () => {
    const p = grid(testProject());
    const r = rig(p);
    await r.eng.play(0);
    r.advance(0.6); // beat 1.2
    let committed = -1;
    r.eng.queueSwap('regen', 4, () => { committed = r.eng.position(); });
    expect(committed).toBe(-1);
    r.advance(1.6);
    expect(committed).toBeGreaterThan(3.5);
    expect(committed).toBeLessThan(4.3);
  });

  test('mute and solo decide which tracks are scheduled', () => {
    const p = grid(testProject());
    p.tracks[1].notes = [{ id: 'b', start: 0, dur: 1, midi: 40, vel: 1, origin: 'user' }];
    expect(eventsInWindow(p, 0, 1).map((e) => e.note.id).sort()).toEqual(['b', 'n0', 'n1']);
    p.tracks[0].mix.mute = true;
    expect(eventsInWindow(p, 0, 1).map((e) => e.note.id)).toEqual(['b']);
    p.tracks[0].mix.mute = false;
    p.tracks[0].mix.solo = true;
    expect(eventsInWindow(p, 0, 1).map((e) => e.note.id)).toEqual(['n0', 'n1']);
  });
});
