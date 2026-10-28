import { useRef } from 'react';
import { useStore } from '../state/store';

/** Replace / clear generated notes / remove for the image or panorama source — shown on the stage
 *  and in the inspector so a picture can always be taken out without starting a new project. */
export function SourceActions({ kind }: { kind: 'image' | 'panorama' }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const prefix = kind === 'image' ? 'image:' : 'pano:';
  const hasNotes = useStore((s) => s.project.tracks.some((t) => t.generator?.startsWith(prefix) && t.notes.some((n) => n.origin === (kind === 'image' ? 'image' : 'panorama'))));
  const st = useStore.getState();
  const noun = kind === 'image' ? 'image' : 'panorama';
  return (
    <>
      <button className="btn small" title={`Load a different ${noun} in its place (its settings are kept; old notes and analysis are discarded)`} onClick={() => fileRef.current?.click()}>Replace {noun}…</button>
      <button className="btn small" disabled={!hasNotes} title={`Remove the notes generated from this ${noun}, keep the picture to regenerate with other settings`} onClick={() => st.clearSourceNotes(kind)}>Clear generated notes</button>
      <button className="btn small danger" title={`Remove the ${noun} from the project`} onClick={() => st.setUi({ dialog: kind === 'image' ? 'removeImage' : 'removePanorama' })}>Remove {noun}…</button>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden aria-label={`Replace ${noun} file`}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void st.replaceSource(kind, f, f.name); e.target.value = ''; }} />
    </>
  );
}

/** The stage-top bar: what is loaded, and the three actions. */
export function SourceBar({ kind, top }: { kind: 'image' | 'panorama'; top?: number }) {
  const src = useStore((s) => s.project[kind]);
  if (!src) return null;
  return (
    <div className="source-bar" role="group" aria-label={`${kind} source`} style={top !== undefined ? { top } : undefined}>
      <span className="nm" title={src.asset.name}>{src.asset.name}</span>
      <SourceActions kind={kind} />
    </div>
  );
}
