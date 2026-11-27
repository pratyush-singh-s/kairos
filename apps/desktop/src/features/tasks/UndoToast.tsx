import { useCallback, useEffect, useRef, useState } from "react";

interface Offer {
  text: string;
  run: () => void;
}

export interface Undo {
  current: Offer | null;
  /** Shows `text` with an Undo button that calls `run`. A new offer replaces the old one. */
  offer: (text: string, run: () => void) => void;
  dismiss: () => void;
}

/** A short-lived "Deleted … Undo" offer. */
export function useUndo(ms = 8000): Undo {
  const [current, setCurrent] = useState<Offer | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const dismiss = useCallback(() => {
    window.clearTimeout(timer.current);
    setCurrent(null);
  }, []);

  const offer = useCallback(
    (text: string, run: () => void) => {
      window.clearTimeout(timer.current);
      setCurrent({ text, run });
      timer.current = window.setTimeout(() => setCurrent(null), ms);
    },
    [ms],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { current, offer, dismiss };
}

export function UndoToast(props: { undo: Undo }) {
  const o = props.undo.current;
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {o && (
        <div className="toast">
          <span>{o.text}</span>
          <button
            type="button"
            className="button small-button"
            onClick={() => {
              props.undo.dismiss();
              o.run();
            }}
          >
            Undo
          </button>
          <button type="button" className="icon-button" onClick={props.undo.dismiss} aria-label="Dismiss">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M6 6l8 8M14 6l-8 8" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
