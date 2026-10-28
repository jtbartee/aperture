# APERTURE

**Draw it, photograph it, or scan a panorama — and hear it.**
APERTURE is a visual music composition, image-sonification and generative-synthesis workstation that runs entirely in your browser. No account, no uploads, no paid services.

Live: **https://jtbartee.github.io/aperture/**

The image is the score. Everything you draw, import or generate becomes ordinary, editable note events on layers, and those same events drive live playback, the offline WAV renderer and MIDI export.

## What it does

| Workspace | What happens |
|---|---|
| **Draw** | Horizontal = time, vertical = pitch. Pencil, line, curve, dot, rectangle, ellipse, eraser, select/move/resize/duplicate, zoom, pan, stylus pressure. Six brushes: Note, Legato, Arpeggio, Drone, Rhythm, Modulation (draws automation). |
| **Image** | Import a JPG/PNG/WebP/GIF (first frame). It is analysed locally in a worker. **A Contour** (default) traces the picture's real contours — bends, loops, vertical runs, crossings and branches — and plays each as an independent voice: x is time, height is pitch, edge strength is velocity, curvature is articulation, thickness is timbre, gaps are silence. **B Colour & texture** maps image features you choose to musical parameters; **C Atmospheric** turns regional profiles into chords, drones and slow movement; **Hybrid** adds an evolving Image-Synth atmosphere and optional classic layers. View the original, the extracted contours, or both overlaid. |
| **Panorama** | A very wide image scrolls under a fixed playhead as a continuous score. Ridgelines become independent voices (low ridge → gliding drone, middle → melody, upper → harmonic texture, fine detail → micro-events) over an evolving atmosphere whose timbre follows the scan. Free-time (seconds) or beat-sync (bars); left→right, right→left, ping-pong, a region or a drawn path; a live readout of the scanned features and the timbre they produce. Classic region roles (bands, painted masks, lasso) remain available. |
| **Generative** | Eight style profiles (Ambient, Ambient dub, Krautrock/motorik, IDM/glitch, Minimal, Drone, Cinematic, Abstract/atonal), five structures, twelve shaping controls, seeds, locks (melody, harmony, rhythm, instruments, selected notes), optionally guided by your drawing, image or panorama. A piece is planned before it is written: harmony, then a principal motif (and a contrasting one), then roles and their own rhythmic identities, then development — sequence, fragmentation, inversion, augmentation, gradual substitution, cadences. Metric or free time; percussion optional. |
| **Orbital** | Draw in a circle: angle is time, radius is pitch; the playhead rotates clockwise or counter-clockwise. Several voices can orbit at once, each with its own layer, revolution length and direction; rings are labelled as scale degrees. In *Guided* or *Chord* pitch a voice repeats through the piece and re-reads the chords each turn. |
| **Particles** | Deterministic, seeded physics: particles play notes as they enter the zones you draw. Each zone has a behaviour — scale melody, chord tones, arpeggio, pedal, percussion or the original free mapping — and a repetition amount, and complements what Orbital and the other layers play at that moment. Music never changes the motion. |

### Harmony — one musical context for every workspace
The **Harmony** tab (and the live strip above the stage: key · scale · chord · numeral · its scale degrees · section) is the *Musical Intelligence Engine* (`src/theory/context.ts`): the key, scale, a harmony timeline, sections and a behaviour that the composer, Orbital, Particles, harmony-following brushes and image/panorama interpretation all consult.
- **Behaviour:** *Strict* — every melodic note in the scale, strong beats and phrase endings on chord tones, no chromatic chords. *Expressive* — passing and neighbour tones, appoggiaturas and suspensions that resolve by step, a labelled borrowed dominant in minor, blues backing changes. *Experimental* — chromatic passing notes, chromatic mediants, ♭VI/♭II, clusters — still anchored on the tonic and organised by motif.
- **Progressions:** Auto (the style's, or the scale's natural choice), Functional, Modal vamp, Pedal point, Static/drone, Circular, Slowly evolving, Tension → resolution, Chromatic movement (Experimental only), or **your own chords** — symbols (`Dm7 G7 Cmaj7`, slash chords) or Roman numerals (`i IV i bVII`). Chord length, chord colour (triads, sevenths, ninths, suspended, added tones, quartal), lock, and *Regenerate harmony only* (new chords; themes, rhythms and drawings stay and follow them).
- **Scale-aware harmony:** seven-note scales stack thirds; modes cadence with their own colour chords (D Dorian: G→Dm or C→Dm, never A7); pentatonic, blues, whole-tone, octatonic and custom scales use only chord shapes the scale contains (A minor pentatonic: Am7, C6, D7sus4, E(4ths), Gsus2). Chord names are recognised from the tones that actually sound.
- **Why this note:** the Harmony tab explains the selected layer's sounding notes (“F♯ — third of D major”, “B — 6th degree of D Dorian — its colour tone”).

### Removing, replacing and clearing a picture
Image and Panorama show **Replace…**, **Clear generated notes** and **Remove…** on the stage and in the inspector. Remove asks whether the picture's layers go with it or stay as independent, editable tracks; either way drawings, Orbital and Particle material and every other layer are untouched, the analysis caches are dropped, saved projects keep no reference to the file, and undo brings the picture back (re-analysed from storage). Replace keeps your settings but never attaches old notes or analysis to the new picture. Stored image files are deleted once no saved project or undo step needs them.

### Image sonification
- **No imposed beat.** Image and Panorama do not add a drum kit. Rhythm is one of: **Free time** (events where the picture changes — contour starts, junctions, extrema, colour and light boundaries), **Image texture** (micro-events at the peaks of the image's edge profile: dense regions cluster, smooth regions stay sparse, repeated structures pulse) or **Metric beat** (the conventional sixteenth-grid drum engine, opt-in). Tempo organises the transport and export; it does not impose a meter on free-time material.
- **Four shaping controls**, each with a separate job: *Visual fidelity* (how strictly music stays at its visual position), *Musical structure* (microtonal/unmetered ↔ key, harmony, grid), *Evolution* (static ↔ ever-changing timbre), *Event density* (how many contours speak and how finely). Plus *Literal ↔ Musical* contour shaping, continuous pitch (glide) and scale lock.
- **Image Synth.** Each layer's patch is derived from its image region: two wavetables read from the picture (luminance rows → harmonics, edge rows → bright partials), morph, detune, FM, noise, LFO and tremolo, with filter, resonance, spectral tilt, attack/release, pan, delay feedback and reverb set by a reassignable feature → parameter table. With Evolution the same mappings become lanes that reshape held notes as the scan travels.
- **Contour controls**: edge sensitivity, minimum edge strength, minimum length, detail, smoothing, curvature preservation, separation, branch detection, maximum contours, multi-scale analysis; presets for photography, line art, abstract artwork and panoramic landscapes.
- Every contour note carries the image coordinates it was read from; the views highlight the contours that are sounding and mark each note's source point at the playhead.

Plus: twelve synthesised instruments and a drum kit on five engines (subtractive, FM, modal/additive, noise, glitch) and the image-derived **Image Synth**, with 26 factory presets and a full sound editor; 14 insert effects including the **Atmospheric Sweep**; reverb/delay sends; an image→sound modulation matrix; a mixer with mute/solo/meters; a piano roll; scenes and arrangement printing; Web MIDI input with recording.

### Exports
- **MIDI** — one track per layer, tempo, time signature, swing exactly as heard, drums on channel 10, filter/pan as CC74/CC10. (MIDI carries notes, not APERTURE's sounds.)
- **WAV** — offline render through the same synths and mix: full arrangement or loop region, 44.1/48 kHz, 16/24-bit, configurable tail, progress and cancel.
- **Stems** — one WAV per audible layer, zipped.
- **Project file** (`.aperture`) — a zip of `project.json` plus the original images, so a portable project never loses its score.
- PNG of the current view, SVG of the drawing, image/panorama analysis overlays.

Projects autosave to IndexedDB in your browser. **Clearing site data deletes them**; export a project file for permanent storage.

## Running it

```bash
npm install
npm run dev        # development server
npm run build      # type-check + production build into dist/
npm run preview    # serve the build at http://localhost:4173/aperture/
```

On macOS you can double-click **Launch APERTURE.command** (serves the build on port 8772 and opens it once it is confirmed to be this app).

### Tests
```bash
npm test           # 150 unit tests (musical acceptance A–K, theory, contour fidelity, sonification, drawing, image, panorama, composer, scheduler, MIDI parity, files, audio performance)
npm run build && npm run e2e            # end-to-end checks in headless Chromium
npm run e2e -- draw synth image panorama generative export factory ui audio sonify musical   # any subset
npm run stress                          # high-polyphony audio stress test (Drone / Experimental + photo + MOD routes)
HEADFUL=1 CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" SCALE=2 npm run stress   # + real output underruns
```
`npm run stress` checks that the native effects match their Tone.js originals sample-for-sample, audits offline renders (clipping, isolated clicks, reproducibility), schedules live without late, duplicated or missing notes, leaks no audio nodes across playbacks, switches processing profile and project while playing, and exercises the voice budget. Headless Chrome's fake audio sink never underruns, so dropouts are only measured with `HEADFUL=1` (it opens a window, silences the app's output and reads the browser's `playbackStats`); `SCALE=k` multiplies every layer to find the breaking point.
`npm run e2e -- musical` drives the Harmony tab, Orbital voices and Particle zones through the UI, runs the full remove → undo → keep-music → save/reload → replace → clear → export flow for images and panoramas, and renders ten listening demos (C major C–Am–F–G, D Dorian dub, A minor pentatonic minimal, F minor blues, IDM in E minor Strict and Experimental, free-time ambient, 5/4 and 7/8, Orbital + Particles) to `tests/e2e/out/listening/musical/` with a note-level and audio report (`report.txt`, `report.json`). `DEMOS=A,F npm run e2e -- musical` renders only those.
`npm run e2e -- sonify` renders the musical evaluation through the real audio engine: silence for an empty image, rendered onsets of irregular bars, spectral contrast between photographs, zone-by-zone change across a panorama, and five listening demos (WAV + spectrogram) in `tests/e2e/out/listening/` with measurements in `report.txt`.
The end-to-end suite needs `playwright-core` (a dev dependency) and a Chromium. It looks for the Playwright-cached Chrome for Testing; set `CHROME_PATH` to use another. It verifies audio by **measuring** it — live analyser RMS, offline renders, decoded WAV files, click and clipping audits — not by trusting DOM state.

## Controls and shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| Home | Rewind |
| Esc | Cancel tool / clear selection |
| B (P) · L · C · D · R · O | Pencil · line · curve · dot · rectangle · ellipse |
| E · V · H | Eraser · select · pan |
| ⌘/Ctrl + wheel | Zoom |
| Delete | Delete selection |
| ⌘/Ctrl + D | Duplicate selected strokes |
| ⌘/Ctrl + Z, ⇧⌘Z | Undo, redo |
| ⌘/Ctrl + S | Save |
| N · M | Note overlay · mute selected layer |
| ⌥1 … ⌥6 | Switch workspace |
| Piano roll | click = add · drag = move · drag right edge = resize · Alt-click = delete · L = lock |

Shortcuts are ignored while you type in a field.

## Architecture

```
SOURCE (strokes, images, regions, paths)        src/core/types.ts
  → IMAGE FEATURES (feature grid, contours)       src/analysis/      (pure functions + worker)
  → MUSICAL CONTEXT  key · scale · harmony timeline · behaviour     src/theory/context.ts (+ chords, progression, motif)
  → MUSICAL INTERPRETATION                        src/interpret/     (strokes, image modes, roles, panorama, composer, orbital, particles)
  → EVENT DATA  Track.notes / automation          ← the single source of truth
  → SYNTHESIS  per-note Web Audio voices + Tone.js effects   src/audio/voices.ts, fx.ts, graph.ts
  → TRANSPORT  lookahead scheduler on the audio clock        src/audio/engine.ts, schedule.ts
  → EXPORT     MIDI / offline WAV / project zip              src/export/, src/audio/offline.ts
PERSISTENCE  IndexedDB                                      src/persist/db.ts
PRESENTATION React + Canvas 2D                              src/ui/
```

Key decisions:
- **One event model.** Live playback, offline rendering and MIDI export all read the same `NoteEvent[]` through `eventsInWindow()`; swing is a single continuous time-warp applied identically everywhere. The MIDI parity test checks this tick-for-tick.
- **Voices are built per note from native Web Audio nodes**, so every synth parameter is real, works the same in an `OfflineAudioContext`, and nothing can stick: every source gets an explicit stop time. The live context wraps a *native* `AudioContext`; modulation effects, delays and reverbs are native too (`src/audio/nativeFx.ts`, verified sample-for-sample against the Tone.js effects they replace); Tone.js supplies gains, panners, compressors, meters and the offline context.
- **Realtime cost is budgeted** (`src/audio/quality.ts`): slow modulation (LFO sweeps, lane automation, slow envelopes) runs once per 128-sample block where the step is provably inaudible, reverb impulses stop at −90 dB, a cost-weighted project-wide voice budget takes release tails before anything else, and the output buffer is sized for playback. Three profiles — Balanced, High quality, Performance — live in the **Performance** tab with the monitor; they never change notes.
- **Scheduling** is a 25 ms timer looking 120 ms ahead on the audio clock; the cursor only moves forward, so nothing is scheduled twice. Loop wraps and tempo changes append clock segments; the playhead is derived from the audio clock.
- **Image analysis** is tiled: the full-resolution bitmap is cut into tiles, each downscaled and sent to a worker, which builds a compact feature grid (per cell: light, colour, contrast, gradient energy and an edge-magnitude histogram; per column: edge profile and periodicity) and traces contours. Musical regeneration, scale/sound changes and panorama regions only read that cache; a contour-setting change re-runs just the contour stage.
- **Contours are geometry, not buckets** (`src/analysis/contours.ts`): multi-scale Canny with a noise-relative and an absolute threshold → near-parallel edges merged into centrelines → Zhang–Suen skeleton → a pixel graph of endpoints, junction clusters and segments → spur pruning → chains joined by good continuation through junctions (so crossing lines stay separate) → gap bridging → curvature-aware smoothing → Douglas–Peucker that keeps corners. Paths are x-split only at sonification time, so loops and lines that double back play as simultaneous lines.
- **Sustained voices are modulated live.** Image Synth voices sum their static patch values with per-channel constant-source buses; automation lanes drive the buses, so a 10-minute drone changes timbre without retriggering, identically in live playback and offline render.
- **Remapping without destruction.** Spatially derived notes keep their normalised vertical position (`pitchY`), generated notes keep their scale degree, so changing key, scale or range re-pitches them while drawings and images stay untouched.
- **One harmony.** The project's harmony timeline (`project.harmony`) is persisted and shared. The last full generation writes it (composer, image or panorama — or the Harmony tab), unless it is locked; Orbital, Particles and harmony-following brushes re-read it whenever it, the key or the length changes. Pure project-level plumbing lives in `src/state/music.ts`.
- **Determinism.** Every generator draws from seeded RNG streams forked per layer/section/phrase: the same inputs and seed reproduce identical events.
- The offline renderer schedules notes in chunks at `OfflineAudioContext.suspend()` checkpoints — bounded memory for long renders, real progress, and cancellation.

## Troubleshooting

- **No sound** — click anywhere first (browsers require a gesture before audio). Check that the layer isn't muted and that another layer isn't soloed. A MOD route to *Level* at depth ≥ 0.5 silences a layer wherever its image feature is near zero.
- **Crackles or dropouts in a dense project** — open the **Performance** tab while it plays. *Underruns* (Chrome 156+) means the audio thread missed its deadline: switch to the *Performance* profile, or remove an Atmospheric Sweep/Reverb insert you don't need (each convolution reverb is the most expensive thing in the mix). *Late notes* means the page was busy for more than 120 ms. Hard limiting is reported separately.
- **A huge panorama won't import** — the browser could not decode it, or it exceeds the 150 MP safety limit. Export it as a JPG under ~20 000 px wide.
- **Projects disappeared** — browser storage was cleared. Keep `.aperture` project files for anything you care about.
- **MIDI keyboard not detected** — Web MIDI needs Chrome or Edge; press the record button to request access. Everything else works without MIDI.

## Dependencies and licences

| Package | Use | Licence |
|---|---|---|
| React 19 | UI | MIT |
| Tone.js 15 | effects, offline context | MIT |
| @tonejs/midi 2 | MIDI read/write | MIT |
| zustand 5 | state | MIT |
| fflate 0.8 | zip (project files, stems) | MIT |
| Vite 8, TypeScript 5.9, Vitest 5, playwright-core | build & test | MIT / Apache-2.0 |

All sounds are synthesised; all demo images are generated procedurally in code. The drawing-to-music interaction was inspired by [playmusictheory.net/play](https://playmusictheory.net/play); no code, design or assets were copied.

APERTURE is released under the MIT licence (see `LICENSE`).
