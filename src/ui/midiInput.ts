// Web MIDI input: play the selected layer, audition scale-locked, and record into it while playing.
import { engine, useStore } from '../state/store';
import { snapToScale } from '../theory/scales';

let access: MIDIAccess | null = null;
const held = new Map<number, { start: number; vel: number; trackId: string; midi: number }>();

export async function connectMidi(): Promise<boolean> {
  const st = useStore.getState();
  if (access) return true;
  if (!('requestMIDIAccess' in navigator)) { st.setUi({ midiStatus: 'Web MIDI is not available in this browser (try Chrome or Edge). Everything else works without it.' }); return false; }
  try {
    access = await navigator.requestMIDIAccess();
  } catch {
    st.setUi({ midiStatus: 'MIDI access was declined.' });
    return false;
  }
  const attach = () => {
    const names: string[] = [];
    access!.inputs.forEach((inp) => { inp.onmidimessage = onMessage; names.push(inp.name ?? 'input'); });
    st.setUi({ midiStatus: names.length ? `MIDI: ${names.join(', ')}` : 'MIDI: no input devices connected' });
  };
  access.onstatechange = attach;
  attach();
  return true;
}

function onMessage(e: MIDIMessageEvent) {
  const d = e.data;
  if (!d || d.length < 3) return;
  const type = d[0] & 0xf0;
  const st = useStore.getState();
  const t = st.project.tracks.find((x) => x.id === st.ui.selectedTrackId) ?? st.project.tracks[0];
  if (!t) return;
  let midi = d[1];
  if (t.pitch.mode === 'scale' || t.pitch.mode === 'pentatonic') midi = snapToScale(midi, st.project.settings.key, st.project.settings.scale, st.project.settings.customScale);
  if (type === 0x90 && d[2] > 0) {
    void engine.noteOn(t.id, midi, d[2] / 127);
    if (st.ui.recording && engine.state === 'playing') held.set(d[1], { start: engine.position(), vel: d[2] / 127, trackId: t.id, midi });
  } else if (type === 0x80 || (type === 0x90 && d[2] === 0)) {
    engine.noteOff(t.id, midi);
    const h = held.get(d[1]);
    held.delete(d[1]);
    if (h) {
      const q = st.project.settings.quantize;
      const start = Math.round(h.start * q) / q;
      const dur = Math.max(1 / q, Math.round((engine.position() - h.start) * q) / q);
      st.addNote(h.trackId, { start, dur, midi: h.midi, vel: h.vel }, 'midi');
    }
  }
}

export async function toggleMidiRecord() {
  const st = useStore.getState();
  if (!st.ui.recording) {
    const ok = await connectMidi();
    if (!ok) { st.toast(st.ui.midiStatus, 'error'); return; }
    st.setUi({ recording: true });
    st.toast('MIDI record armed: notes played while the transport runs are added to the selected layer.', 'info');
  } else st.setUi({ recording: false });
}
