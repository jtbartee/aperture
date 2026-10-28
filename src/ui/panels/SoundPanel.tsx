import { engine, selectedTrack, useStore } from '../../state/store';
import type { DrumVoice, EffectSlot, Engine, FxType, LfoDest, SynthPatch, Track, Wave } from '../../core/types';
import { Section, Seg, Select, Slider } from '../components/controls';
import { FX_DEFS, FX_TYPES, defaultParams } from '../../audio/fx';
import { uid } from '../../core/ids';
import { ITrash } from '../components/icons';
import { defaultImageParams } from '../../audio/imageSynth';

const WAVES: { value: Wave; label: string }[] = [{ value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Tri' }, { value: 'sawtooth', label: 'Saw' }, { value: 'square', label: 'Sqr' }];
const ENGINES: { value: Engine; label: string }[] = [
  { value: 'sub', label: 'Subtractive' }, { value: 'fm', label: 'FM' }, { value: 'modal', label: 'Modal / additive' },
  { value: 'noise', label: 'Noise' }, { value: 'glitch', label: 'Glitch' }, { value: 'drums', label: 'Drum kit' }, { value: 'image', label: 'Image Synth' },
];
const PRESET_KEY = 'aperture:userPresets';
export function userPresets(): SynthPatch[] {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) ?? '[]'); } catch { return []; }
}
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0));
const sec = (v: number) => (v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`);

export function SoundPanel() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const t = selectedTrack({ project, ui }) as Track | undefined;
  const st = useStore.getState();
  if (!t) return null;
  const p = t.patch;
  const set = (patch: Partial<SynthPatch>) => st.setPatch(t.id, { ...p, ...patch }, false);
  const nest = <K extends keyof SynthPatch>(k: K, v: Partial<SynthPatch[K]>) => set({ [k]: { ...(p[k] as object), ...v } } as Partial<SynthPatch>);
  const S = (label: string, value: number, min: number, max: number, on: (v: number) => void, o: { step?: number; fmt?: (v: number) => string; def?: number; title?: string } = {}) =>
    <Slider label={label} value={value} min={min} max={max} step={o.step ?? (max - min) / 200} def={o.def} fmt={o.fmt} title={o.title} onStart={st.checkpoint} onChange={on} />;
  const audition = () => {
    if (p.engine === 'drums') [36, 42, 38, 42].forEach((m, i) => setTimeout(() => void engine.preview(t.id, m, 0.8, 0.2), i * 180));
    else [0, 4, 7].forEach((iv, i) => setTimeout(() => void engine.preview(t.id, Math.round((t.pitch.low + t.pitch.high) / 2) - 5 + iv, 0.7, 0.9), i * 60));
  };
  return (
    <>
      <Section title={`Sound · ${p.name}`} right={<button className="btn small" onClick={audition}>Audition</button>}>
        <Select label="Engine" value={p.engine} options={ENGINES} onChange={(v) => { st.checkpoint(); set({ engine: v }); }} />
        <div className="btnrow">
          <button className="btn small" onClick={() => {
            const name = prompt('Save this sound as a user preset named:', `${p.name} (mine)`);
            if (!name) return;
            const list = userPresets().filter((x) => x.name !== name);
            try { localStorage.setItem(PRESET_KEY, JSON.stringify([...list, { ...p, name }])); st.setPatch(t.id, { ...p, name }); st.toast(`Saved preset “${name}”`, 'ok'); } catch { st.toast('Could not save the preset (storage unavailable).', 'error'); }
          }}>Save as preset…</button>
        </div>
      </Section>
      {(p.engine === 'sub' || p.engine === 'fm') && (
        <Section title="Oscillators">
          <Seg label="Osc 1" value={p.osc1.wave} options={WAVES} onChange={(v) => { st.checkpoint(); nest('osc1', { wave: v }); }} />
          {S('Osc 1 level', p.osc1.level, 0, 1, (v) => nest('osc1', { level: v }))}
          {S('Osc 1 detune', p.osc1.detune, -50, 50, (v) => nest('osc1', { detune: v }), { step: 1, fmt: (v) => `${v.toFixed(0)}¢`, def: 0 })}
          {p.engine === 'sub' && (
            <>
              <Seg label="Osc 2" value={p.osc2.wave} options={WAVES} onChange={(v) => { st.checkpoint(); nest('osc2', { wave: v }); }} />
              {S('Osc 2 level', p.osc2.level, 0, 1, (v) => nest('osc2', { level: v }), { title: 'Oscillator mix: osc 2 against osc 1' })}
              {S('Osc 2 semis', p.osc2.semi, -24, 24, (v) => nest('osc2', { semi: v }), { step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v}`, def: 0 })}
              {S('Osc 2 detune', p.osc2.detune, -50, 50, (v) => nest('osc2', { detune: v }), { step: 1, fmt: (v) => `${v.toFixed(0)}¢` })}
              {S('Sub osc', p.sub, 0, 1, (v) => set({ sub: v }))}
              {S('Noise', p.noise, 0, 0.5, (v) => set({ noise: v }))}
            </>
          )}
          {S('Unison voices', p.unison, 1, 6, (v) => set({ unison: v }), { step: 1, fmt: (v) => String(v) })}
          {S('Unison spread', p.spread, 0, 40, (v) => set({ spread: v }), { step: 1, fmt: (v) => `${v.toFixed(0)}¢` })}
        </Section>
      )}
      {p.engine === 'fm' && (
        <Section title="FM">
          {S('Ratio', p.fm.ratio, 0.25, 12, (v) => nest('fm', { ratio: v }), { step: 0.01, title: 'Modulator : carrier frequency ratio (non-integers give bell-like inharmonics)' })}
          {S('Index', p.fm.index, 0, 15, (v) => nest('fm', { index: v }), { step: 0.05 })}
          {S('Mod decay', p.fm.modDecay, 0.02, 6, (v) => nest('fm', { modDecay: v }), { fmt: sec })}
          {S('Mod sustain', p.fm.modSustain, 0, 1, (v) => nest('fm', { modSustain: v }))}
        </Section>
      )}
      {p.engine === 'image' && (() => {
        const ip = p.image ?? defaultImageParams();
        const setI = (patch: Partial<typeof ip>) => set({ image: { ...ip, ...patch } });
        const lanes = new Set(t.automation.map((a) => a.target));
        const live = (k: string) => (lanes.has(k as never) ? ' · moved by the image' : '');
        const bars = (amps: number[], color: string) => {
          const max = Math.max(...amps, 1e-6);
          return <div className="harm" aria-hidden="true">{amps.map((a, k) => <span key={k} style={{ height: `${Math.max(1, (a / max) * 100)}%`, background: color }} />)}</div>;
        };
        return (
          <Section title="Image Synth">
            <p className="note">Two wavetables read from this layer’s image region: A from its luminance rows (bottom row = fundamental), B from its edge rows. Values here are the resting patch; image lanes move them while notes sound.</p>
            <div className="row"><span className="lbl">Table A</span>{bars(ip.wavesA, '#e0a458')}</div>
            <div className="row"><span className="lbl">Table B</span>{bars(ip.wavesB, '#6fb7d6')}</div>
            {S(`Morph A→B${live('morph')}`, ip.morph, 0, 1, (v) => setI({ morph: v }))}
            {S(`Detune${live('detune')}`, ip.detune, 0, 40, (v) => setI({ detune: v }), { step: 0.5, fmt: (v) => `${v.toFixed(1)}¢` })}
            {S('FM ratio', ip.fmRatio, 0.5, 5, (v) => setI({ fmRatio: v }), { step: 0.5 })}
            {S(`FM depth${live('fmDepth')}`, ip.fmDepth, 0, 3, (v) => setI({ fmDepth: v }), { step: 0.01 })}
            {S(`Noise${live('noise')}`, ip.noise, 0, 0.4, (v) => setI({ noise: v }))}
            {S(`LFO rate${live('lfoRate')}`, ip.lfoRate, 0.03, 8, (v) => setI({ lfoRate: v }), { fmt: (v) => `${v.toFixed(2)} Hz` })}
            {S(`LFO → filter${live('lfoDepth')}`, ip.lfoDepth, 0, 1, (v) => setI({ lfoDepth: v }))}
            {S(`Tremolo${live('tremolo')}`, ip.tremolo, 0, 1, (v) => setI({ tremolo: v }))}
          </Section>
        );
      })()}
      {p.engine === 'modal' && (
        <Section title="Modal partials">
          <div className="row"><label htmlFor="ratios">Ratios</label><input id="ratios" className="txt" defaultValue={p.modal.ratios.join(', ')} key={p.name + p.modal.ratios.join()} onBlur={(e) => { const r = e.target.value.split(/[,\s]+/).map(Number).filter((x) => x > 0 && x < 40); if (r.length) { st.checkpoint(); nest('modal', { ratios: r, decays: r.map((_, i) => p.modal.decays[i] ?? 1 / (i + 1)) }); } }} /></div>
          {S('Strike noise', p.modal.strike, 0, 1, (v) => nest('modal', { strike: v }))}
          <p className="note">Partial frequencies as multiples of the note. 1, 2.76, 5.4, 8.93 ≈ a struck bar; 1, 2, 3, 4 ≈ organ.</p>
        </Section>
      )}
      {p.engine === 'drums' ? (
        <Section title="Drum voices">
          {(['kick', 'snare', 'chh', 'ohh', 'click', 'noise', 'metal'] as DrumVoice[]).map((v) => (
            <div key={v}>
              <h3 className="h">{({ kick: 'Kick', snare: 'Snare', chh: 'Closed hat', ohh: 'Open hat', click: 'Click', noise: 'Noise burst', metal: 'Metal' })[v]}</h3>
              {S('Tone', p.drums[v].tone, 0, 1, (x) => set({ drums: { ...p.drums, [v]: { ...p.drums[v], tone: x } } }))}
              {S('Decay', p.drums[v].decay, 0, 1, (x) => set({ drums: { ...p.drums, [v]: { ...p.drums[v], decay: x } } }))}
              {S('Level', p.drums[v].level, 0, 1, (x) => set({ drums: { ...p.drums, [v]: { ...p.drums[v], level: x } } }))}
            </div>
          ))}
        </Section>
      ) : (
        <>
          <Section title="Filter">
            <Seg value={p.filter.type} onChange={(v) => { st.checkpoint(); nest('filter', { type: v }); }} options={[{ value: 'lowpass', label: 'LP' }, { value: 'highpass', label: 'HP' }, { value: 'bandpass', label: 'BP' }, { value: 'notch', label: 'Notch' }]} label="Type" />
            {S('Cutoff', p.filter.cutoff, 40, 16000, (v) => nest('filter', { cutoff: v }), { step: 1, fmt: hz })}
            {S('Resonance', p.filter.res, 0.1, 18, (v) => nest('filter', { res: v }), { step: 0.1 })}
            {S('Env amount', p.filter.envAmt, 0, 6, (v) => nest('filter', { envAmt: v }), { step: 0.05, fmt: (v) => `${v.toFixed(1)} oct` })}
            {S('Key tracking', p.filter.keyTrack, 0, 1, (v) => nest('filter', { keyTrack: v }))}
            <h3 className="h">Filter envelope</h3>
            {S('Attack', p.fenv.a, 0.001, 6, (v) => nest('fenv', { a: v }), { fmt: sec })}
            {S('Decay', p.fenv.d, 0.01, 8, (v) => nest('fenv', { d: v }), { fmt: sec })}
            {S('Sustain', p.fenv.s, 0, 1, (v) => nest('fenv', { s: v }))}
            {S('Release', p.fenv.r, 0.01, 8, (v) => nest('fenv', { r: v }), { fmt: sec })}
          </Section>
          <Section title="Amplitude">
            {S('Attack', p.amp.a, 0.001, 8, (v) => nest('amp', { a: v }), { fmt: sec })}
            {S('Decay', p.amp.d, 0.01, 8, (v) => nest('amp', { d: v }), { fmt: sec })}
            {S('Sustain', p.amp.s, 0, 1, (v) => nest('amp', { s: v }))}
            {S('Release', p.amp.r, 0.01, 10, (v) => nest('amp', { r: v }), { fmt: sec })}
            {S('Velocity resp.', p.velSens, 0, 1, (v) => set({ velSens: v }))}
            {S('Level', p.gain, -24, 6, (v) => set({ gain: v }), { step: 0.5, fmt: (v) => `${v.toFixed(1)} dB`, def: 0 })}
            {S('Polyphony', p.poly, 1, 16, (v) => set({ poly: v }), { step: 1, fmt: (v) => String(v) })}
            {S('Glide', p.glide, 0, 0.5, (v) => set({ glide: v }), { fmt: sec, title: 'Portamento (mono patches, polyphony 1)' })}
          </Section>
          <Section title="Modulation">
            <Select label="LFO target" value={p.lfo.dest} options={(['none', 'pitch', 'filter', 'amp', 'pan'] as LfoDest[]).map((d) => ({ value: d, label: d }))} onChange={(v) => { st.checkpoint(); nest('lfo', { dest: v }); }} />
            {S('LFO rate', p.lfo.rate, 0.02, 12, (v) => nest('lfo', { rate: v }), { fmt: (v) => `${v.toFixed(2)} Hz` })}
            {S('LFO depth', p.lfo.depth, 0, 1, (v) => nest('lfo', { depth: v }))}
            {S('Pitch env', p.pitchEnv.amount, -2, 2, (v) => nest('pitchEnv', { amount: v }), { fmt: (v) => `${v.toFixed(2)} oct`, def: 0 })}
            {S('Pitch env time', p.pitchEnv.time, 0.005, 1, (v) => nest('pitchEnv', { time: v }), { fmt: sec })}
          </Section>
        </>
      )}
    </>
  );
}

export function FxPanel() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const t = selectedTrack({ project, ui }) as Track | undefined;
  const st = useStore.getState();
  if (!t) return null;
  const setFx = (fx: EffectSlot[], history = true) => st.setFx(t.id, fx, history);
  const add = (type: FxType) => setFx([...t.fx, { id: uid('fx'), type, on: true, params: defaultParams(type) }]);
  return (
    <>
      <Section title="Sends">
        <Slider label="Reverb send" value={t.mix.reverb} min={0} max={1} onStart={st.checkpoint} onChange={(v) => st.setMix(t.id, { reverb: v }, false)} />
        <Slider label="Delay send" value={t.mix.delay} min={0} max={1} onStart={st.checkpoint} onChange={(v) => st.setMix(t.id, { delay: v }, false)} />
        <p className="note">Shared buses: a 7 s hall and a dotted-eighth tempo-synced echo.</p>
      </Section>
      <Section title="Insert chain" right={
        <select className="sel" aria-label="Add effect" value="" style={{ height: 22, fontSize: 11 }} onChange={(e) => { if (e.target.value) add(e.target.value as FxType); }}>
          <option value="">+ Add effect…</option>
          {FX_TYPES.map((ft) => <option key={ft} value={ft}>{FX_DEFS[ft].label}</option>)}
        </select>
      }>
        {!t.fx.length && <p className="note">No inserts. Try <button className="btn small" onClick={() => add('atmosSweep')}>Atmospheric Sweep</button> for moving ambience behind the dry sound.</p>}
        {t.fx.map((f, i) => (
          <div className="fx" key={f.id}>
            <div className="fx-h">
              <input type="checkbox" aria-label={`Enable ${FX_DEFS[f.type].label}`} checked={f.on} onChange={(e) => setFx(t.fx.map((x) => (x.id === f.id ? { ...x, on: e.target.checked } : x)))} />
              <span className="t">{FX_DEFS[f.type].label}</span>
              <button className="btn small icon" aria-label="Move up" disabled={i === 0} onClick={() => { const a = [...t.fx]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; setFx(a); }}>↑</button>
              <button className="btn small icon" aria-label="Move down" disabled={i === t.fx.length - 1} onClick={() => { const a = [...t.fx]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; setFx(a); }}>↓</button>
              <button className="btn small icon" aria-label="Remove effect" onClick={() => setFx(t.fx.filter((x) => x.id !== f.id))}><ITrash size={13} /></button>
            </div>
            <div className="fx-b">
              {FX_DEFS[f.type].params.map((pd) => (
                <Slider key={pd.key} label={pd.label} value={f.params[pd.key] ?? pd.def} min={pd.min} max={pd.max} step={pd.step} def={pd.def}
                  fmt={(v) => `${pd.step >= 1 ? v.toFixed(0) : v.toFixed(2)}${pd.unit ? ` ${pd.unit}` : ''}`}
                  onStart={st.checkpoint} onChange={(v) => setFx(t.fx.map((x) => (x.id === f.id ? { ...x, params: { ...x.params, [pd.key]: v } } : x)), false)} />
              ))}
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}
