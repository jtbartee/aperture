# APERTURE

**Draw it, photograph it, or scan a panorama — and hear it.**
APERTURE is a visual music composition, image-sonification and generative-synthesis workstation that runs entirely in your browser. No account, no uploads, no paid services.

Live: **https://jtbartee.github.io/spectral-atlas/**

The image is the score. Everything you draw, import or generate becomes ordinary, editable note events on layers, and those same events drive live playback, the offline WAV renderer and MIDI export.

## What it does

| Workspace | What happens |
|---|---|
| **Draw** | Horizontal = time, vertical = pitch. Pencil, line, curve, dot, rectangle, ellipse, eraser, select/move/resize/duplicate, zoom, pan, stylus pressure. Six brushes: Note, Legato, Arpeggio, Drone, Rhythm, Modulation (draws automation). |
| **Image** | Import a JPG/PNG/WebP/GIF (first frame). It is analysed locally in a worker and read in one of four ways: **A Contour** (Sobel → NMS → hysteresis → connected components → melodic gestures), **B Colour & texture** (each musical parameter reads an image feature you choose; hue sectors route to voices you choose), **C Atmospheric** (regional profiles → chords, drones, filter/reverb movement), **Hybrid** (separate engines produce melody, bass, pads, percussion and filter automation). |
| **Panorama** | A very wide image scrolls under a fixed playhead. Free-time (seconds) or beat-sync (bars). Left→right, right→left, ping-pong, selected region or a custom drawn path. Regions — bands, painted masks or lasso areas — take musical roles. |
| **Generative** | Eight style profiles (Ambient, Ambient dub, Krautrock/motorik, IDM/glitch, Minimal, Drone, Cinematic, Abstract/atonal), five structures, twelve shaping controls, seeds, locks (melody, harmony, rhythm, instruments, selected notes), optionally guided by your drawing, image or panorama. |
| **Orbital** | Draw in a circle: angle is time, radius is pitch; the playhead rotates clockwise or counter-clockwise. |
| **Particles** | Deterministic, seeded physics: particles play notes as they enter the zones you draw. |

Plus: twelve synthesised instruments and a drum kit on five engines (subtractive, FM, modal/additive, noise, glitch) with 26 factory presets and a full sound editor; 14 insert effects including the **Atmospheric Sweep**; reverb/delay sends; an image→sound modulation matrix; a mixer with mute/solo/meters; a piano roll; scenes and arrangement printing; Web MIDI input with recording.

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
npm run preview    # serve the build at http://localhost:4173/spectral-atlas/
```

On macOS you can double-click **Launch APERTURE.command** (serves the build on port 8772 and opens it once it is confirmed to be this app).

### Tests
```bash
npm test           # 57 unit tests (theory, drawing, image analysis, panorama, composer, scheduler, MIDI parity, files)
npm run build && npm run e2e            # end-to-end checks in headless Chromium
npm run e2e -- draw synth image panorama generative export factory ui audio   # any subset
```
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
- **Voices are built per note from native Web Audio nodes**, so every synth parameter is real, works the same in an `OfflineAudioContext`, and nothing can stick: every source gets an explicit stop time. Tone.js supplies effects and the offline context.
- **Scheduling** is a 25 ms timer looking 120 ms ahead on the audio clock; the cursor only moves forward, so nothing is scheduled twice. Loop wraps and tempo changes append clock segments; the playhead is derived from the audio clock.
- **Image analysis** is tiled: the full-resolution bitmap is cut into tiles, each downscaled and sent to a worker, which builds a compact feature grid (per cell: light, colour, contrast, gradient energy and an edge-magnitude histogram). Musical regeneration, scale/sound changes and panorama regions only read that grid; an edge-sensitivity change re-runs just the contour stage.
- **Remapping without destruction.** Spatially derived notes keep their normalised vertical position (`pitchY`), generated notes keep their scale degree, so changing key, scale or range re-pitches them while drawings and images stay untouched.
- **Determinism.** Every generator draws from seeded RNG streams forked per layer/section/phrase: the same inputs and seed reproduce identical events.
- The offline renderer schedules notes in chunks at `OfflineAudioContext.suspend()` checkpoints — bounded memory for long renders, real progress, and cancellation.

## Troubleshooting

- **No sound** — click anywhere first (browsers require a gesture before audio). Check that the layer isn't muted and that another layer isn't soloed.
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
