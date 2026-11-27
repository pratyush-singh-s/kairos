import { useCallback, useEffect, useState } from "react";

export type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; message: string };

/**
 * Runs a backend command on mount (and every `refreshMs`, and when the window regains focus
 * if `refreshMs` is set). Returns the latest state plus a manual `reload`.
 */
export function useCommand<T>(run: () => Promise<T>, refreshMs?: number): [Loadable<T>, () => void] {
  const [state, setState] = useState<Loadable<T>>({ kind: "loading" });

  const reload = useCallback(() => {
    run()
      .then((value) => setState({ kind: "ready", value }))
      .catch((err: unknown) => {
        // Tauri command errors arrive as plain strings.
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    // `run` is a module-level function in every caller.
  }, [run]);

  useEffect(() => {
    reload();
    if (refreshMs === undefined) return;
    const timer = window.setInterval(reload, refreshMs);
    window.addEventListener("focus", reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [reload, refreshMs]);

  return [state, reload];
}
