import { useCallback, useEffect, useState } from "react";
import { backToFocus, blockedApp, continueBlockedApp, type BlockedApp } from "../../ipc/blocking";
import { useHistoryChanged } from "../../ipc/history";
import { ReasonPicker } from "./ReasonPicker";

/**
 * The small screen shown when a blocked program comes to the front during focus (opened at
 * index.html#appblock). The program was already sent down to the taskbar; "Wait" programs can
 * be continued after their countdown, "Full block" ones not until the break.
 */
export function AppBlocked() {
  const [app, setApp] = useState<BlockedApp | null>(null);
  // Our clock minus the core's, so the countdown runs from when the program was first blocked.
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    blockedApp()
      .then((b) => {
        setApp(b);
        if (b) setSkew(Date.now() - b.nowMs);
      })
      .catch((err: unknown) => setError(String(err)));
  }, []);
  useEffect(load, [load]);
  useHistoryChanged(load, "app-blocked");

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);

  const left = app ? Math.max(0, Math.ceil((app.sinceMs + app.waitSeconds * 1000 - (now - skew)) / 1000)) : 0;

  async function go() {
    setError(null);
    try {
      await continueBlockedApp(reason.trim());
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <main className="appblock" data-tauri-drag-region>
      <p className="appblock-kicker" data-tauri-drag-region>
        Focus time
      </p>
      <h1 data-tauri-drag-region>{app ? `${app.name} is blocked` : "Blocked"}</h1>
      <p className="muted" data-tauri-drag-region>
        {app?.mode === "wait"
          ? left > 0
            ? "Take a breath. Do you really need it right now?"
            : "If you really need it, you can use it until this focus phase ends."
          : "It opens again on your break. File Explorer, Task Manager and Settings still work."}
      </p>
      {app?.mode === "wait" && left > 0 && (
        <p className="appblock-count" aria-live="polite">
          {left}
        </p>
      )}
      {app?.mode === "wait" && left === 0 && <ReasonPicker value={reason} onChange={setReason} onSubmit={() => void go()} />}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <div className="appblock-actions">
        <button type="button" className="button primary" onClick={() => void backToFocus()}>
          Back to Kairos
        </button>
        {app?.mode === "wait" && (
          <button type="button" className="button" disabled={left > 0 || reason.trim().length < 2} onClick={() => void go()}>
            {left > 0 ? `Continue in ${left} s` : `Continue to ${app.name}`}
          </button>
        )}
      </div>
    </main>
  );
}
