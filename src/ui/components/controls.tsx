import { useId, useState, type ReactNode } from 'react';

/** Labelled range slider with a value readout; double-click (or click the readout) resets to default. */
export function Slider(props: {
  label: string; value: number; min: number; max: number; step?: number; def?: number;
  onChange: (v: number) => void; onCommit?: () => void; onStart?: () => void; fmt?: (v: number) => string; title?: string; disabled?: boolean;
}) {
  const id = useId();
  const { label, value, min, max, step = 0.01, def, onChange, fmt, title, disabled } = props;
  const [editing, setEditing] = useState(false);
  const shown = fmt ? fmt(value) : Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
  return (
    <div className="row" title={title}>
      <label htmlFor={id}>{label}</label>
      <div className="slider">
        <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerDown={() => props.onStart?.()} onKeyDown={(e) => { if (!e.repeat) props.onStart?.(); }}
          onPointerUp={() => props.onCommit?.()} onKeyUp={() => props.onCommit?.()}
          onDoubleClick={() => { if (def !== undefined) { onChange(def); props.onCommit?.(); } }} />
        {editing ? (
          <input className="txt" style={{ width: 52, height: 22 }} autoFocus defaultValue={String(value)}
            onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v))); props.onCommit?.(); setEditing(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); }} />
        ) : (
          <button type="button" className="val" title={def !== undefined ? 'Click to type a value · double-click the slider to reset' : 'Click to type a value'} onClick={() => setEditing(true)}>{shown}</button>
        )}
      </div>
    </div>
  );
}

export function Select<T extends string | number>(props: { label?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; title?: string; ariaLabel?: string }) {
  const id = useId();
  const sel = (
    <select id={id} className="sel" value={String(props.value)} title={props.title} aria-label={props.ariaLabel ?? props.label}
      onChange={(e) => { const o = props.options.find((x) => String(x.value) === e.target.value); if (o) props.onChange(o.value); }}>
      {props.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
  if (!props.label) return sel;
  return <div className="row"><label htmlFor={id}>{props.label}</label>{sel}</div>;
}

export function Seg<T extends string | number>(props: { value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void; label?: string }) {
  const seg = (
    <div className="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button type="button" key={String(o.value)} aria-pressed={o.value === props.value} title={o.title} onClick={() => props.onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
  if (!props.label) return seg;
  return <div className="row"><span className="lbl">{props.label}</span>{seg}</div>;
}

export function Check(props: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="check" title={props.title}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}

export function Num(props: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; title?: string; width?: number }) {
  const id = useId();
  return (
    <span className="field" title={props.title}>
      <label htmlFor={id}>{props.label}</label>
      <input id={id} type="number" value={props.value} min={props.min} max={props.max} step={props.step ?? 1} style={props.width ? { width: props.width } : undefined}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) props.onChange(props.min !== undefined ? Math.max(props.min, props.max !== undefined ? Math.min(props.max, v) : v) : v); }} />
    </span>
  );
}

export function Section(props: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section>
      <div className="panel-h"><span>{props.title}</span>{props.right}</div>
      <div className="sec">{props.children}</div>
    </section>
  );
}

export function Progress({ value }: { value: number }) {
  return <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}><i style={{ width: `${Math.round(value * 100)}%` }} /></div>;
}
