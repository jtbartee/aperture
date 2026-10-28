# APERTURE — project status

Last updated: 2026-10-28. Repository: `aperture` (Vite base `/aperture/`).

Legend: ✅ complete and tested · 🟡 implemented, needs more testing · 🚧 in progress · ⬜ not started

## Verification at a glance
- `npm test` — 136 unit tests, all passing (musical acceptance A–K and engine contracts in `musical.test.ts`; Part 19 examples A–J; contour fidelity; sonification results).
- `npm run e2e` — headless-Chromium suite, groups `draw synth image panorama generative export factory ui audio sonify musical`; 99/99 passing on 2026-10-28. Audio is measured (analyser RMS, offline renders, decoded WAVs, clipping and click audits, spectral centroid and onset analysis).
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

## Revision 3 — musical intelligence (2026-10-28, branch `musical-intelligence`)

**Problems found by measurement before changing anything** (D Dorian, 32 bars, seed 7; tools in the commit history):
- IDM ignored the selected scale: 13/15 chords, 69/197 melody, 75/127 chord and 64/188 texture notes outside D Dorian (a `chromatic` progression and a `chromatic` melody behaviour were the style default). Minimal and Drone texture layers picked random chromatic pitches (30/73, 4/9 outside). Ambient's "seventh" colour turned IV into Gmaj7 (F♯).
- Chord labels lied outside seven-note scales: "every other note" stacking on A minor pentatonic produced an "Em7" whose pitch classes were E–A–D–G and whose voicing played B; whole-tone and blues chords were voiced from m7 formulas with 2–3 outside tones each.
- Major/harmonic-minor cadences were imposed on modes: D Dorian "tension" cadenced on A7 (C♯) at every phrase end.
- Harmony was a module variable: not saved, not shared, invisible to Orbital and Particles (which mapped position → scale row only).
- Phrase-memory mutation nudged pitches of bass, chord stabs and pads by scale steps regardless of function; the "probability" control dropped single tones out of sustained chords.
- Orbital played one revolution only; the image atmosphere's "root" was the lowest scale pitch in range (C in A minor), not the tonic.

| Stage | Feature | Status | Evidence |
|---|---|---|---|
| 2 | Musical Intelligence Engine `src/theory/context.ts`: shared context (key, scale, family, behaviour, persisted harmony timeline, sections, colour tones), `choosePitch` (chord/strong-beat/step/colour/avoid weighting), `adaptNotes`, `explain`, roman numerals | ✅ | unit contracts; e2e harmony tab |
| 3 | Honest chords: pitch classes are the truth (`ivs`), names recognised from them; scale-family harmony (stack thirds / catalogue of contained shapes); Strict · Expressive · Experimental; 9 progression approaches incl. typed symbols and Roman numerals; modal cadences; blues changes with flagged outside tones; key/scale retargeting | ✅ | unit: all scales × degrees × sizes honest and in-scale; 12-key transposition; tests B, C, D |
| 4 | Composer plans harmony → theme → roles → development (`src/theory/motif.ts`): sentence/period/cell/call/drone/theme forms, sequence, fragmentation, inversion, augmentation callback, substitution, displacement, additive/subtractive; harmony-aware realisation; final harmonic fit; free time; percussion optional | ✅ | tests A, E, G, H, K; theme recurrence (same metric, before → after): cinematic 0.68→0.91, IDM 0.50→0.76, ambient 0.50→0.64, motorik 0.77→0.82, dub 0.76→0.83, distinct pitch content per unit kept high |
| 5 | Styles differ in grammar: ambient (drone form, silence), dub (call/response, riff bass, echo melody), motorik (cell ostinatos + substitution), IDM (quintuplet/sextuplet grids, displacement, 5/7 cycles), minimal (additive chords), drone (fifths + extension), cinematic (theme + inverted B + augmented callback), atonal (pitch-class set forms, fixed registers, durational series) | ✅ | existing style-distinctness tests + new acceptance tests |
| 6 | Orbital: several voices, Scale/Guided/Chord/Chromatic pitch, adaptation, repeat through the piece, degree-labelled rings, chord-tone glow, per-voice playheads. Particles: zone behaviours (melody, chord, arpeggio, pedal, percussion, free), repetition, complement what else sounds; physics untouched | ✅ | test F: over 3 seeds, 0–1.1 % of particle/orbit overlaps are semitone clashes and 4.7–6.7 % unisons (Strict, all in scale); physics frames identical with/without music; e2e UI |
| 7 | Image/Panorama: shared/locked harmony input, publish their timeline only when audible (else the tonic), atmosphere on the tonic / chord roots, chord-tone lean of phrase endings and strong onsets at structure ≥ 0.75 (bounded by fidelity) | ✅ | all 48 image/panorama/sonify tests unchanged and passing |
| 8 | Remove (with or without its music) / Replace / Clear generated notes for image and panorama; cancels analysis, drops caches, detaches or removes layers, cleans mod routes, leaves no reference in saved projects, undo re-analyses, stored blobs collected when unreferenced | ✅ | test I (pure) + e2e flow incl. reload, undo, export, blob GC |
| 9 | Harmony tab, live strip, "why these notes", lock/regenerate harmony only, brush Harmony option | ✅ | e2e + screenshots `tests/e2e/out/musical-*.png` |
| 10 | Ten rendered listening demos with note-level and audio metrics | ✅ (measured) 🟡 (not heard) | `tests/e2e/out/listening/musical/report.txt` |

**Click audit changed (and tested).** Three demos were flagged by the old isolated-spike detector; the flags sat ~14 ms into Plucked Synth notes, on the band-limited sawtooth resets of its octave-up oscillator while the filter envelope is wide open — periodic waveform edges, not discontinuities. The detector now also requires a spike to be ≥ 4× every other spike 0.7–6 ms away; an e2e self-test proves it still flags an injected discontinuity and passes a clean sine and a bright 880 Hz sawtooth.

**Known limitations (Revision 3)**
- Nobody has listened to the demos yet; they were judged by note data, spectrograms and audio metrics only.
- Legacy projects: the composer was rewritten, so regenerating an old Generative piece gives the new engine (stored notes are untouched until you regenerate). Old Orbital sources become one voice with the original Scale mapping and a single revolution; old particle zones keep the Free mapping.
- Roman numerals with no suffix take the scale's own chord when the numeral's case agrees; otherwise case decides major/minor. Typed letter chords are absolute (they transpose on a key change; they are not re-diatonicised).
- A scale change rebuilds relative chords on the same degrees as plain stacked chords (their sus/add colours are not carried over).
- Orbital notes that move to chord tones keep their radius position (`pitchY`); a key change regenerates them rather than remapping.
- The composer's MIDI keeps chromatic passing tones as plain notes (no pitch bend).

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
12. **One shared harmony, persisted.** `project.harmony.slots` is the timeline every tonal generator reads through `musicalContext()`. The last full generation (composer, image, panorama, Harmony tab) writes it unless `harmony.lock`. After anything that changes it — or the key, scale, meter or length — call `refreshSequencers()` (state/music.ts): harmony-following strokes, then Orbital, then Particles (which listen to the orbit).
13. **A chord's pitch classes are the truth.** Build voicings from `chordIntervals(c)` (the sounding `ivs`), name chords with `chordSymbol`, never from a quality formula alone. Non-heptatonic scales take chords from `shapeWithin` (contained shapes only).
14. **Harmony parts carry function.** Mutation and probability never change the pitch of pads, chords or arpeggios or the bass under a chord arrival; the composer's final `fitToHarmony` enforces Strict/Expressive rules. Never use `Math.random()` in theory or interpret — including for pitch choice (`choosePitch` takes a seeded RNG or is argmax).
15. **Music never steers particle physics**: pitch is chosen after the event; frames are identical with or without a musical context (unit-tested).
16. **Removing a source is one pure operation** (`withoutSource` in state/music.ts) plus cache cleanup in the store; blobs are deleted only by `gcAssets` when no saved project, open project or undo step references them.

## Resuming
- Start with `npm install && npm test && npm run build && npm run e2e`.
- Revision 3 next candidates: human listening review of `tests/e2e/out/listening/musical/*.wav`; a pitch-bend export for chromatic passing tones; carrying chord colours across scale changes; per-voice explanation overlays in the Generative lane view.
- The debug surface `window.__aperture` (store, engine, api, liveRms) is what the e2e suite drives.
- Next candidates: human listening review of `tests/e2e/out/listening/*.wav`; Safari/Firefox pass (PeriodicWave + ConstantSource are standard but untested there); real MIDI keyboard test; e2e for paint/lasso/path tools and overlay exports; sample-rate reduction in the bitcrusher (needs an AudioWorklet registered in both live and offline contexts); listening review of all factory projects by ear.
