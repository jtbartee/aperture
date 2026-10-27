// APERTURE data model. Layers, from source to sound:
//   SOURCE (strokes, image assets, regions, paths)  → IMAGE FEATURES (analysis/*)
//   → MUSICAL INTERPRETATION (interpret/*)          → EVENT DATA (Track.notes / automation)
//   → SYNTHESIS (audio/*) ← TRANSPORT (audio/scheduler) → EXPORT (export/*)
// Event data is the single source of truth for live playback, offline render and MIDI.

/** Musical time is measured in quarter-note beats from the start of the project. */
export type Beats = number;

export type TimeSigId = '4/4' | '3/4' | '6/8' | '5/4' | '7/8' | '9/8';

export type ScaleId =
  | 'major' | 'minor' | 'harmonicMinor' | 'melodicMinor' | 'dorian' | 'phrygian' | 'lydian'
  | 'mixolydian' | 'locrian' | 'majorPent' | 'minorPent' | 'majorBlues' | 'minorBlues'
  | 'wholeTone' | 'chromatic' | 'octatonic' | 'phrygianDominant' | 'custom';

export type PitchMode = 'scale' | 'chromatic' | 'pentatonic' | 'custom' | 'drums';

export interface PitchMapping {
  mode: PitchMode;
  /** lowest and highest MIDI note reachable from the bottom/top of the canvas */
  low: number;
  high: number;
  /** pitch classes (0-11, relative to the key root) for mode 'custom' */
  custom?: number[];
}

export type NoteOrigin = 'drawn' | 'image' | 'panorama' | 'generated' | 'orbital' | 'particle' | 'user' | 'midi';

export interface NoteEvent {
  id: string;
  start: Beats;
  dur: Beats;
  midi: number;
  /** 0..1 */
  vel: number;
  origin: NoteOrigin;
  /** Normalised vertical source position (0 = bottom, 1 = top). Notes carrying it are re-pitched
   *  through the track's pitch mapping whenever key, scale or range change. */
  pitchY?: number;
  /** Scale steps added after pitchY mapping (chord tones, arpeggio offsets). */
  stepOffset?: number;
  /** Scale degree relative to the tonic at the track's base octave, for theory-generated notes. */
  degree?: number;
  strokeId?: string;
  locked?: boolean;
}

export type ModTarget =
  | 'cutoff' | 'volume' | 'pan' | 'reverbSend' | 'delaySend'
  | 'drive' | 'delayFeedback' | 'tremoloRate' | 'chorusDepth' | 'crush' | 'sweepDepth';

export interface AutomationPoint { beat: Beats; value: number }

export interface AutomationLane {
  id: string;
  target: ModTarget;
  /** normalised 0..1 values, piecewise linear between points */
  points: AutomationPoint[];
  origin: 'drawn' | 'modmatrix' | 'generated' | 'image' | 'panorama';
}

// ---------------------------------------------------------------- synthesis

export type Engine = 'sub' | 'fm' | 'modal' | 'noise' | 'glitch' | 'drums';
export type Wave = 'sine' | 'triangle' | 'sawtooth' | 'square';
export type FilterType = 'lowpass' | 'highpass' | 'bandpass' | 'notch';
export type LfoDest = 'none' | 'pitch' | 'filter' | 'amp' | 'pan';

export interface Adsr { a: number; d: number; s: number; r: number }

export interface DrumVoiceParams { tone: number; decay: number; level: number }
export type DrumVoice = 'kick' | 'snare' | 'chh' | 'ohh' | 'click' | 'noise' | 'metal';

export interface SynthPatch {
  name: string;
  engine: Engine;
  osc1: { wave: Wave; detune: number; level: number };
  osc2: { wave: Wave; semi: number; detune: number; level: number };
  sub: number;
  noise: number;
  unison: number;
  spread: number;
  fm: { ratio: number; index: number; modDecay: number; modSustain: number };
  modal: { ratios: number[]; decays: number[]; strike: number };
  filter: { type: FilterType; cutoff: number; res: number; envAmt: number; keyTrack: number };
  amp: Adsr;
  fenv: Adsr;
  lfo: { rate: number; depth: number; dest: LfoDest };
  pitchEnv: { amount: number; time: number };
  glide: number;
  velSens: number;
  poly: number;
  /** dB trim */
  gain: number;
  drums: Record<DrumVoice, DrumVoiceParams>;
}

export type FxType =
  | 'delay' | 'pingpong' | 'reverb' | 'chorus' | 'phaser' | 'tremolo' | 'autopan' | 'filter'
  | 'distortion' | 'bitcrusher' | 'width' | 'compressor' | 'limiter' | 'atmosSweep';

export interface EffectSlot {
  id: string;
  type: FxType;
  on: boolean;
  params: Record<string, number>;
}

// ---------------------------------------------------------------- tracks

export type TrackSource =
  | 'drawn' | 'imageContour' | 'imageColor' | 'imageTexture' | 'imageAtmos' | 'panorama'
  | 'genMelody' | 'genChords' | 'genBass' | 'genPerc' | 'genTexture' | 'orbital' | 'particle'
  | 'automation' | 'midi';

export type Role = 'melody' | 'bass' | 'pad' | 'drone' | 'arp' | 'percussion' | 'texture' | 'chords';

export interface RhythmSpec {
  /** steps per beat (4 = sixteenths, 3 = eighth triplets…) */
  subdiv: number;
  /** pattern length in steps; independent per track so layers phase against each other */
  length: number;
  pulses: number;
  rotation: number;
  /** 0..1 chance a step that the pattern selects actually fires (resolved at generation) */
  probability: number;
  ratchet: number;
  humanize: number;
}

export interface Mix {
  volume: number; // dB
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  reverb: number; // send 0..1
  delay: number; // send 0..1
}

export interface Track {
  id: string;
  name: string;
  color: string;
  source: TrackSource;
  role: Role;
  patch: SynthPatch;
  notes: NoteEvent[];
  automation: AutomationLane[];
  pitch: PitchMapping;
  mix: Mix;
  fx: EffectSlot[];
  rhythm: RhythmSpec;
  seed: number;
  variation: number;
  /** generator key that (re)creates this track's notes — lets a single layer be regenerated */
  generator?: string;
}

// ---------------------------------------------------------------- sources

export type BrushKind = 'note' | 'legato' | 'arpeggio' | 'drone' | 'rhythm' | 'modulation';
export type ShapeKind = 'freehand' | 'line' | 'curve' | 'dot' | 'rect' | 'ellipse';
export type Articulation = 'normal' | 'staccato' | 'accent' | 'tenuto';

export interface BrushSettings {
  kind: BrushKind;
  size: number; // 1..8 (rows covered / weight)
  density: number; // steps per beat
  duration: number; // in steps
  velocity: number; // 0..1
  quantize: boolean;
  probability: number; // 0..1
  legato: number; // gate 0.1..1.5
  octave: number; // -2..2
  snap: boolean; // scale-lock the pitch rows
  articulation: Articulation;
  arpPattern: 'up' | 'down' | 'updown' | 'random';
  modTarget: ModTarget;
}

export interface Stroke {
  id: string;
  trackId: string;
  shape: ShapeKind;
  brush: BrushSettings;
  /** x in beats, y normalised 0 (bottom) .. 1 (top) */
  points: { x: Beats; y: number }[];
  seed: number;
}

export interface ImageAssetRef {
  assetId: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

export type ImageMode = 'contour' | 'color' | 'atmos' | 'hybrid';
export type FeatureKey = 'brightness' | 'saturation' | 'hue' | 'contrast' | 'edges' | 'texture' | 'variation' | 'centroid' | 'none';

export interface ImageSettings {
  mode: ImageMode;
  bars: number;
  // contour
  edgeSensitivity: number; // 0..1
  minContour: number; // pixels
  detail: number; // 0..1 (bucket fineness)
  density: number; // 0..1
  smoothing: number; // 0..1
  grouping: number; // 0..1
  // color & texture mapping: musical parameter → image feature
  mapping: Record<'pitch' | 'velocity' | 'density' | 'richness' | 'accent' | 'duration', FeatureKey>;
  /** hue sector (6 × 60°) → index into the colour tracks */
  hueRoutes: number[];
  hybrid: { contour: boolean; bass: boolean; pads: boolean; percussion: boolean; filter: boolean };
  seed: number;
}

export type ScanDirection = 'ltr' | 'rtl' | 'pingpong' | 'region' | 'path';

export interface Region {
  id: string;
  name: string;
  role: Role;
  /** horizontal band in normalised image coordinates (0 = top of image) */
  band?: { y0: number; y1: number };
  /** painted/lasso mask on the feature grid (rows × cols as a bitstring of 0/1, run-length free) */
  mask?: { cols: number; rows: number; bits: string };
  trackId: string;
  enabled: boolean;
}

export interface PanoramaSettings {
  timing: 'free' | 'beat';
  seconds: number;
  bars: number;
  direction: ScanDirection;
  region: { x0: number; x1: number };
  path: { x: number; y: number }[];
  scanResolution: number; // columns sampled across the image
  stripWidth: number; // 0..1 fraction of a column neighbourhood
  sensitivity: number;
  density: number;
  smoothing: number;
  polyphony: number;
  threshold: number;
  quantize: number; // steps per beat, 0 = off
  seed: number;
  /** scan length (beats) the current events were generated for — the display stays locked to it */
  genBeats?: number;
}

export interface ImageSource { asset: ImageAssetRef; settings: ImageSettings }
export interface PanoramaSource { asset: ImageAssetRef; settings: PanoramaSettings; regions: Region[] }

// ---------------------------------------------------------------- generative

export type StyleId = 'ambient' | 'ambientDub' | 'motorik' | 'idm' | 'minimal' | 'drone' | 'cinematic' | 'atonal';
export type StructureId = 'arc' | 'aba' | 'continuous' | 'mutation' | 'contrast';
export type GenSource = 'none' | 'drawing' | 'image' | 'panorama';

export interface CompositionSettings {
  style: StyleId;
  structure: StructureId;
  source: GenSource;
  bars: number;
  seed: number;
  complexity: number;
  variation: number;
  density: number;
  repetition: number;
  probability: number;
  tension: number;
  irregularity: number;
  range: number;
  register: number;
  mutation: number;
  evolution: number;
  locks: { melody: boolean; harmony: boolean; rhythm: boolean; instruments: boolean; selected: boolean };
  /** ABSTRACT/ATONAL only: ignore the project scale and use chromatic pitch sets */
  bypassScale: boolean;
}

// ---------------------------------------------------------------- other sequencers

export interface OrbitalSource {
  bars: number;
  direction: 'cw' | 'ccw';
  trackId: string;
  /** strokes with x = angle fraction (0..1 from 12 o'clock), y = radius (0 centre .. 1 rim) */
  strokes: Stroke[];
}

export interface ParticleZone { id: string; x: number; y: number; w: number; h: number; trackId: string }
export interface ParticleSource {
  count: number;
  speed: number;
  gravity: number;
  bars: number;
  seed: number;
  quantize: number;
  zones: ParticleZone[];
}

export interface ModRoute {
  id: string;
  source: FeatureKey;
  trackId: string;
  target: ModTarget;
  amount: number; // -1..1
  smoothing: number; // 0..1
  from: 'image' | 'panorama';
}

export interface Scene {
  id: string;
  name: string;
  bars: number;
  tracks: Track[];
}

export interface ArrangementEntry { sceneId: string; repeats: number }

export interface ProjectSettings {
  bpm: number;
  timeSig: TimeSigId;
  key: number; // 0 = C
  scale: ScaleId;
  customScale: number[];
  swing: number; // 0..1
  swingGrid: 8 | 16;
  quantize: number; // steps per beat for editing (4 = 1/16, 3 = 1/8 triplet…)
  lengthBars: number;
  loop: { on: boolean; start: Beats; end: Beats };
  metronome: boolean;
  /** when an in-playback regeneration takes effect */
  switchAt: 'now' | 'beat' | 'bar' | 'phrase';
  tail: number;
}

export type Workspace = 'draw' | 'image' | 'panorama' | 'generative' | 'orbital' | 'particles';

export interface Marker { beat: Beats; label: string }

export interface Project {
  format: 'aperture-project';
  version: 1;
  id: string;
  name: string;
  created: number;
  modified: number;
  settings: ProjectSettings;
  tracks: Track[];
  strokes: Stroke[];
  image?: ImageSource;
  panorama?: PanoramaSource;
  composition: CompositionSettings;
  orbital: OrbitalSource;
  particles: ParticleSource;
  modRoutes: ModRoute[];
  scenes: Scene[];
  arrangement: ArrangementEntry[];
  markers: Marker[];
  workspace: Workspace;
}
