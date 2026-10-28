import { zipSync } from 'fflate';
import { drawContours } from './contourDraw';
import { useStore } from '../state/store';
import { projectToMidi } from '../export/midi';
import { packProject, referencedAssets, unpackProject } from '../export/projectFile';
import { renderOffline, RenderCancelled, peakAndRms } from '../audio/offline';
import { encodeWav } from '../audio/wav';
import { projectBeats } from '../core/time';
import { getAsset } from '../persist/db';
import { download, safeName } from './canvas';
import { getAnalysis, getLevels } from '../analysis/client';
import { allowedPitches, yForMidi } from '../theory/scales';
import { barBeats } from '../core/time';

export type Range = 'all' | 'loop';
const rangeOf = (r: Range) => {
  const s = useStore.getState().project.settings;
  return r === 'loop' ? { from: s.loop.start, to: s.loop.end } : { from: 0, to: projectBeats(s) };
};

export function exportMidi(range: Range) {
  const p = useStore.getState().project;
  const { from, to } = rangeOf(range);
  const bytes = projectToMidi(p, { from, to });
  download(bytes as BlobPart, `${safeName(p.name)}${range === 'loop' ? '-loop' : ''}.mid`, 'audio/midi');
}

export interface WavOptions { range: Range; stems: boolean; tail: number; bitDepth: 16 | 24; sampleRate: 44100 | 48000 }

export async function exportWav(o: WavOptions, onProgress: (f: number, label: string) => void, signal: AbortSignal): Promise<string> {
  const p = useStore.getState().project;
  const { from, to } = rangeOf(o.range);
  const base = `${safeName(p.name)}${o.range === 'loop' ? '-loop' : ''}`;
  const toWav = (b: AudioBuffer) => new Uint8Array(encodeWav([b.getChannelData(0), b.getChannelData(1)], b.sampleRate, o.bitDepth));
  if (!o.stems) {
    const buf = await renderOffline(p, { from, to, tail: o.tail, sampleRate: o.sampleRate, signal, onProgress: (f) => onProgress(f, 'Rendering mix…') });
    const { peak, rms } = peakAndRms(buf);
    download(toWav(buf) as BlobPart, `${base}.wav`, 'audio/wav');
    return `Mix rendered: ${(buf.duration).toFixed(1)} s, peak ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS, RMS ${(20 * Math.log10(rms || 1e-9)).toFixed(1)} dBFS`;
  }
  const anySolo = p.tracks.some((t) => t.mix.solo);
  const tracks = p.tracks.filter((t) => t.notes.length && (anySolo ? t.mix.solo : !t.mix.mute));
  if (!tracks.length) throw new Error('No audible layers with notes to export as stems.');
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < tracks.length; i++) {
    if (signal.aborted) throw new RenderCancelled();
    const t = tracks[i];
    const buf = await renderOffline(p, { from, to, tail: o.tail, sampleRate: o.sampleRate, signal, only: [t.id], onProgress: (f) => onProgress((i + f) / tracks.length, `Stem ${i + 1}/${tracks.length}: ${t.name}`) });
    files[`${String(i + 1).padStart(2, '0')}-${safeName(t.name)}.wav`] = toWav(buf);
  }
  files['README.txt'] = new TextEncoder().encode(`APERTURE stems for “${p.name}”\nTempo ${p.settings.bpm} BPM, ${p.settings.timeSig}. All stems start at the same moment and include a ${o.tail}s tail.\nEach stem is the layer's channel incl. its inserts and its share of the reverb/delay sends; the master bus compressor is applied per stem.\n`);
  onProgress(1, 'Zipping…');
  download(zipSync(files, { level: 0 }) as BlobPart, `${base}-stems.zip`, 'application/zip');
  return `${tracks.length} stems exported`;
}

export async function exportProjectFile() {
  const p = useStore.getState().project;
  const assets = [];
  for (const id of referencedAssets(p)) {
    const blob = await getAsset(id);
    if (!blob) throw new Error('An image used by this project is missing from browser storage, so a portable file cannot include it. Re-import the image first.');
    const ref = p.image?.asset.assetId === id ? p.image.asset : p.panorama!.asset;
    assets.push({ id, name: ref.name, mime: blob.type || ref.mime, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  download(packProject(p, assets) as BlobPart, `${safeName(p.name)}.aperture`, 'application/zip');
}

export async function importProjectFile(file: Blob) {
  const st = useStore.getState();
  try {
    const { project, assets } = unpackProject(new Uint8Array(await file.arrayBuffer()));
    await st.loadProject({ ...project, id: project.id }, assets.map((a) => ({ id: a.id, blob: new Blob([a.bytes as BlobPart], { type: a.mime }) })));
    st.toast(`Opened “${project.name}”`, 'ok');
  } catch (e) { st.toast((e as Error).message, 'error'); }
}

export function exportPNG() {
  const c = document.querySelector<HTMLCanvasElement>('.stage canvas');
  if (!c) return;
  c.toBlob((b) => b && download(b, `${safeName(useStore.getState().project.name)}-${useStore.getState().project.workspace}.png`, 'image/png'), 'image/png');
}

export function exportSVG() {
  const p = useStore.getState().project;
  const beats = projectBeats(p.settings);
  const W = 1600, H = 600, sx = W / Math.max(1, beats);
  const paths = p.strokes.map((s) => {
    const t = p.tracks.find((x) => x.id === s.trackId);
    const pts = s.points.map((q) => `${(q.x * sx).toFixed(1)},${((1 - q.y) * H).toFixed(1)}`);
    if (pts.length === 1) return `<circle cx="${pts[0].split(',')[0]}" cy="${pts[0].split(',')[1]}" r="${2 + s.brush.size}" fill="${t?.color ?? '#fff'}"><title>${t?.name ?? ''} · ${s.brush.kind}</title></circle>`;
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${t?.color ?? '#fff'}" stroke-width="${1.2 + s.brush.size * 0.9}" stroke-linecap="round" stroke-linejoin="round"><title>${t?.name ?? ''} · ${s.brush.kind}</title></polyline>`;
  });
  const bars = Array.from({ length: p.settings.lengthBars + 1 }, (_, i) => `<line x1="${i * barBeats(p.settings.timeSig) * sx}" y1="0" x2="${i * barBeats(p.settings.timeSig) * sx}" y2="${H}" stroke="#2e3138"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#101113"/>${bars.join('')}${paths.join('')}</svg>`;
  download(svg, `${safeName(p.name)}-drawing.svg`, 'image/svg+xml');
}

/** The analysed image with its contours and derived notes drawn over it. */
export async function exportOverlay(kind: 'image' | 'panorama') {
  const p = useStore.getState().project;
  const src = kind === 'image' ? p.image : p.panorama;
  if (!src) throw new Error(`No ${kind} in this project.`);
  const lv = getLevels(src.asset.assetId);
  const a = getAnalysis(src.asset.assetId);
  if (!lv) throw new Error('The image is still loading.');
  const W = lv.display.width, H = lv.display.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(lv.display, 0, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, W, H);
  if (a) drawContours(ctx, a.contours, { X: (x) => x * W, Y: (y) => (1 - y) * H, sx: W, sy: H, width: 2, junctions: true });
  const beats = kind === 'image' ? p.image!.settings.bars * barBeats(p.settings.timeSig) : projectBeats(p.settings);
  for (const t of p.tracks.filter((x) => x.generator?.startsWith(kind === 'image' ? 'image:' : 'pano:'))) {
    const pitches = allowedPitches(t.pitch, p.settings.key, p.settings.scale, p.settings.customScale);
    ctx.fillStyle = t.color;
    for (const n of t.notes) ctx.fillRect((n.start / beats) * W, (1 - (n.pitchY ?? yForMidi(n.midi, pitches))) * H - 2, Math.max(2, (n.dur / beats) * W), 4);
  }
  await new Promise<void>((res) => c.toBlob((b) => { if (b) download(b, `${safeName(p.name)}-${kind}-analysis.png`, 'image/png'); res(); }, 'image/png'));
}
