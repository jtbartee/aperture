import { engine, selectedTrack, useStore } from '../../state/store';
import type { Articulation, FeatureKey, ImageMode, ModTarget, OrbitalPitch, OrbitalVoice, Region, Role, ScanDirection, StructureId, StyleId, GenSource, Track, ZoneBehavior } from '../../core/types';
import { Check, Num, Progress, Section, Seg, Select, Slider } from '../components/controls';
import { STRUCTURES, STYLES, STYLE_IDS } from '../../interpret/composer';
import { COLOR_VOICES } from '../../interpret/imageModes';
import { displayBeats, panoramaBeats, panoramaSeconds } from '../../interpret/panorama';
import { FEATURE_KEYS, MOD_TARGETS } from '../../interpret/modmatrix';
import { barBeats } from '../../core/time';
import { getAnalysis } from '../../analysis/client';
import { IDice } from '../components/icons';
import { uid } from '../../core/ids';
import { rng, hash32 } from '../../core/rng';
import { SUBDIVISIONS } from '../../theory/rhythm';
import { ContourControls, ShapeControls, SynthControls } from './SonifyPanels';
import { SourceActions } from '../SourceActions';
import { ZONE_BEHAVIORS } from '../../interpret/particles';
import { defaultOrbitalVoice } from '../../interpret/orbital';
import { PROGRESSION_TYPES } from '../../theory/progression';
import { styleProgression } from '../../interpret/composer';

const ROLES: Role[] = ['pad', 'melody', 'bass', 'drone', 'percussion', 'texture', 'arp', 'chords'];
const feat = FEATURE_KEYS.map((f) => ({ value: f.id, label: f.label }));

function Locks() {
  const c = useStore((s) => s.project.composition);
  const hLock = useStore((s) => s.project.harmony.lock);
  const st = useStore.getState();
  const L = (k: keyof typeof c.locks, label: string, title: string) => <Check label={label} title={title} checked={c.locks[k]} onChange={(v) => st.setComposition({ locks: { ...c.locks, [k]: v } })} />;
  return (
    <div className="row2" style={{ margin: '6px 0' }}>
      {L('melody', 'Lock melody', 'Keep the generated melody when regenerating')}
      <Check label="Lock harmony" title="Keep the shared chord progression (Harmony tab) — every generator then follows it" checked={hLock} onChange={(v) => st.setHarmony({ lock: v })} />
      {L('rhythm', 'Lock rhythm', 'Keep onset times; take new pitches')}
      {L('instruments', 'Lock instruments', 'Keep each layer\'s sound when regenerating')}
      {L('selected', 'Lock selected notes', 'Notes you locked survive regeneration')}
    </div>
  );
}

function SwitchAt() {
  const s = useStore((x) => x.project.settings);
  const pending = useStore((x) => x.ui.pendingRegen);
  const st = useStore.getState();
  return (
    <>
      <Seg label="While playing" value={s.switchAt} onChange={(v) => st.setSettings({ switchAt: v })}
        options={[{ value: 'now', label: 'Now' }, { value: 'beat', label: 'Beat' }, { value: 'bar', label: 'Bar' }, { value: 'phrase', label: 'Phrase' }]} />
      {pending && <p className="note warn">Pending: {pending}…</p>}
    </>
  );
}

export function BrushPanel() {
  const ui = useStore((s) => s.ui);
  const project = useStore((s) => s.project);
  const st = useStore.getState();
  const b = ui.brush;
  const setB = (patch: Partial<typeof b>) => st.setUi({ brush: { ...b, ...patch } });
  const sel = project.strokes.filter((s) => ui.selStrokes.includes(s.id));
  return (
    <>
      <Section title={`Brush · ${b.kind}`}>
        <Slider label="Size" value={b.size} min={1} max={8} step={1} def={2} onChange={(v) => setB({ size: v })} fmt={(v) => String(v)} title="Thicker strokes play louder and, with the note brush, add cluster tones" />
        <Select label="Density" value={b.density} options={SUBDIVISIONS.map((d) => ({ value: d.steps, label: `${d.label} steps` }))} onChange={(v) => setB({ density: v })} />
        <Slider label="Duration" value={b.duration} min={0.25} max={8} step={0.25} def={1} onChange={(v) => setB({ duration: v })} fmt={(v) => `${v} st`} />
        <Slider label="Velocity" value={b.velocity} min={0.05} max={1} def={0.75} onChange={(v) => setB({ velocity: v })} />
        <Slider label="Probability" value={b.probability} min={0} max={1} def={1} onChange={(v) => setB({ probability: v })} title="Chance each note is kept (frozen per stroke, so playback and export agree)" />
        <Slider label="Legato" value={b.legato} min={0.1} max={1.5} def={0.9} onChange={(v) => setB({ legato: v })} />
        <Slider label="Octave" value={b.octave} min={-2} max={2} step={1} def={0} onChange={(v) => setB({ octave: v })} fmt={(v) => (v > 0 ? `+${v}` : String(v))} />
        <Seg label="Articulation" value={b.articulation} onChange={(v: Articulation) => setB({ articulation: v })} options={[{ value: 'normal', label: 'Norm' }, { value: 'staccato', label: 'Stacc' }, { value: 'accent', label: 'Acc' }, { value: 'tenuto', label: 'Ten' }]} />
        {b.kind === 'arpeggio' && <Seg label="Arp pattern" value={b.arpPattern} onChange={(v) => setB({ arpPattern: v })} options={[{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }, { value: 'updown', label: 'Up-dn' }, { value: 'random', label: 'Rand' }]} />}
        {b.kind === 'modulation' && <Select label="Modulates" value={b.modTarget} options={MOD_TARGETS.map((m) => ({ value: m.id, label: m.label }))} onChange={(v: ModTarget) => setB({ modTarget: v })} />}
        {b.kind !== 'modulation' && b.kind !== 'rhythm' && <Seg label="Harmony" value={b.harmony ?? 'scale'} onChange={(v: 'scale' | 'guided' | 'chord') => setB({ harmony: v })} options={[{ value: 'scale', label: 'Scale', title: 'Height → scale rows (the drawing decides every pitch)' }, { value: 'guided', label: 'Guided', title: 'Strong beats and long notes move to the nearest chord tone of the shared harmony' }, { value: 'chord', label: 'Chord', title: 'Every note becomes the nearest chord tone' }]} />}
        <div className="row2">
          <Check label="Quantize" checked={b.quantize} onChange={(v) => setB({ quantize: v })} />
          <Check label="Snap to scale" checked={b.snap} onChange={(v) => setB({ snap: v })} title="Off = chromatic rows (those notes then keep their exact pitch when the key changes)" />
        </div>
        <div className="btnrow">
          <button className="btn small" disabled={!sel.length} onClick={() => st.replaceStrokes(sel.map((s) => ({ ...s, brush: { ...b } })))}>Apply to {sel.length || 'selected'} stroke{sel.length === 1 ? '' : 's'}</button>
        </div>
      </Section>
      <Section title="Brush guide">
        <p className="note"><b>Note</b> — a note on each grid step; <b>Legato</b> — flat stretches sustain, slopes become phrases; <b>Arpeggio</b> — each beat arpeggiates the rows it covers; <b>Drone</b> — holds the shape's pitches for its width; <b>Rhythm</b> — short accented hits, scribble vertically to ratchet; <b>Modulation</b> — draws automation (shown dashed).</p>
      </Section>
    </>
  );
}

export function ImagePanel() {
  const project = useStore((s) => s.project);
  const job = useStore((s) => s.ui.analysis.image);
  const st = useStore.getState();
  const img = project.image;
  if (!img) return <Section title="Image"><p className="note">Import an image (toolbar → Import, or drop a file) to analyse it.</p></Section>;
  const s = img.settings;
  const set = (patch: Partial<typeof s>, regen = true) => st.setImageSettings(patch, regen);
  const layers = project.tracks.filter((t) => t.generator?.startsWith('image:'));
  const a = getAnalysis(img.asset.assetId);
  const analysed = !!a;
  return (
    <>
      <Section title={`Image · ${img.asset.name}`}>
        <p className="note">{img.asset.width}×{img.asset.height} px · {(img.asset.bytes / 1e6).toFixed(1)} MB</p>
        <div className="btnrow"><SourceActions kind="image" /></div>
      </Section>
      <Section title="Interpretation">
        <Seg value={s.mode} onChange={(v: ImageMode) => set({ mode: v })} options={[{ value: 'contour', label: 'A Contour', title: 'Traced contours become independent voices' }, { value: 'color', label: 'B Colour', title: 'Colour, light and texture drive notes and instruments' }, { value: 'atmos', label: 'C Atmos', title: 'Large-scale structure becomes pads, drones and slow movement' }, { value: 'hybrid', label: 'Hybrid', title: 'Contour voices plus an evolving atmosphere and optional classic layers' }]} />
        <p className="note">{({ contour: 'Each traced contour is a voice: x = time, height = pitch, edge strength = velocity, curvature = articulation, thickness = timbre. Loops and paths that double back become simultaneous lines; gaps are silence. The most salient contours are voices A–C, the rest form a field.', color: 'Per time-step colour statistics. Each musical parameter reads the image feature you assign below; hue sectors route notes to colour voices you choose. Outside metric rhythm, notes only start where the image changes.', atmos: 'Regional profiles set chords (hue → degree, saturation → colour), drone register (brightness), onset density (edges), reverb and filter movement.', hybrid: 'Contour voices + an evolving image-synth atmosphere + the rhythm layer; low-structure bass and colour pads can be added below.' } as const)[s.mode]}</p>
        <Slider label="Length" value={s.bars} min={2} max={64} step={1} onStart={st.checkpoint} onChange={(v) => set({ bars: v }, false)} onCommit={() => st.generateImage()} fmt={(v) => `${v} bars`} />
        <Slider label="Feature smoothing" title="Smoothing of the colour / light / texture curves" value={s.smoothing} min={0} max={1} onStart={st.checkpoint} onChange={(v) => set({ smoothing: v }, false)} onCommit={() => st.generateImage()} />
        <div className="btnrow">
          <button className="btn primary small" disabled={!analysed} onClick={() => st.generateImage()}>Generate</button>
          <button className="btn small" disabled={!analysed} onClick={() => { set({ seed: (s.seed % 9999) + 1 }, true); }} title="New seed: same image, a different but related reading"><IDice size={13} /> Regenerate</button>
          <button className="btn small" onClick={() => void st.analyze('image')} title="Re-run the full pixel analysis">Re-analyse</button>
        </div>
        {job.status === 'running' && <><p className="note">{job.label}</p><Progress value={job.progress} /></>}
        {job.status === 'error' && <p className="note err">{job.error}</p>}
        <SwitchAt />
        <Locks />
      </Section>
      <ShapeControls s={s} set={set} />
      <ContourControls c={s.contour} stats={a?.contours} set={(patch, regen) => set({ contour: { ...useStore.getState().project.image!.settings.contour, ...patch } }, regen)} />
      <SynthControls s={s} set={set} />
      {s.mode === 'color' && (
        <Section title="Feature → music mapping">
          <table className="grid"><tbody>
            {(Object.keys(s.mapping) as (keyof typeof s.mapping)[]).map((k) => (
              <tr key={k}><td style={{ width: 90 }}>{k}</td><td><Select ariaLabel={`${k} source`} value={s.mapping[k]} options={[...feat, { value: 'none' as FeatureKey, label: '— fixed —' }]} onChange={(v: FeatureKey) => set({ mapping: { ...s.mapping, [k]: v } })} /></td></tr>
            ))}
          </tbody></table>
          <h3 className="h">Hue sector → voice</h3>
          <table className="grid"><tbody>
            {['Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta'].map((h, i) => (
              <tr key={h}><td style={{ width: 90 }}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: `hsl(${i * 60},70%,55%)`, marginRight: 6 }} />{h}</td>
                <td><Select ariaLabel={`${h} voice`} value={s.hueRoutes[i]} options={COLOR_VOICES.map((v, j) => ({ value: j, label: `${v.name.replace('Colour voice ', '')} · ${v.patch}` }))} onChange={(v) => { const r = [...s.hueRoutes]; r[i] = v; set({ hueRoutes: r }); }} /></td></tr>
            ))}
          </tbody></table>
          <p className="note">No colour stereotypes are built in — route any hue to any voice, and change each voice's instrument in the Track tab.</p>
        </Section>
      )}
      {(s.mode === 'hybrid' || s.mode === 'contour') && (
        <Section title={s.mode === 'hybrid' ? 'Hybrid layers' : 'Layers'}>
          <div className="row2">
            {(s.mode === 'hybrid' ? (['contour', 'atmosphere', 'percussion', 'bass', 'pads', 'filter'] as const) : (['percussion'] as const)).map((k) => <Check key={k} label={{ contour: 'Contours → voices', atmosphere: 'Evolving atmosphere', bass: 'Structure → bass (classic)', pads: 'Colour → pads (classic)', percussion: `Rhythm layer (${({ free: 'visual events', texture: 'image texture', metric: 'drum kit' } as const)[s.rhythm]})`, filter: 'Brightness → filter' }[k]} checked={s.hybrid[k]} onChange={(v) => set({ hybrid: { ...s.hybrid, [k]: v } })} />)}
          </div>
        </Section>
      )}
      <Section title="Image layers">
        {!layers.length && <p className="note">No layers yet.</p>}
        {layers.map((t) => <LayerRow key={t.id} t={t} />)}
      </Section>
    </>
  );
}

function LayerRow({ t }: { t: Track }) {
  const st = useStore.getState();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '3px 0' }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: t.color }} />
      <button className="btn small" style={{ flex: 1, justifyContent: 'flex-start', overflow: 'hidden' }} onClick={() => st.setUi({ selectedTrackId: t.id })} title={t.patch.name}>{t.name} <span style={{ color: 'var(--text-3)' }}>({t.notes.length})</span></button>
      <button className="btn small icon" title="Regenerate only this layer (new seed)" aria-label={`Regenerate ${t.name}`} onClick={() => st.regenerateTrack(t.id, true)}><IDice size={13} /></button>
    </div>
  );
}

export function PanoramaPanel() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const st = useStore.getState();
  const pano = project.panorama;
  if (!pano) return <Section title="Panorama"><p className="note">Import a wide image in the Panorama workspace.</p></Section>;
  const s = pano.settings;
  const set = (patch: Partial<typeof s>) => st.setPanoramaSettings(patch);
  const secs = panoramaSeconds(s, project.settings);
  const beats = panoramaBeats(s, project.settings);
  const bars = beats / barBeats(project.settings.timeSig);
  const stale = s.genBeats !== undefined && Math.abs(s.genBeats - beats) > 0.01;
  const layers = project.tracks.filter((t) => t.generator?.startsWith('pano:'));
  const setRegion = (id: string, patch: Partial<Region>) => st.setRegions(pano.regions.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const fmtT = (x: number) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
  return (
    <>
      <Section title={`Panorama · ${pano.asset.name}`}>
        <p className="note">{pano.asset.width}×{pano.asset.height} px · {(pano.asset.bytes / 1e6).toFixed(1)} MB</p>
        <div className="btnrow"><SourceActions kind="panorama" /></div>
      </Section>
      <Section title="Scan timing">
        <Seg label="Timing" value={s.timing} onChange={(v) => set({ timing: v })} options={[{ value: 'free', label: 'Free time', title: 'Completes the scan in a fixed number of seconds' }, { value: 'beat', label: 'Beat sync', title: 'Maps the whole image to a number of bars' }]} />
        {s.timing === 'free' ? (
          <>
            <div className="btnrow">
              {[30, 60, 120, 240, 300, 600].map((x) => <button key={x} className={`btn small ${Math.abs(s.seconds - x) < 0.5 ? 'on' : ''}`} onClick={() => set({ seconds: x })}>{x < 60 ? `${x}s` : `${x / 60}m`}</button>)}
            </div>
            <div className="row"><span className="lbl">Custom</span><Num label="seconds" value={s.seconds} min={5} max={3600} onChange={(v) => set({ seconds: v })} width={70} /></div>
          </>
        ) : (
          <Slider label="Bars" value={s.bars} min={4} max={256} step={1} onChange={(v) => set({ bars: v })} fmt={(v) => `${v}`} onStart={st.checkpoint} />
        )}
        <p className="note">= {fmtT(secs)} at {project.settings.bpm} BPM = {bars.toFixed(1)} bars of {project.settings.timeSig}. {s.timing === 'free' ? 'Changing the tempo keeps the duration and changes the bar count.' : 'Changing the tempo changes the duration.'}</p>
        {stale && <p className="note warn">The current notes were generated for {(s.genBeats! / barBeats(project.settings.timeSig)).toFixed(1)} bars; the display stays locked to them. <button className="btn small" onClick={() => st.generatePanorama()}>Re-fit to {fmtT(secs)}</button></p>}
        <Select label="Direction" value={s.direction} onChange={(v: ScanDirection) => set({ direction: v })} options={[{ value: 'ltr', label: 'Left → right' }, { value: 'rtl', label: 'Right → left' }, { value: 'pingpong', label: 'Ping-pong' }, { value: 'region', label: 'Selected region' }, { value: 'path', label: 'Custom path' }]} />
        {s.direction === 'region' && (
          <>
            <Slider label="Region start" value={s.region.x0} min={0} max={s.region.x1 - 0.02} onChange={(v) => set({ region: { ...s.region, x0: v } })} onStart={st.checkpoint} />
            <Slider label="Region end" value={s.region.x1} min={s.region.x0 + 0.02} max={1} onChange={(v) => set({ region: { ...s.region, x1: v } })} onStart={st.checkpoint} />
          </>
        )}
        {s.direction === 'path' && <p className="note">{s.path.length > 1 ? `${s.path.length}-point path. ` : 'No path yet. '}Use the <b>path</b> tool on the image to draw one. {s.path.length > 1 && <button className="btn small" onClick={() => set({ path: [] })}>Clear path</button>}</p>}
        <Seg label="Speed" value={0} onChange={(m: number) => { if (m) st.setSettings({ bpm: Math.max(30, Math.min(300, Math.round(project.settings.bpm * m))) }); }} options={[{ value: 0.5, label: '×½' }, { value: 0.8, label: '×0.8' }, { value: 1.25, label: '×1.25' }, { value: 2, label: '×2' }]} />
      </Section>
      <Section title="Sonification layers">
        <div className="row2">
          {(['contours', 'atmosphere', 'events', 'regions'] as const).map((k) => <Check key={k} label={{ contours: 'Contour voices (ridges → drone, melody, texture)', atmosphere: 'Evolving atmosphere', events: `Rhythm layer (${({ free: 'visual events', texture: 'image texture', metric: 'drum kit' } as const)[s.rhythm]})`, regions: 'Region roles (classic)' }[k]} checked={s.layers[k]} onChange={(v) => st.setPanoramaSettings({ layers: { ...s.layers, [k]: v } }, true)} />)}
        </div>
        <Check label="Live feature readout" checked={s.readout} onChange={(v) => set({ readout: v })} />
      </Section>
      <ShapeControls s={s} set={(patch, regen) => st.setPanoramaSettings(patch, regen)} />
      <ContourControls c={s.contour} stats={getAnalysis(pano.asset.assetId)?.contours} set={(patch, regen) => st.setPanoramaSettings({ contour: { ...useStore.getState().project.panorama!.settings.contour, ...patch } }, regen)} />
      <SynthControls s={s} set={(patch, regen) => st.setPanoramaSettings(patch, regen)} />
      <Section title="Analysis → events">
        <Slider label="Scan resolution" value={s.scanResolution} min={16} max={1024} step={16} onStart={st.checkpoint} onChange={(v) => set({ scanResolution: v })} fmt={(v) => `${v}`} title="How many strips are sampled across the image — more = more musical detail" />
        <Slider label="Strip width" value={s.stripWidth} min={0} max={3} onStart={st.checkpoint} onChange={(v) => set({ stripWidth: v })} />
        <Slider label="Feature sensitivity" title="Edge density measured along the scan (feature curves, region roles)" value={s.sensitivity} min={0} max={1} onStart={st.checkpoint} onChange={(v) => set({ sensitivity: v })} />
        <Slider label="Note threshold" value={s.threshold} min={0} max={1} onStart={st.checkpoint} onChange={(v) => set({ threshold: v })} />
        <Slider label="Smoothing" value={s.smoothing} min={0} max={1} onStart={st.checkpoint} onChange={(v) => set({ smoothing: v })} />
        <Slider label="Polyphony" value={s.polyphony} min={2} max={6} step={1} onStart={st.checkpoint} onChange={(v) => set({ polyphony: v })} fmt={(v) => String(v)} />
        {s.rhythm === 'metric' && <Select label="Quantize (region roles)" value={s.quantize} onChange={(v) => set({ quantize: v })} options={[{ value: 0, label: 'Off' }, ...SUBDIVISIONS.map((d) => ({ value: d.steps, label: d.label }))]} />}
        <div className="btnrow">
          <button className="btn primary small" onClick={() => st.generatePanorama()}>Generate</button>
          <button className="btn small" onClick={() => { set({ seed: (s.seed % 9999) + 1 }); st.generatePanorama(); }}><IDice size={13} /> Regenerate</button>
          <button className="btn small" onClick={() => void st.analyze('panorama')}>Re-analyse</button>
        </div>
        <p className="note">Changes to these settings, regions or the key only re-read the cached feature grid — the image is not reprocessed.</p>
        <SwitchAt />
        <Locks />
      </Section>
      {s.layers.regions && <Section title="Regions → roles" right={<button className="btn small" onClick={() => st.setRegions([...pano.regions, { id: uid('reg'), name: `Region ${pano.regions.length + 1}`, role: 'texture', band: { y0: 0.4, y1: 0.6 }, trackId: '', enabled: true }])}>+ Region</button>}>
        <p className="note">Regions are image coordinates — bands or painted/lasso masks — never guessed objects. Choose “paint” for a region, then use the paint, erase or lasso tool on the image.</p>
        {pano.regions.map((r) => (
          <div key={r.id} className="fx">
            <div className="fx-h">
              <input type="checkbox" aria-label={`Enable ${r.name}`} checked={r.enabled} onChange={(e) => setRegion(r.id, { enabled: e.target.checked })} />
              <input className="txt" aria-label="Region name" style={{ flex: 1, height: 22 }} value={r.name} onChange={(e) => setRegion(r.id, { name: e.target.value })} />
              <label className="check" title="Target of the paint / erase / lasso tools"><input type="radio" name="paintreg" checked={ui.paintRegionId === r.id} onChange={() => st.setUi({ paintRegionId: r.id, panoTool: ui.panoTool === 'scrub' || ui.panoTool === 'path' ? 'paint' : ui.panoTool })} />paint</label>
            </div>
            <div className="fx-b">
              <Select label="Role" value={r.role} options={ROLES.map((x) => ({ value: x, label: x }))} onChange={(v) => setRegion(r.id, { role: v })} />
              {r.band && !r.mask && (
                <>
                  <Slider label="Top" value={r.band.y0} min={0} max={r.band.y1 - 0.02} onStart={st.checkpoint} onChange={(v) => st.setRegions(pano.regions.map((x) => (x.id === r.id ? { ...x, band: { ...x.band!, y0: v } } : x)), false)} />
                  <Slider label="Bottom" value={r.band.y1} min={r.band.y0 + 0.02} max={1} onStart={st.checkpoint} onChange={(v) => st.setRegions(pano.regions.map((x) => (x.id === r.id ? { ...x, band: { ...x.band!, y1: v } } : x)), false)} />
                </>
              )}
              {r.mask && <p className="note">Painted mask ({r.mask.bits.split('').filter((x) => x === '1').length} cells). <button className="btn small" onClick={() => setRegion(r.id, { mask: undefined, band: { y0: 0.3, y1: 0.7 } })}>Back to band</button></p>}
              <div className="btnrow">
                <button className="btn small" onClick={() => st.generatePanorama(`pano:${r.id}`)}>Regenerate layer</button>
                <button className="btn small danger" onClick={() => st.setRegions(pano.regions.filter((x) => x.id !== r.id))}>Remove</button>
              </div>
            </div>
          </div>
        ))}
      </Section>}
      <Section title="Panorama layers">
        {layers.map((t) => <LayerRow key={t.id} t={t} />)}
        {!layers.length && <p className="note">Generate to create one layer per enabled region.</p>}
        <p className="note">Display length {(displayBeats(s, project.settings) / barBeats(project.settings.timeSig)).toFixed(1)} bars.</p>
      </Section>
    </>
  );
}

export function GenerativePanel() {
  const project = useStore((s) => s.project);
  const st = useStore.getState();
  const c = project.composition;
  const set = (patch: Partial<typeof c>) => st.setComposition(patch);
  const P = (k: keyof typeof c, label: string, title: string) => (
    <Slider label={label} title={title} value={c[k] as number} min={0} max={1} onStart={st.checkpoint} onChange={(v) => st.commit((p) => ({ ...p, composition: { ...p.composition, [k]: v } }), false)} />
  );
  const layers = project.tracks.filter((t) => t.generator?.startsWith('gen:'));
  return (
    <>
      <Section title="Style">
        <Select label="Profile" value={c.style} options={STYLE_IDS.map((id) => ({ value: id, label: STYLES[id].label }))} onChange={(v: StyleId) => set({ style: v })} />
        <p className="note">{STYLES[c.style].description} Suggested tempo {STYLES[c.style].tempo}.</p>
        <Select label="Structure" value={c.structure} options={STRUCTURES.map((x) => ({ value: x.id, label: x.label }))} onChange={(v: StructureId) => set({ structure: v })} />
        <Select label="Guided by" value={c.source} options={[{ value: 'none', label: 'Seed only' }, { value: 'drawing', label: 'Drawing' }, { value: 'image', label: 'Image' }, { value: 'panorama', label: 'Panorama' }]} onChange={(v: GenSource) => set({ source: v })} />
        <Slider label="Length" value={c.bars} min={4} max={256} step={1} onStart={st.checkpoint} onChange={(v) => st.commit((p) => ({ ...p, composition: { ...p.composition, bars: v } }), false)} fmt={(v) => `${v} bars`} />
        <div className="row"><span className="lbl">Seed</span><span style={{ display: 'flex', gap: 6 }}><Num label="" value={c.seed} min={1} max={999999} onChange={(v) => set({ seed: v })} width={80} /><button className="btn small" title="Random seed" onClick={() => set({ seed: 1 + Math.floor(Math.random() * 99999) })}><IDice size={13} /></button></span></div>
        {c.style === 'atonal' && <Check label="Bypass the scale (chromatic pitch sets)" checked={c.bypassScale} onChange={(v) => set({ bypassScale: v })} />}
        <Seg label="Time" value={c.time} onChange={(v: 'metric' | 'free') => set({ time: v })} options={[{ value: 'metric', label: 'Metric', title: 'Bars, beats and rhythmic patterns' }, { value: 'free', label: 'Free time', title: 'No grid and no pulse: phrases breathe; no drums' }]} />
        <Check label="Percussion layer" title="Off = no drums in any style" checked={c.percussion && c.time !== 'free'} onChange={(v) => set({ percussion: v })} />
        <p className="note">Harmony: {project.harmony.progression === 'auto' ? `${PROGRESSION_TYPES.find((x) => x.id === styleProgression(c.style, project.harmony, c))?.label} (style)` : PROGRESSION_TYPES.find((x) => x.id === project.harmony.progression)?.label} · {project.harmony.behavior}{project.harmony.lock ? ' · locked' : ''} — <button className="linkish" onClick={() => st.setUi({ inspectorTab: 'harmony' })}>Harmony tab</button></p>
        <div className="btnrow">
          <button className="btn primary" onClick={() => st.generateComposition(undefined, true)} title="Generate and adopt the style's tempo">Generate</button>
          <button className="btn" onClick={() => st.generateComposition(undefined, false)} title="Generate keeping the current tempo">Generate (keep tempo)</button>
          <button className="btn" onClick={() => { set({ seed: c.seed + 1 }); st.generateComposition(); }}><IDice size={13} /> Variation</button>
        </div>
        <SwitchAt />
        <Locks />
      </Section>
      <Section title="Shape">
        {P('complexity', 'Complexity', 'Layers, chord size, melodic behaviour')}
        {P('density', 'Density', 'Onsets per bar and section intensity')}
        {P('variation', 'Variation', 'How often phrases are freshly written instead of recalled')}
        {P('repetition', 'Repetition', 'Chance a phrase repeats a remembered one')}
        {P('mutation', 'Mutation', 'How much repeated phrases are altered')}
        {P('evolution', 'Evolution', 'How fast mutation and timbre drift over the piece')}
        {P('probability', 'Probability', 'Trigger probability for non-accented notes')}
        {P('tension', 'Harmonic tension', 'Dominants, sevenths, chromatic colour')}
        {P('irregularity', 'Irregularity', 'Odd pattern lengths, syncopation, displaced subdivisions')}
        {P('range', 'Melodic range', 'Span of the melody')}
        {P('register', 'Register', 'Overall pitch height of melodic layers')}
      </Section>
      <Section title="Generated layers">
        {layers.map((t) => <LayerRow key={t.id} t={t} />)}
        {!layers.length && <p className="note">Nothing generated yet.</p>}
      </Section>
      <GenModulation />
    </>
  );
}

/** Advanced generative modulation: a seeded random-walk or LFO automation lane on the selected layer. */
function GenModulation() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const t = selectedTrack({ project, ui }) as Track | undefined;
  const st = useStore.getState();
  if (!t) return null;
  const make = (target: ModTarget, shape: 'walk' | 'sine', periodBars: number) => {
    const beats = project.settings.lengthBars * barBeats(project.settings.timeSig);
    const r = rng(hash32(`${t.id}:${target}:${shape}:${t.seed}`));
    const pts: { beat: number; value: number }[] = [];
    let v = 0.5;
    for (let b = 0; b <= beats; b += 0.5) {
      if (shape === 'sine') v = 0.5 + 0.4 * Math.sin((b / (periodBars * barBeats(project.settings.timeSig))) * Math.PI * 2);
      else v = Math.max(0.05, Math.min(0.95, v + (r() - 0.5) * 0.08));
      pts.push({ beat: b, value: v });
    }
    st.updateTrack(t.id, (x) => ({ ...x, automation: [...x.automation.filter((a) => !(a.target === target && a.origin === 'generated')), { id: uid('lane'), target, points: pts, origin: 'generated' }] }));
  };
  return (
    <Section title={`Generative modulation · ${t.name}`}>
      <div className="btnrow">
        <button className="btn small" onClick={() => make('cutoff', 'walk', 0)}>Drifting filter</button>
        <button className="btn small" onClick={() => make('pan', 'sine', 8)}>Slow auto-pan (8 bars)</button>
        <button className="btn small" onClick={() => make('reverbSend', 'walk', 0)}>Wandering reverb</button>
        <button className="btn small" onClick={() => make('volume', 'sine', 16)}>Swell (16 bars)</button>
      </div>
      <div className="btnrow"><button className="btn small danger" onClick={() => st.updateTrack(t.id, (x) => ({ ...x, automation: x.automation.filter((a) => a.origin !== 'generated') }))}>Clear generated lanes</button></div>
    </Section>
  );
}

const ORBITAL_PITCH: { value: OrbitalPitch; label: string; title: string }[] = [
  { value: 'scale', label: 'Scale', title: 'Radius → scale rows; the figure never changes (the original mapping)' },
  { value: 'guided', label: 'Guided', title: 'Strong beats and long notes move to the nearest chord tone when the chords change' },
  { value: 'chord', label: 'Chord', title: 'Every note is the chord tone nearest its radius' },
  { value: 'chromatic', label: 'Chromatic', title: 'Radius → semitones, ignoring key' },
];

export function OrbitalPanel() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const st = useStore.getState();
  const o = project.orbital;
  const v = o.voices.find((x) => x.id === o.active) ?? o.voices[0];
  const setO = (fn: (voices: OrbitalVoice[]) => OrbitalVoice[], active?: string) => { st.commit((p) => ({ ...p, orbital: { voices: fn(p.orbital.voices), active: active ?? p.orbital.active } })); st.regenerateOrbital(); };
  const setV = (patch: Partial<OrbitalVoice>) => v && setO((vs) => vs.map((x) => (x.id === v.id ? { ...x, ...patch } : x)));
  const addVoice = () => {
    const id = uid('orb');
    const used = new Set(o.voices.map((x) => x.trackId));
    const track = project.tracks.find((t) => t.id === ui.selectedTrackId && !used.has(t.id)) ?? project.tracks.find((t) => !used.has(t.id) && t.pitch.mode !== 'drums') ?? project.tracks[0];
    setO((vs) => [...vs, { ...defaultOrbitalVoice(track?.id ?? '', id), bars: v ? v.bars : 4 }], id);
  };
  const name = (x: OrbitalVoice) => project.tracks.find((t) => t.id === x.trackId)?.name ?? '?';
  return (
    <Section title="Orbital voices" right={<button className="btn small" onClick={addVoice}>+ Voice</button>}>
      <div className="voice-tabs" role="tablist" aria-label="Orbital voices">
        {o.voices.map((x, i) => (
          <button key={x.id} role="tab" aria-selected={x.id === v?.id} className={`btn small ${x.id === v?.id ? 'on' : ''}`} onClick={() => st.commit((p) => ({ ...p, orbital: { ...p.orbital, active: x.id } }), false)}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: project.tracks.find((t) => t.id === x.trackId)?.color ?? '#888' }} />{i + 1} · {name(x)}
          </button>
        ))}
      </div>
      {!v && <p className="note">No voices. Add one to draw in the circle.</p>}
      {v && (
        <>
          <Select label="Layer" value={v.trackId} options={project.tracks.map((t) => ({ value: t.id, label: t.name }))} onChange={(id) => setV({ trackId: id })} />
          <Slider label="Bars / turn" value={v.bars} min={1} max={16} step={1} onChange={(b) => st.commit((p) => ({ ...p, orbital: { ...p.orbital, voices: p.orbital.voices.map((x) => (x.id === v.id ? { ...x, bars: b } : x)) } }), false)} onCommit={() => st.regenerateOrbital()} onStart={st.checkpoint} fmt={(b) => String(b)} />
          <Seg label="Direction" value={v.direction} onChange={(d) => setV({ direction: d })} options={[{ value: 'cw', label: 'Clockwise' }, { value: 'ccw', label: 'Counter' }]} />
          <Seg label="Pitch" value={v.pitch} onChange={(x: OrbitalPitch) => setV({ pitch: x })} options={ORBITAL_PITCH} />
          {(v.pitch === 'guided' || v.pitch === 'chord') && <Slider label="Adaptation" title="How far a note may move toward the current chord (1–5 semitones)" value={v.adapt} min={0} max={1} def={0.7} onStart={st.checkpoint} onChange={(x) => st.commit((p) => ({ ...p, orbital: { ...p.orbital, voices: p.orbital.voices.map((y) => (y.id === v.id ? { ...y, adapt: x } : y)) } }), false)} onCommit={() => st.regenerateOrbital()} />}
          <Check label="Repeat through the piece (each turn follows the chords)" checked={v.fill} onChange={(x) => setV({ fill: x })} />
          <p className="note">Each voice orbits independently: its own layer, length and direction. Notes are written into the layer, so they play, edit and export like any others. Rings are scale degrees (1 = tonic); the chord’s tones glow.</p>
          <div className="btnrow">
            <button className="btn small" onClick={() => setV({ strokes: [] })}>Clear voice</button>
            <button className="btn small danger" disabled={o.voices.length < 2} onClick={() => setO((vs) => vs.filter((x) => x.id !== v.id), o.voices.find((x) => x.id !== v.id)?.id)}>Remove voice</button>
            <button className="btn small" onClick={() => st.setSettings({ lengthBars: v.bars, loop: { on: true, start: 0, end: v.bars * barBeats(project.settings.timeSig) } })}>Loop one revolution</button>
          </div>
        </>
      )}
    </Section>
  );
}

export function ParticlePanel() {
  const project = useStore((s) => s.project);
  const st = useStore.getState();
  const pc = project.particles;
  const set = (patch: Partial<typeof pc>) => { st.commit((p) => ({ ...p, particles: { ...p.particles, ...patch } })); st.regenerateParticles(); };
  return (
    <Section title="Particle sequencer">
      <Slider label="Particles" value={pc.count} min={1} max={40} step={1} onStart={st.checkpoint} onChange={(v) => set({ count: v })} fmt={(v) => String(v)} />
      <Slider label="Speed" value={pc.speed} min={0} max={1} onStart={st.checkpoint} onChange={(v) => set({ speed: v })} />
      <Slider label="Gravity" value={pc.gravity} min={0} max={1} onStart={st.checkpoint} onChange={(v) => set({ gravity: v })} />
      <Slider label="Length" value={pc.bars} min={1} max={64} step={1} onStart={st.checkpoint} onChange={(v) => set({ bars: v })} fmt={(v) => `${v} bars`} />
      <Select label="Quantize" value={pc.quantize} onChange={(v) => set({ quantize: v })} options={[{ value: 0, label: 'Off' }, ...SUBDIVISIONS.map((d) => ({ value: d.steps, label: d.label }))]} />
      <div className="row"><span className="lbl">Seed</span><span style={{ display: 'flex', gap: 6 }}><Num label="" value={pc.seed} min={1} max={99999} onChange={(v) => set({ seed: v })} width={80} /><button className="btn small" onClick={() => set({ seed: 1 + Math.floor(Math.random() * 9999) })}><IDice size={13} /></button></span></div>
      <p className="note">Drag on the stage to add a zone for the selected layer. The physics is fixed-step and seeded: the same seed always produces the same motion. Each zone reads an entry through its behaviour and the shared harmony, and avoids clashing with what Orbital and other layers play at that moment.</p>
      <div className="btnrow"><button className="btn small" onClick={() => { engine.seek(0); }}>Restart view</button><button className="btn small danger" disabled={!pc.zones.length} onClick={() => set({ zones: [] })}>Clear zones</button></div>
      <h3 className="h">Zones</h3>
      {!pc.zones.length && <p className="note">No zones yet.</p>}
      {pc.zones.map((z, i) => {
        const t = project.tracks.find((x) => x.id === z.trackId);
        const setZ = (patch: Partial<typeof z>) => set({ zones: pc.zones.map((q) => (q.id === z.id ? { ...q, ...patch } : q)) });
        const drums = t?.pitch.mode === 'drums';
        return (
          <div key={z.id} className="fx">
            <div className="zone-row">
              <span style={{ width: 10, height: 10, borderRadius: 2, background: t?.color ?? '#888' }} />
              <span>{i + 1} · {t?.name ?? 'missing layer'}</span>
              <button className="btn small danger" aria-label={`Delete zone ${i + 1}`} onClick={() => set({ zones: pc.zones.filter((q) => q.id !== z.id) })}>✕</button>
            </div>
            <Select label="Behaviour" value={drums ? 'percussion' : z.behavior ?? 'free'} options={ZONE_BEHAVIORS.filter((b) => (drums ? b.id === 'percussion' : b.id !== 'percussion')).map((b) => ({ value: b.id, label: b.label }))} onChange={(v: ZoneBehavior) => setZ({ behavior: v })} title={ZONE_BEHAVIORS.find((b) => b.id === (z.behavior ?? 'free'))?.title} />
            {!drums && z.behavior && z.behavior !== 'free' && z.behavior !== 'arp' && <Slider label="Repetition" title="0 = every entry finds a new note; 1 = the zone replays its remembered cell (fitted to the current chord)" value={z.repeat ?? 0.3} min={0} max={1} def={0.3} onStart={st.checkpoint} onChange={(v) => st.commit((p) => ({ ...p, particles: { ...p.particles, zones: p.particles.zones.map((q) => (q.id === z.id ? { ...q, repeat: v } : q)) } }), false)} onCommit={() => st.regenerateParticles()} />}
          </div>
        );
      })}
    </Section>
  );
}
