# APERTURE — project status

Last updated: 2026-10-27. Repository: `spectral-atlas` (Vite base `/spectral-atlas/`).

Legend: ✅ complete and tested · 🟡 implemented, needs more testing · 🚧 in progress · ⬜ not started

## Verification at a glance
- `npm test` — 57 unit tests, all passing (Part 19 examples A–J at engine level).
- `npm run e2e` — headless-Chromium suite, groups `draw synth image panorama generative export factory ui audio`; all passing on 2026-10-27. Audio is measured (analyser RMS, offline renders, decoded WAVs, clipping and click audits).
- Tested in Chrome for Testing (Chromium) only. **Not yet tested in Safari or Firefox, on touch devices, or with real MIDI hardware.**

## Phases

| Phase | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Architecture, data model, toolchain, UI shell | ✅ | builds; typecheck clean |
| 2 | Drawing canvas: pencil/line/curve/dot/rect/ellipse, eraser, select/move/resize/duplicate, zoom/pan | ✅ | e2e `draw`, `ui` |
| 2 | Brushes: note, legato, arpeggio, drone, rhythm, modulation; size, density, duration, velocity, quantize, probability, legato, octave, snap, articulation | ✅ | unit `drawing.test.ts` |
| 2 | Key/scale remapping without touching strokes; 17 scales + custom; scale/pentatonic/chromatic/custom/drum pitch maps | ✅ | unit + e2e |
| 2 | Transport: play/pause/stop/rewind/loop/scrub/tap tempo/metronome; audio-clock scheduling | ✅ | unit `scheduler.test.ts`, e2e |
| 2 | Stylus pressure → stroke velocity | 🟡 | implemented; not tested with a pen |
| 2 | Touch input | 🟡 | pointer events throughout; not tested on a device |
| 3 | Image import (file input, drag-drop), decode safeguards, worker analysis with tiles, cancel | ✅ | e2e `image` |
| 3 | Contour / colour & texture / atmospheric / hybrid modes, reassignable mappings, hue routing | ✅ | unit `image.test.ts`, e2e |
| 3 | Editable image-derived notes (piano roll, alt-click delete), per-layer regeneration | ✅ | e2e `ui` |
| 4 | Panorama: multi-resolution levels, scrolling viewport, fixed playhead, overview strip, free/beat timing, 5 scan directions | ✅ | e2e `panorama` (pixel-level sync r = 0.996) |
| 4 | Regions: bands, painted masks, lasso, roles, per-region regeneration | ✅ (bands) 🟡 (paint/lasso UI) | unit tests on masks; paint/lasso UI exercised manually only |
| 4 | Custom scan path tool | 🟡 | logic unit-tested; drawing tool not covered by e2e |
| 5 | Harmony (17 chord qualities, inversions, voice-leading), 8 progression types | ✅ | unit `theory.test.ts` |
| 5 | Melody (9 behaviours), rhythm (Euclid, polymeter, triplets, ratchets, humanise), time-signature groupings | ✅ | unit |
| 5 | Composer: 8 styles, 5 structures, phrase memory + mutation, evolution lanes, locks, seeds, bar-quantised live regeneration | ✅ | unit `composer.test.ts`, e2e `generative` |
| 6 | 12 instruments + drum kit on 5 engines; 26 presets; sound editor; user presets | ✅ | e2e `synth` (all audible; ≥ 12/13 distinct fingerprints) |
| 6 | 14 insert effects incl. Atmospheric Sweep; sends; image modulation matrix | ✅ (effects) 🟡 (matrix UI) | e2e `ui`; matrix baking unit-tested |
| 7 | MIDI export (parity), WAV mix, stems ZIP, loop-region export, tail, 16/24-bit, 44.1/48 kHz, cancel | ✅ | unit `midi.test.ts`, e2e `export` |
| 7 | Project save/open/rename/duplicate/delete, autosave, session restore, portable `.aperture` files with images | ✅ | e2e `export`, unit `files.test.ts` |
| 7 | Scenes + arrangement printing | ✅ | unit + e2e `ui` |
| 7 | PNG / SVG / analysis overlay export | 🟡 | implemented; not asserted in e2e |
| 8 | Orbital sequencer | ✅ | unit + e2e `ui` |
| 8 | Particle sequencer | ✅ | unit + e2e `ui` |
| 8 | Generative modulation lanes (drift, auto-pan, swell) | 🟡 | implemented; not asserted |
| 9 | Error boundaries, layout reset, shortcuts ignored while typing | ✅ | e2e `ui` |
| 9 | Accessibility: labelled controls, keyboard transport/shortcuts, focus rings, ARIA on canvases | 🟡 | not audited with a screen reader |
| 9 | GitHub Pages workflow | ✅ (local build) | `.github/workflows/deploy.yml`; deploy not yet run |
| — | Web MIDI input (play, scale-lock, record) | 🟡 | implemented; needs hardware testing |
| — | Bitcrusher sample-rate reduction | ⬜ | bit-depth reduction only |
| — | Animated GIF playback | ⬜ | first frame only (documented) |
| — | Semantic object recognition | ⬜ | deliberately not done; all analysis is feature-based |

## Architecture decisions to keep
1. **Event data is the single source of truth.** `eventsInWindow()` (src/audio/schedule.ts) feeds the live scheduler and the offline renderer; `projectToMidi()` uses the same swing warp. Don't add a second note path.
2. **Per-note native voices** (src/audio/voices.ts). Every source gets an explicit stop time; kills go through a per-voice gain ramp. Don't switch to pooled Tone instruments without re-running `npm run e2e -- audio`.
3. **Gain staging:** voice peak 0.85 × patch gain; channel fader; master −1 dB → glue compressor → 150 ms-release limiter (Tone.Limiter's 10 ms release crackles on kicks). Pads/drones are programmed 3–4 dB lower because chords stack.
4. **Analysis cache:** `FeatureGrid` keeps per-cell edge histograms so sensitivity changes don't need pixels. Music generation must only read the grid / gestures.
5. **Remap anchors:** notes carry `pitchY` (+`stepOffset`) or `degree`. Anything that generates notes should set one of them.
6. **Panorama display is locked to `genBeats`** (the length the events were generated for). Tempo changes in free-time show a "re-fit" prompt instead of silently desynchronising.
7. **Determinism:** generators take explicit seeded RNGs; never use `Math.random()` in src/interpret or src/theory.

## Resuming
- Start with `npm install && npm test && npm run build && npm run e2e`.
- The debug surface `window.__aperture` (store, engine, api, liveRms) is what the e2e suite drives.
- Next candidates: Safari/Firefox pass; real MIDI keyboard test; e2e for paint/lasso/path tools and overlay exports; sample-rate reduction in the bitcrusher (needs an AudioWorklet registered in both live and offline contexts); listening review of all factory projects by ear.
