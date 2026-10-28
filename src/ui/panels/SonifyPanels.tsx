// Controls shared by the Image and Panorama inspectors: the four shaping controls, the rhythm
// system, contour extraction and the Image Synth mapping table.

import type { ContourPreset, ContourSettings, FeatureKey, RhythmMode, SonifyShape, SynthMapping, SynthTarget } from '../../core/types';
import { Check, Section, Seg, Select, Slider } from '../components/controls';
import { CONTOUR_PRESETS, contourPreset, type ContourSet } from '../../analysis/contours';
import { FEATURE_KEYS } from '../../interpret/modmatrix';
import { defaultSynthMap, SYNTH_TARGET_IDS, SYNTH_TARGETS } from '../../audio/imageSynth';
import { useStore } from '../../state/store';

type Shaped = SonifyShape & { density: number };
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** VISUAL FIDELITY, MUSICAL STRUCTURE, EVOLUTION, EVENT DENSITY, Literal ↔ Musical, pitch and rhythm. */
export function ShapeControls<T extends Shaped>({ s, set }: { s: T; set: (patch: Partial<T>, regen: boolean) => void }) {
  const st = useStore.getState();
  const S = (k: 'fidelity' | 'structure' | 'evolution' | 'density' | 'interpretation', label: string, title: string, left: string, right: string) => (
    <>
      <Slider label={label} title={title} value={s[k]} min={0} max={1} fmt={pct} onStart={st.checkpoint} onChange={(v) => set({ [k]: v } as Partial<T>, false)} onCommit={() => set({} as Partial<T>, true)} />
      <div className="scale-ends" aria-hidden="true"><span>{left}</span><span>{right}</span></div>
    </>
  );
  return (
    <Section title="Sonification">
      {S('fidelity', 'Visual fidelity', 'How strictly timing and pitch follow the picture. High values switch off register compression, octave displacement, harmonisation and seeded re-readings, and soften grid snapping.', 'freer reading', 'strict correspondence')}
      {S('structure', 'Musical structure', 'Independent of fidelity. Low: unmetered, microtonal when glide is on. Higher: scale quantisation, onsets pulled toward a grid (≥30 %), long notes lean to the image harmony (≥60 %).', 'unmetered, image-led', 'key, harmony, grid')}
      {S('interpretation', 'Literal ↔ Musical', 'Contour shaping. Literal keeps every visible bend; musical simplifies, groups notes, breathes between phrases, harmonises and arpeggiates closed loops.', 'literal contour', 'musical contour')}
      {S('evolution', 'Evolution', 'How strongly the Image Synth timbre and the atmosphere change along the scan. 0 % = one static, repeatable patch.', 'static', 'ever-changing')}
      {S('density', 'Event density', 'How many contours speak, how finely each is read, and how close image events may sit. Never a random probability on a grid.', 'sparse, silences', 'dense')}
      <div className="row2">
        <Check label="Continuous pitch (glide)" title="Contour notes bend with the shape; microtonal when musical structure is below 20 %" checked={s.glide} onChange={(v) => set({ glide: v } as Partial<T>, true)} />
        <Check label="Scale lock" title="Off = chromatic pitch rows" checked={s.scaleLock} onChange={(v) => set({ scaleLock: v } as Partial<T>, true)} />
      </div>
      <h3 className="h">Rhythm</h3>
      <div className="seg-full">
        <Seg value={s.rhythm} onChange={(v: RhythmMode) => set({ rhythm: v } as Partial<T>, true)} label="Rhythm" options={[
          { value: 'free', label: 'Free time', title: 'Events sit where the image changes: contour starts, junctions, extrema, colour and light boundaries' },
          { value: 'texture', label: 'Image texture', title: 'Micro-events at the peaks of the image’s edge profile: clicks, grains, accents and pulses from repeated structure' },
          { value: 'metric', label: 'Metric beat', title: 'The conventional sixteenth-grid drum engine (explicit opt-in)' },
        ]} />
      </div>
      <p className="note">{({
        free: 'Free time: no drum kit, no metrical pulse. The tempo only organises the transport and export.',
        texture: 'Image texture: rhythmic activity placed by the image’s own detail — dense regions cluster, smooth regions stay sparse, repeated structures pulse.',
        metric: 'Metric beat: a conventional drum layer on the bar grid, for motorik, krautrock or dub.',
      } as const)[s.rhythm]}</p>
    </Section>
  );
}

export function ContourControls({ c, set, stats }: { c: ContourSettings; set: (patch: Partial<ContourSettings>, regen: boolean) => void; stats?: ContourSet }) {
  const st = useStore.getState();
  const S = (k: Exclude<keyof ContourSettings, 'preset'>, label: string, min: number, max: number, title: string, step?: number, fmt?: (v: number) => string) => (
    <Slider label={label} title={title} value={c[k]} min={min} max={max} step={step} fmt={fmt} onStart={st.checkpoint}
      onChange={(v) => set({ [k]: v, preset: 'custom' } as Partial<ContourSettings>, false)} onCommit={() => set({}, true)} />
  );
  const presets: { value: ContourPreset; label: string }[] = [...(Object.keys(CONTOUR_PRESETS) as Exclude<ContourPreset, 'custom'>[]).map((k) => ({ value: k, label: CONTOUR_PRESETS[k].label })), { value: 'custom', label: 'Custom' }];
  return (
    <Section title="Contour analysis">
      <Select label="Preset" value={c.preset} options={presets} onChange={(v: ContourPreset) => { if (v !== 'custom') { st.checkpoint(); set(contourPreset(v), true); } }} />
      {S('sensitivity', 'Edge sensitivity', 0, 1, 'How far above the image’s own gradient noise an edge must rise (relative)')}
      {S('minStrength', 'Min edge strength', 0, 1, 'Absolute contrast an edge needs — a uniform image stays silent')}
      {S('minLength', 'Min contour length', 4, 240, 'Shorter contours are dropped (analysis pixels)', 1, (v) => `${Math.round(v)} px`)}
      {S('detail', 'Contour detail', 0, 1, 'Simplification tolerance: 100 % keeps every visible bend')}
      {S('smoothing', 'Smoothing', 0, 1, 'Geometric smoothing of the traced path')}
      {S('curvature', 'Curvature preservation', 0, 1, 'How strongly corners resist smoothing and simplification')}
      {S('separation', 'Contour separation', 0, 1, 'Low merges both sides of thin lines and bridges small gaps; high keeps every edge apart and splits at sharp corners')}
      {S('branches', 'Branch detection', 0, 1, 'Low folds short side branches into their stems; high keeps every branch as its own contour')}
      {S('maxContours', 'Max active contours', 1, 64, 'Most salient contours kept', 1, (v) => String(Math.round(v)))}
      {S('multiScale', 'Multi-scale analysis', 0, 1, 'Weight of the coarse scale: fine edges not supported by larger structure are dropped')}
      {stats && <p className="note">{stats.contours.length} contours · {stats.contours.filter((x) => x.closed).length} closed · {stats.stats.branched} branches · {stats.junctions.length} junctions. Contour changes re-run only the contour stage.</p>}
    </Section>
  );
}

export function SynthControls<T extends Shaped>({ s, set }: { s: T; set: (patch: Partial<T>, regen: boolean) => void }) {
  const st = useStore.getState();
  const feat: { value: FeatureKey; label: string }[] = [...FEATURE_KEYS.map((f) => ({ value: f.id, label: f.label })), { value: 'none', label: '— fixed —' }];
  const map = s.synthMap;
  const setMap = (m: SynthMapping[], regen = true) => set({ synthMap: m } as Partial<T>, regen);
  const used = new Set(map.map((m) => m.target));
  const free = SYNTH_TARGET_IDS.filter((t) => !used.has(t));
  return (
    <Section title="Image Synth" right={<button className="btn small" title="Restore the default mappings" onClick={() => { st.checkpoint(); setMap(defaultSynthMap()); }}>Defaults</button>}>
      <Seg label="Instruments" value={s.synth} onChange={(v: 'image' | 'presets') => set({ synth: v } as Partial<T>, true)} options={[
        { value: 'image', label: 'Image Synth', title: 'Each layer’s patch is derived from its image region and evolves along the scan' },
        { value: 'presets', label: 'Presets', title: 'Fixed instrument presets (no image-derived timbre)' },
      ]} />
      {s.synth === 'image' ? (
        <>
          <p className="note">Wavetables are read from the region (luminance rows → harmonics; edge rows → bright partials). Each row below maps an image feature to a parameter: the region’s average sets the patch, and with Evolution the same feature moves it along the scan.</p>
          <table className="grid synthmap"><tbody>
            {map.map((m, i) => (
              <tr key={`${m.target}_${i}`}>
                <td className="tgt" title={SYNTH_TARGETS[m.target].kind === 'note' ? 'Read at each note onset' : SYNTH_TARGETS[m.target].kind === 'gen' ? 'Shapes where events are placed' : 'Continuous automation'}>{SYNTH_TARGETS[m.target].label}</td>
                <td><Select ariaLabel={`${SYNTH_TARGETS[m.target].label} source`} value={m.source} options={feat} onChange={(v: FeatureKey) => setMap(map.map((x, j) => (j === i ? { ...x, source: v } : x)))} /></td>
                <td style={{ width: 58 }}><input type="range" aria-label={`${SYNTH_TARGETS[m.target].label} amount`} min={-1} max={1} step={0.05} value={m.amount}
                  onPointerDown={st.checkpoint} onChange={(e) => setMap(map.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)), false)} onPointerUp={() => setMap(map)} onKeyUp={() => setMap(map)} title={`amount ${m.amount.toFixed(2)}`} /></td>
                <td style={{ width: 22 }}><button className="btn small icon" aria-label={`Remove ${SYNTH_TARGETS[m.target].label} mapping`} onClick={() => setMap(map.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            ))}
          </tbody></table>
          {!!free.length && <Select label="Add mapping" value={'' as SynthTarget} options={[{ value: '' as SynthTarget, label: '—' }, ...free.map((t) => ({ value: t, label: SYNTH_TARGETS[t].label }))]} onChange={(v: SynthTarget) => { if (v) setMap([...map, { target: v, source: 'brightness', amount: 0.5 }]); }} />}
        </>
      ) : <p className="note">Layers use the fixed instrument presets; image features still decide the notes.</p>}
    </Section>
  );
}
