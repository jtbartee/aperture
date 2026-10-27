import { selectedTrack, useStore } from '../../state/store';
import type { FeatureKey, ModRoute, ModTarget, Track } from '../../core/types';
import { FEATURE_KEYS, MOD_TARGETS } from '../../interpret/modmatrix';
import { getAnalysis } from '../../analysis/client';
import { Section } from '../components/controls';
import { uid } from '../../core/ids';
import { ITrash } from '../components/icons';

export function ModPanel() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const st = useStore.getState();
  const t = selectedTrack({ project, ui }) as Track | undefined;
  const routes = project.modRoutes;
  const hasImg = !!(project.image && getAnalysis(project.image.asset.assetId));
  const hasPano = !!(project.panorama && getAnalysis(project.panorama.asset.assetId));
  const setRoutes = (r: ModRoute[]) => { st.commit((p) => ({ ...p, modRoutes: r })); st.bakeModMatrix(); };
  const up = (id: string, patch: Partial<ModRoute>) => setRoutes(routes.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <>
      <Section title="Image → sound modulation matrix" right={
        <button className="btn small" disabled={!t || (!hasImg && !hasPano)} onClick={() => setRoutes([...routes, { id: uid('rt'), source: 'brightness', trackId: t!.id, target: 'cutoff', amount: 0.8, smoothing: 0.6, from: hasPano ? 'panorama' : 'image' }])}>+ Route</button>
      }>
        {!hasImg && !hasPano && <p className="note">Import and analyse an image or panorama to modulate sound with its features.</p>}
        <p className="note">Each route samples an image feature along the timeline (the panorama scan, or the image left→right) into a smoothed automation lane: brightness → filter, saturation → drive, texture → delay feedback, edges → tremolo rate, vertical position → pan…</p>
        {routes.map((r) => {
          const tr = project.tracks.find((x) => x.id === r.trackId);
          const tgt = MOD_TARGETS.find((m) => m.id === r.target);
          const missing = tgt?.needs && tr && !tr.fx.some((f) => tgt.needs!.toLowerCase().includes(f.type === 'atmosSweep' ? 'atmospheric' : f.type === 'pingpong' ? 'ping-pong' : f.type));
          return (
            <div className="fx" key={r.id}>
              <div className="fx-h">
                <select className="sel" aria-label="Source" value={r.from} onChange={(e) => up(r.id, { from: e.target.value as ModRoute['from'] })}>
                  <option value="image" disabled={!hasImg}>Image</option><option value="panorama" disabled={!hasPano}>Panorama</option>
                </select>
                <select className="sel" aria-label="Feature" value={r.source} onChange={(e) => up(r.id, { source: e.target.value as FeatureKey })} style={{ flex: 1 }}>
                  {FEATURE_KEYS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
                <button className="btn small icon" aria-label="Remove route" onClick={() => setRoutes(routes.filter((x) => x.id !== r.id))}><ITrash size={13} /></button>
              </div>
              <div className="fx-b">
                <div className="row"><span className="lbl">→ Layer</span>
                  <select className="sel" aria-label="Target layer" value={r.trackId} onChange={(e) => up(r.id, { trackId: e.target.value })}>{project.tracks.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
                <div className="row"><span className="lbl">→ Parameter</span>
                  <select className="sel" aria-label="Target parameter" value={r.target} onChange={(e) => up(r.id, { target: e.target.value as ModTarget })}>{MOD_TARGETS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></div>
                <div className="row"><label htmlFor={`amt${r.id}`}>Amount</label><input id={`amt${r.id}`} type="range" min={-1} max={1} step={0.01} value={r.amount} onChange={(e) => up(r.id, { amount: Number(e.target.value) })} /></div>
                <div className="row"><label htmlFor={`sm${r.id}`}>Smoothing</label><input id={`sm${r.id}`} type="range" min={0} max={0.97} step={0.01} value={r.smoothing} onChange={(e) => up(r.id, { smoothing: Number(e.target.value) })} /></div>
                {missing && <p className="note warn">“{tr!.name}” has no {tgt!.needs} insert — add one in the FX tab or this route has nothing to drive.</p>}
              </div>
            </div>
          );
        })}
      </Section>
      {t && (
        <Section title={`Automation on ${t.name}`}>
          {!t.automation.length && <p className="note">No automation lanes. Draw with the Modulation brush, add a matrix route, or generate one.</p>}
          {t.automation.map((a) => (
            <div key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '3px 0' }}>
              <span style={{ flex: 1 }}>{MOD_TARGETS.find((m) => m.id === a.target)?.label ?? a.target} <span className="badge">{a.origin}</span> <span className="note">{a.points.length} pts</span></span>
              <button className="btn small icon" aria-label="Delete lane" onClick={() => st.updateTrack(t.id, (x) => ({ ...x, automation: x.automation.filter((l) => l.id !== a.id) }))}><ITrash size={13} /></button>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
