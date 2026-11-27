import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { quickCapture } from "../../ipc/capture";

/**
 * The quick capture box (Ctrl+Shift+Space from anywhere, src-tauri/src/capture.rs). Enter saves
 * a to-do for today, or a note for "n ..."; Esc or clicking away closes it.
 */
export function QuickCapture() {
  const [line, setLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const close = () => void getCurrentWindow().close();

  useEffect(() => {
    input.current?.focus();
    const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) close();
    });
    return () => void off.then((f) => f());
  }, []);

  const save = async () => {
    if (busy || !line.trim()) return;
    setBusy(true);
    try {
      await quickCapture(line);
      close();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const isNote = /^\s*(n\s|note:)/i.test(line);
  return (
    <form
      className="capture"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="capture-label" htmlFor="capture-line">
        {isNote ? "New note" : "To-do for today"}
      </label>
      <input
        id="capture-line"
        ref={input}
        className="capture-input"
        value={line}
        maxLength={400}
        placeholder="Call the bank   ·   n idea for a note"
        onChange={(e) => {
          setLine(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      />
      <p className={error ? "capture-hint error" : "capture-hint"} role={error ? "alert" : undefined}>
        {error ?? "Enter to save · Esc to close"}
      </p>
    </form>
  );
}
