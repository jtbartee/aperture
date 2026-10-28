// The Harmony tab: one place to see and steer the shared musical context every generator reads —
// key, scale, behaviour, progression, harmonic rhythm, chord colour, a typed chord sequence, lock /
// regenerate — plus a live "why these notes" readout for the selected layer.

import { useEffect, useState } from 'react';
import { engine, autoProgression, projectContext, selectedTrack, useStore } from '../../state/store';
import type { ChordColour, HarmonyBehavior, ProgressionMode, ScaleId } from '../../core/types';
import { Check, Section, Seg, Select } from '../components/controls';
import { KEY_NAMES, SCALES, SCALE_IDS, pcName } from '../../theory/scales';
import { chordSymbol } from '../../theory/chords';
import { PROGRESSION_TYPES, parseChordSequence } from '../../theory/progression';
import { chordDegrees, chordLongName, explain, familyNote, romanNumeral, sectionAt, slotAt } from '../../theory/context';
import { IDice } from '../components/icons';

/** Re-render on an interval while mounted (live readouts that follow the playhead). */
export function useTicker(ms = 200) {
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((x) => x + 1), ms); return () => clearInterval(id); }, [ms]);
}

const BEHAVIOR_NOTE: Record<HarmonyBehavior, string> = {
  strict: 'Every melodic note stays in the scale; strong beats and phrase endings land on chord tones; no chromatic chords.',
  expressive: 'Scale-aware with intent: passing and neighbour tones, suspensions and appoggiaturas that resolve by step; a borrowed dominant in minor at cadences.',
  experimental: 'Outside tones, chromatic passing notes, chromatic mediants and clusters — still organised by motif, rhythm and a tonal home.',
};

const AUTHOR: Record<string, string> = { none: 'Nothing has written chords yet — sequencers follow the tonic chord.', generative: 'Chords written by the generative composer.', image: 'Chords derived from the image’s colour.', panorama: 'Chords derived from the panorama’s colour along the scan.', harmony: 'Chords written here, in the harmony panel.' };

export function HarmonyPanel() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const st = useStore.getState();
  const h = project.harmony;
  const s = project.settings;
  const ctx = projectContext(project);
  const [seq, setSeq] = useState(h.sequence);
  useEffect(() => setSeq(h.sequence), [h.sequence]);
  const parsed = parseChordSequence(seq, s.key, s.scale, s.customScale);
  const names = (pc: number) => pcName(pc, s.key, s.scale);
  const auto = PROGRESSION_TYPES.find((p) => p.id === autoProgression(project))?.label ?? '';
  return (
    <>
      <HarmonyNow />
      <Section title="Key and scale">
        <div className="row2">
          <Select ariaLabel="Harmony key" value={s.key} options={KEY_NAMES.map((k, i) => ({ value: i, label: k }))} onChange={(v) => st.setSettings({ key: v })} />
          <Select ariaLabel="Harmony scale" value={s.scale} options={SCALE_IDS.map((id) => ({ value: id, label: SCALES[id].name }))} onChange={(v: ScaleId) => st.setSettings({ scale: v })} />
        </div>
        <p className="scale-tones" aria-label="Scale tones">
          {ctx.pcs.map((pc, i) => <span key={i} className={ctx.characteristic.includes(pc) ? 'colour' : i === 0 ? 'tonic' : ''} title={ctx.characteristic.includes(pc) ? 'Characteristic colour tone of this scale' : `${i + 1}`}>{names(pc)}</span>)}
        </p>
        <p className="note">{familyNote(ctx)} The key and scale here and in the toolbar are the same setting — every workspace uses them.</p>
      </Section>
      <Section title="Harmonic behaviour">
        <Seg value={h.behavior} onChange={(v: HarmonyBehavior) => st.setHarmony({ behavior: v }, true)} options={[{ value: 'strict', label: 'Strict' }, { value: 'expressive', label: 'Expressive' }, { value: 'experimental', label: 'Experimental' }]} />
        <p className="note">{BEHAVIOR_NOTE[h.behavior]}</p>
      </Section>
      <Section title="Progression" right={<Check label="Lock" title="Keep these chords when anything regenerates" checked={h.lock} onChange={(v) => st.setHarmony({ lock: v })} />}>
        <Select label="Approach" value={h.progression} onChange={(v: ProgressionMode) => st.setHarmony({ progression: v }, true)}
          options={[{ value: 'auto', label: `Auto (${auto} / style)` }, ...PROGRESSION_TYPES.map((p) => ({ value: p.id, label: p.id === 'chromatic' && h.behavior !== 'experimental' ? `${p.label} (Experimental only)` : p.label }))]} />
        <Select label="Chord length" value={h.rhythm} onChange={(v) => st.setHarmony({ rhythm: v }, true)}
          options={[{ value: 0, label: 'Auto' }, { value: 0.5, label: '½ bar' }, { value: 1, label: '1 bar' }, { value: 2, label: '2 bars' }, { value: 4, label: '4 bars' }, { value: 8, label: '8 bars' }]} />
        <Select label="Chord colour" value={h.colour} onChange={(v: ChordColour) => st.setHarmony({ colour: v }, true)}
          options={[{ value: 'auto', label: 'Auto' }, { value: 'triads', label: 'Triads' }, { value: 'sevenths', label: 'Sevenths' }, { value: 'ninths', label: 'Ninths' }, { value: 'sus', label: 'Suspended' }, { value: 'added', label: 'Added tones (add9, 6)' }, { value: 'quartal', label: 'Quartal' }]} />
        <div className="row"><label htmlFor="harm-seq">Your chords</label>
          <span style={{ display: 'flex', gap: 4 }}>
            <input id="harm-seq" className="txt" style={{ flex: 1, minWidth: 0, height: 24 }} placeholder="Dm7 G Am7 C  or  i IV i bVII" value={seq} onChange={(e) => setSeq(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') st.setHarmony({ sequence: seq, progression: seq.trim() ? 'custom' : h.progression === 'custom' ? 'auto' : h.progression }, true); }} />
            <button className="btn small" disabled={!seq.trim() || !!parsed.errors.length} onClick={() => st.setHarmony({ sequence: seq, progression: 'custom' }, true)}>Use</button>
          </span>
        </div>
        {!!parsed.errors.length && <p className="note err">Not understood: {parsed.errors.join(', ')}</p>}
        {!!seq.trim() && !parsed.errors.length && <p className="note">{parsed.chords.map((c) => chordSymbol(c.chord, names) + (c.chord.outside?.length ? '*' : '')).join(' · ')}{parsed.chords.some((c) => c.chord.outside?.length) ? ' — * has tones outside the scale (melodies stay in the scale in Strict)' : ''}</p>}
        <div className="btnrow">
          <button className="btn primary small" disabled={h.lock} onClick={() => st.regenerateHarmony(true)} title="New chords from a new harmony seed; themes, rhythms and drawings stay and follow the new chords"><IDice size={13} /> Regenerate harmony only</button>
          <button className="btn small" disabled={h.lock} onClick={() => st.regenerateHarmony(false)} title="Rebuild the chords from the current settings (same seed)">Apply</button>
        </div>
        <p className="note">{AUTHOR[h.author] ?? ''}{h.lock ? ' Locked: generators use these chords as they are.' : ''}</p>
      </Section>
      <Section title={`Timeline · ${h.slots.length || 1} chord${h.slots.length === 1 ? '' : 's'}`}>
        <ChordChips />
      </Section>
      <WhyNotes trackName={selectedTrack({ project, ui })?.name ?? ''} />
    </>
  );
}

/** The chord timeline as chips; the chord under the playhead is highlighted. */
function ChordChips() {
  useTicker(250);
  const project = useStore.getState().project;
  const ctx = projectContext(project);
  const names = (pc: number) => pcName(pc, ctx.key, ctx.scale);
  const pos = engine.position();
  const cur = slotAt(ctx, pos);
  const slots = ctx.slots.slice(0, 48);
  return (
    <div className="chips" role="list" aria-label="Chord timeline">
      {slots.map((sl, i) => (
        <button key={i} role="listitem" className={`chip ${sl === cur ? 'on' : ''} ${sl.chord.outside?.length ? 'outside' : ''}`} title={`${chordLongName(ctx, sl)} · degrees ${chordDegrees(ctx, sl)}${sl.func ? ` · ${sl.func}` : ''} — click to play from here`} onClick={() => engine.seek(sl.start)}>
          <b>{chordSymbol(sl.chord, names)}</b><small>{romanNumeral(ctx, sl)}</small>
        </button>
      ))}
      {ctx.slots.length > 48 && <span className="note">… {ctx.slots.length - 48} more</span>}
    </div>
  );
}

/** Why the selected layer's sounding notes were chosen. */
function WhyNotes({ trackName }: { trackName: string }) {
  useTicker(200);
  const st = useStore.getState();
  const p = st.project;
  const t = p.tracks.find((x) => x.id === st.ui.selectedTrackId);
  if (!t || t.pitch.mode === 'drums') return null;
  const ctx = projectContext(p);
  const pos = engine.position();
  const sounding = t.notes.filter((n) => n.start <= pos + 1e-6 && n.start + n.dur > pos).slice(0, 4);
  const recent = sounding.length ? sounding : t.notes.filter((n) => n.start <= pos).slice(-2);
  return (
    <Section title={`Why these notes · ${trackName}`}>
      {!recent.length && <p className="note">Play, or move the playhead over this layer’s notes, to see why each was chosen.</p>}
      {recent.map((n) => <p key={n.id} className="why">{explain(ctx, n.midi, n.start)}</p>)}
    </Section>
  );
}

/** Compact live readout: key · scale · chord (numeral) · its scale degrees · section. */
export function HarmonyNow({ compact = false }: { compact?: boolean }) {
  useTicker(compact ? 150 : 250);
  const p = useStore.getState().project;
  const ctx = projectContext(p);
  const pos = engine.position();
  const slot = slotAt(ctx, pos);
  const names = (pc: number) => pcName(pc, ctx.key, ctx.scale);
  const sec = sectionAt(ctx, pos);
  const body = (
    <>
      <span className="k">{names(ctx.key)} {SCALES[ctx.scale].name}</span>
      <span className="c">{chordSymbol(slot.chord, names)}</span>
      <span className="r">{romanNumeral(ctx, slot)}</span>
      <span className="d" title="The chord’s tones as scale degrees">{chordDegrees(ctx, slot)}</span>
      {sec && <span className="s">{sec}</span>}
      <span className="b">{p.harmony.behavior}</span>
    </>
  );
  if (compact) return <button className="music-strip" title="Current key, scale, chord, its scale degrees and section — open the Harmony tab" onClick={() => useStore.getState().setUi({ inspectorTab: 'harmony', rightOpen: true })}>{body}</button>;
  return <div className="music-strip big" aria-live="off">{body}</div>;
}
