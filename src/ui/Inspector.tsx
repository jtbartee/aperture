import { useStore } from '../state/store';
import { TrackPanel } from './panels/TrackPanel';
import { FxPanel, SoundPanel } from './panels/SoundPanel';
import { BrushPanel, GenerativePanel, ImagePanel, OrbitalPanel, PanoramaPanel, ParticlePanel } from './panels/SourcePanels';
import { ModPanel } from './panels/ModPanel';
import { HarmonyPanel } from './panels/HarmonyPanel';

const TABS = [
  { id: 'source', label: 'Source' },
  { id: 'harmony', label: 'Harmony' },
  { id: 'track', label: 'Layer' },
  { id: 'sound', label: 'Sound' },
  { id: 'fx', label: 'FX' },
  { id: 'mod', label: 'Mod' },
] as const;

export function Inspector() {
  const tab = useStore((s) => s.ui.inspectorTab);
  const ws = useStore((s) => s.project.workspace);
  const st = useStore.getState();
  const source = ws === 'draw' ? <BrushPanel /> : ws === 'image' ? <ImagePanel /> : ws === 'panorama' ? <PanoramaPanel /> : ws === 'generative' ? <GenerativePanel /> : ws === 'orbital' ? <><OrbitalPanel /><BrushPanel /></> : <ParticlePanel />;
  return (
    <aside className="right" aria-label="Inspector">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => st.setUi({ inspectorTab: t.id })}>{t.label}</button>
        ))}
      </div>
      <div className="insp-body" role="tabpanel">
        {tab === 'source' ? source : tab === 'harmony' ? <HarmonyPanel /> : tab === 'track' ? <TrackPanel /> : tab === 'sound' ? <SoundPanel /> : tab === 'fx' ? <FxPanel /> : <ModPanel />}
      </div>
    </aside>
  );
}
