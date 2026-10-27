import { Component, type ReactNode } from 'react';
import { useStore } from '../state/store';

export function resetLayout() {
  useStore.getState().setUi({ leftOpen: true, rightOpen: true, bottomOpen: true, bottomTab: 'mixer', inspectorTab: 'source', dialog: null, tool: 'pencil', selStrokes: [], selNotes: [] });
}

/** Keeps a failing panel from taking the whole instrument down; the error is shown, not swallowed. */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`[${this.props.label}]`, error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="overlay-msg" style={{ position: 'relative', inset: 'auto', padding: 16 }}>
        <div className="card" role="alert">
          <h2>{this.props.label} hit an error</h2>
          <p className="note err">{this.state.error.message}</p>
          <p className="note">Your project is safe (it autosaves). You can retry, or reset the layout.</p>
          <div className="btnrow" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={() => this.setState({ error: null })}>Retry</button>
            <button className="btn" onClick={() => { resetLayout(); this.setState({ error: null }); }}>Reset layout</button>
          </div>
        </div>
      </div>
    );
  }
}
