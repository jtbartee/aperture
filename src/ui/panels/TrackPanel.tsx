import { selectedTrack, useStore } from '../../state/store';
import type { PitchMode, Role, Track } from '../../core/types';
import { ALL_PRESETS, instrument } from '../../audio/patches';
import { midiName, pcName } from '../../theory/scales';
import { Check, Section, Seg, Select, Slider } from '../components/controls';
import { SUBDIVISIONS } from '../../theory/rhythm';
import { userPresets } from './SoundPanel';
import { ILock, ITrash } from '../components/icons';
import { sourceBadge } from '../Sidebar';
import { remapTrack } from '../../interpret/remap';

const ROLES: Role[] = ['melody', 'bass', 'pad', 'chords', 'drone', 'arp', 'percussion', 'texture'];

export function TrackPanel() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const t = selectedTrack({ project, ui }) as Track | undefined;
  const st = useStore.getState();
  if (!t) return <p className="note" style={{ padding: 12 }}>No layer selected.</p>;
  const up = (fn: (x: Track) => Track, history = true) => st.updateTrack(t.id, fn, history);
  const presets = [...ALL_PRESETS, ...userPresets()];
  const isGen = !!t.generator;
  const lockedSel = t.notes.filter((n) => ui.selNotes.includes(n.id));
  const remap = (x: Track) => remapTrack(x, project.settings);
  return (
    <>
      <Section title="Layer" right={sourceBadge(t)}>
        <div className="row"><label htmlFor="tname">Name</label><input id="tname" className="txt" value={t.name} onChange={(e) => up((x) => ({ ...x, name: e.target.value }), false)} onBlur={() => st.checkpoint()} /></div>
        <div className="row"><label htmlFor="tcol">Colour</label><input id="tcol" type="color" value={t.color} onChange={(e) => up((x) => ({ ...x, color: e.target.value }), false)} style={{ width: 48, height: 24, border: 0, background: 'none' }} /></div>
        <Select label="Role" value={t.role} options={ROLES.map((r) => ({ value: r, label: r }))} onChange={(v) => up((x) => ({ ...x, role: v }))} />
        <Select label="Instrument" value={t.patch.name} options={[...new Set(presets.map((p) => p.name))].map((n) => ({ value: n, label: n }))} onChange={(v) => st.setPatch(t.id, structuredClone(presets.find((p) => p.name === v) ?? instrument(v)))} />
        <p className="note">{t.notes.length} notes · source: {t.source}{t.generator ? ` · generator ${t.generator}` : ''}</p>
        <div className="btnrow">
          <button className="btn small danger" onClick={() => { if (confirm(`Delete layer “${t.name}”?`)) st.removeTrack(t.id); }}><ITrash size={13} /> Delete layer</button>
        </div>
      </Section>
      <Section title="Pitch mapping">
        <Seg value={t.pitch.mode} onChange={(v: PitchMode) => { up((x) => ({ ...x, pitch: { ...x.pitch, mode: v, ...(v === 'drums' ? { low: 36, high: 56 } : {}) } })); st.commit((p) => ({ ...p, tracks: p.tracks.map((x) => (x.id === t.id ? remap(x) : x)) }), false); }}
          options={[{ value: 'scale', label: 'Scale' }, { value: 'pentatonic', label: 'Penta' }, { value: 'chromatic', label: 'Chrom.' }, { value: 'custom', label: 'Custom' }, { value: 'drums', label: 'Drums' }]} />
        {t.pitch.mode !== 'drums' && (
          <>
            <Slider label={`Low · ${midiName(t.pitch.low)}`} value={t.pitch.low} min={12} max={t.pitch.high - 5} step={1} onStart={st.checkpoint} onChange={(v) => up((x) => remap({ ...x, pitch: { ...x.pitch, low: v } }), false)} fmt={(v) => String(v)} />
            <Slider label={`High · ${midiName(t.pitch.high)}`} value={t.pitch.high} min={t.pitch.low + 5} max={108} step={1} onStart={st.checkpoint} onChange={(v) => up((x) => remap({ ...x, pitch: { ...x.pitch, high: v } }), false)} fmt={(v) => String(v)} />
            <p className="note">The canvas bottom is {midiName(t.pitch.low)}, the top {midiName(t.pitch.high)} ({Math.round((t.pitch.high - t.pitch.low) / 12 * 10) / 10} octaves).</p>
          </>
        )}
        {t.pitch.mode === 'custom' && (
          <div className="btnrow" role="group" aria-label="Custom pitch set (relative to the key)">
            {Array.from({ length: 12 }, (_, i) => {
              const on = (t.pitch.custom ?? [0, 2, 4, 7, 9]).includes(i);
              return <button key={i} className={`btn small ${on ? 'on' : ''}`} aria-pressed={on} style={{ minWidth: 34 }} onClick={() => {
                const cur = t.pitch.custom ?? [0, 2, 4, 7, 9];
                const next = on ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b);
                if (next.length) up((x) => remap({ ...x, pitch: { ...x.pitch, custom: next } }));
              }}>{pcName(project.settings.key + i, project.settings.key, project.settings.scale)}</button>;
            })}
          </div>
        )}
      </Section>
      <Section title="Rhythm identity">
        <p className="note">Each layer can have its own pattern length and phase. Generated layers re-read these settings when you regenerate them.</p>
        <Select label="Subdivision" value={t.rhythm.subdiv} options={SUBDIVISIONS.map((d) => ({ value: d.steps, label: d.label }))} onChange={(v) => st.setTrackRhythm(t.id, { subdiv: v })} />
        <Slider label="Pattern length" value={t.rhythm.length} min={2} max={32} step={1} onStart={st.checkpoint} onChange={(v) => up((x) => ({ ...x, rhythm: { ...x.rhythm, length: v, pulses: Math.min(x.rhythm.pulses, v) } }), false)} fmt={(v) => `${v} st`} />
        <Slider label="Pulses (Euclid)" value={t.rhythm.pulses} min={1} max={t.rhythm.length} step={1} onStart={st.checkpoint} onChange={(v) => up((x) => ({ ...x, rhythm: { ...x.rhythm, pulses: v } }), false)} fmt={(v) => String(v)} />
        <Slider label="Rotation" value={t.rhythm.rotation} min={0} max={t.rhythm.length - 1} step={1} onStart={st.checkpoint} onChange={(v) => up((x) => ({ ...x, rhythm: { ...x.rhythm, rotation: v } }), false)} fmt={(v) => String(v)} />
        <Slider label="Probability" value={t.rhythm.probability} min={0} max={1} def={1} onStart={st.checkpoint} onChange={(v) => up((x) => ({ ...x, rhythm: { ...x.rhythm, probability: v } }), false)} />
        <Slider label="Ratchets" value={t.rhythm.ratchet} min={0} max={1} def={0} onStart={st.checkpoint} onChange={(v) => up((x) => ({ ...x, rhythm: { ...x.rhythm, ratchet: v } }), false)} />
        <Slider label="Humanise" value={t.rhythm.humanize} min={0} max={1} def={0} onStart={st.checkpoint} onChange={(v) => up((x) => ({ ...x, rhythm: { ...x.rhythm, humanize: v } }), false)} />
      </Section>
      <Section title="Regenerate">
        {isGen ? (
          <>
            <Slider label="Variation" title="Share of bars replaced by the new take (0 = keep all, 1 = replace all)" value={t.variation} min={0} max={1} def={1} onStart={st.checkpoint} onChange={(v) => up((x) => ({ ...x, variation: v }), false)} />
            <div className="btnrow">
              <button className="btn small primary" onClick={() => st.regenerateTrack(t.id, true)}>Regenerate this layer</button>
              <button className="btn small" onClick={() => st.regenerateTrack(t.id, false)} title="Re-run with the same seed (picks up rhythm / pitch edits)">Re-run</button>
            </div>
            <p className="note">Seed {t.seed}. Other layers are preserved; your hand-added and locked notes are kept.</p>
          </>
        ) : <p className="note">This layer is hand-drawn or edited; its notes come from strokes and edits, not a generator.</p>}
        <div className="btnrow">
          <button className="btn small" disabled={!lockedSel.length} onClick={() => st.updateTrack(t.id, (x) => ({ ...x, notes: x.notes.map((n) => (ui.selNotes.includes(n.id) ? { ...n, locked: !lockedSel.every((q) => q.locked) } : n)) }))}><ILock size={13} /> Lock / unlock selected notes</button>
        </div>
        <Check label="Keep locked notes when regenerating" checked={project.composition.locks.selected} onChange={(v) => st.setComposition({ locks: { ...project.composition.locks, selected: v } })} />
      </Section>
    </>
  );
}

