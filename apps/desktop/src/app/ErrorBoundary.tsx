import { Component, type ReactNode } from "react";

/**
 * If a page crashes, show what went wrong and a Reload button instead of a blank window.
 * The message helps track down the bug (Ps saw a blank window once in 0.5.2).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p className="muted">Kairos hit an error on this screen. Your timer and data are safe.</p>
        <pre>{error.message}</pre>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
