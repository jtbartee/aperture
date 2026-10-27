// SCENES: snapshots of the track set (patterns + mix). The arrangement chains scenes and can be
// "printed" into one linear timeline, which is then what plays and exports.

import type { ArrangementEntry, Project, Scene, Track } from '../core/types';
import { barBeats } from '../core/time';

export function captureScene(p: Project, id: string, name: string): Scene {
  return { id, name, bars: p.settings.lengthBars, tracks: structuredClone(p.tracks) };
}

export function printArrangement(p: Project, entries: ArrangementEntry[]): { tracks: Track[]; bars: number } {
  const bb = barBeats(p.settings.timeSig);
  const byId = new Map<string, Track>();
  let offset = 0;
  for (const e of entries) {
    const scene = p.scenes.find((s) => s.id === e.sceneId);
    if (!scene) continue;
    const len = scene.bars * bb;
    for (let rep = 0; rep < Math.max(1, e.repeats); rep++) {
      for (const t of scene.tracks) {
        let out = byId.get(t.id);
        if (!out) { out = { ...structuredClone(t), notes: [], automation: [] }; byId.set(t.id, out); }
        const audible = !t.mix.mute;
        if (audible) {
          for (const n of t.notes) if (n.start < len - 1e-9) out.notes.push({ ...n, id: `${n.id}_s${offset}`, start: n.start + offset, dur: Math.min(n.dur, len - n.start) });
        }
        for (const lane of t.automation) {
          let dst = out.automation.find((l) => l.id === lane.id);
          if (!dst) { dst = { ...lane, points: [] }; out.automation.push(dst); }
          for (const pt of lane.points) if (pt.beat <= len) dst.points.push({ beat: pt.beat + offset, value: pt.value });
        }
      }
      offset += len;
    }
  }
  for (const t of byId.values()) { t.mix = { ...t.mix, mute: false }; t.notes.sort((a, b) => a.start - b.start); }
  return { tracks: [...byId.values()], bars: Math.round(offset / bb) };
}
