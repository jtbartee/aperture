# APERTURE — project status

Last updated: 2026-10-27. Repository: `aperture` (Vite base `/aperture/`).

Legend: ✅ complete and tested · 🟡 implemented, needs more testing · 🚧 in progress · ⬜ not started

## Verification at a glance
- `npm test` — 92 unit tests, all passing (Part 19 examples A–J at engine level; contour fidelity; sonification results).
- `npm run e2e` — headless-Chromium suite, groups `draw synth image panorama generative export factory ui audio sonify`; 71/71 passing on 2026-10-27. Audio is measured (analyser RMS, offline renders, decoded WAVs, clipping and click audits, spectral centroid and onset analysis).
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

## Revision 2 — deep sonification overhaul (2026-10-27, branch `sonification-overhaul`)

| Stage | Feature | Status | Evidence |
|---|---|---|---|
| A | Contour engine: multi-scale Canny, parallel-edge merge, Zhang–Suen skeleton, junction/branch graph, good continuation, gap bridging, corner-protecting simplification, source-normalised ordered paths | ✅ | `contours.test.ts`: 8 drawn curves ≥ 95 % coverage, < 1.5 px RMS, one path each; crossing lines stay separate; fork junction + branch; loop closed; 3 ridges → 3 contours; uniform/haze → 0 |
| A | Photo / Contours / Overlay views, per-contour colours, junctions, branch starts, silent contours dashed, sounding contours bold | ✅ | e2e `sonify` screenshots `view-*.png` |
| A | Ten contour controls + 4 presets; Literal ↔ Musical interpretation | ✅ | unit: detail/maxContours/minLength/separation behave; literal vs musical note counts and durations differ, shape correlation > 0.85 |
| B | No default drum kit; Free time / Image texture / Metric rhythm; free-time percussion for region roles | ✅ | unit + e2e: irregular bars heard at their leading edges (rendered onsets within 2 px), no extra onsets; empty image renders −180 dBFS |
| C | Image Synth engine (two image wavetables, FM, noise, LFO, tremolo) on channel modulation buses; 17-target reassignable mapping; evolution lanes; per-note attack/release/FM ratio | ✅ | unit: different photos → different wavetables/cutoff/FM/attack; evolution 0 = flat lanes; e2e: rendered centroid 284 Hz (haze) vs 1428 Hz (texture), 0 vs 66 onsets |
| D | Panorama contour voices by register, evolving atmosphere, image-timed rhythm layer, source-coordinate notes, live feature + synth readout | ✅ | unit: zone-varying lanes and densities; 3 ridges → low/mid/high voices with different onsets; e2e: rendered centroid per zone 392…946…112 Hz |
| E | Musical evaluation fixtures, five listening WAVs + spectrograms, UI refinement | ✅ (measured) 🟡 (not heard) | `npm run e2e -- sonify` → `tests/e2e/out/listening/` |

**Listening:** the WAV demos were inspected by measurement and spectrogram only — no human listening has taken place. What the spectrograms show: the multi-contour glide demo draws its crossing lines as converging and diverging partial families; the panorama demo changes density and spectrum zone by zone; the haze atmosphere opens gradually as the scan passes the second glow (modest by design — a soft image produces slow movement).

**Problems the evaluation caught and fixed:** a percentile edge threshold that found 1 of 3 ridges; musical mode producing *more* notes than literal; periodic tremolo and long delay feedback re-introducing a pulse in free time (periodicity now needs a confirmed repeat and edge evidence; feedback capped; delay times not tempo-related); sawtooth-like wavetable edges flagged as clicks (Schroeder phases); feature mappings that pinned at their limits (now combined in logit space, temporal movement scaled to each image's own range).

**Known limitations**
- Very acute corners in line art (opening < ~40°) lose ~8 px of their tip when both sides of a drawn line are merged (separation < 0.3); raise *Contour separation* to keep them.
- MIDI export writes each glide at its starting pitch (pitch bends are audio-only; a track is polyphonic, so per-note bends cannot share one MIDI channel).
- Contours are traced at analysis resolution (≤ 560 px for images, ≤ 288 px tall for panoramas); thin features below that are not seen.
- Old projects keep their stored notes; regenerating them keeps the pre-overhaul behaviour (metric percussion, presets, classic layers) — switch Rhythm / Instruments to opt in.

## Architecture decisions to keep
1. **Event data is the single source of truth.** `eventsInWindow()` (src/audio/schedule.ts) feeds the live scheduler and the offline renderer; `projectToMidi()` uses the same swing warp. Don't add a second note path.
2. **Per-note native voices** (src/audio/voices.ts). Every source gets an explicit stop time; kills go through a per-voice gain ramp. Don't switch to pooled Tone instruments without re-running `npm run e2e -- audio`.
3. **Gain staging:** voice peak 0.85 × patch gain; channel fader; master −1 dB → glue compressor → 150 ms-release limiter (Tone.Limiter's 10 ms release crackles on kicks). Pads/drones are programmed 3–4 dB lower because chords stack.
4. **Analysis cache:** `FeatureGrid` keeps per-cell edge histograms so sensitivity changes don't need pixels. Music generation must only read the grid / gestures.
5. **Remap anchors:** notes carry `pitchY` (+`stepOffset`) or `degree`. Anything that generates notes should set one of them.
6. **Panorama display is locked to `genBeats`** (the length the events were generated for). Tempo changes in free-time show a "re-fit" prompt instead of silently desynchronising.
7. **Determinism:** generators take explicit seeded RNGs; never use `Math.random()` in src/interpret or src/theory.
8. **The image decides; the seed only varies below full fidelity.** At Visual fidelity 100 % a new seed must not change contour voices (unit-tested). Seeded freedoms (re-ranking similar contours, octave displacement, harmonisation) scale with 1 − fidelity.
9. **Free time means no pulse from anywhere** — not from drums, metric weights, tempo-synced delays, high feedback or periodic tremolo on aperiodic images. `npm run e2e -- sonify` checks rendered onsets.
10. **Image Synth parameters reach voices through channel buses** (`Channel.bus()` in audio/graph.ts); a voice adds its static value to the bus input. Per-note values (attack, release, FM ratio) are read from lanes at the onset in `AudioGraph.trigger`.
11. **Settings without `rhythm` / `layers` are legacy** and normalise to legacy behaviour (`normalizeImageSettings`, `normalizePanoramaSettings` in state/project.ts).

## Resuming
- Start with `npm install && npm test && npm run build && npm run e2e`.
- The debug surface `window.__aperture` (store, engine, api, liveRms) is what the e2e suite drives.
- Next candidates: human listening review of `tests/e2e/out/listening/*.wav`; Safari/Firefox pass (PeriodicWave + ConstantSource are standard but untested there); real MIDI keyboard test; e2e for paint/lasso/path tools and overlay exports; sample-rate reduction in the bitcrusher (needs an AudioWorklet registered in both live and offline contexts); listening review of all factory projects by ear.
