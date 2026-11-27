import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { checkUpdate, installUpdate, type UpdateInfo } from "../../ipc/updates";

/** Asks for an update now; the popup opens if one is found. Settings > App uses this. */
export async function checkForUpdateNow(): Promise<UpdateInfo | null> {
  const found = await checkUpdate();
  if (found) window.dispatchEvent(new CustomEvent("kairos-update", { detail: found }));
  return found;
}

const FIRST_CHECK_MS = 8_000;
const EVERY_MS = 3 * 60 * 60 * 1000;

/**
 * "Update available" popup. Checks a few seconds after start and every 3 hours.
 * Later hides it until Kairos next starts.
 */
export function UpdatePopup() {
  const [found, setFound] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<"ask" | "download" | "install" | "error">("ask");
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState("");
  const dismissed = useRef<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function check() {
      try {
        const u = await checkUpdate();
        if (!stop && u && u.label !== dismissed.current) {
          setFound(u);
          setPhase("ask");
        }
      } catch {
        // Offline or no update server: try again later, quietly.
      }
    }
    const first = window.setTimeout(() => void check(), FIRST_CHECK_MS);
    const every = window.setInterval(() => void check(), EVERY_MS);
    function onManual(e: Event) {
      dismissed.current = null;
      setFound((e as CustomEvent<UpdateInfo>).detail);
      setPhase("ask");
    }
    window.addEventListener("kairos-update", onManual);
    let unlisten: (() => void) | undefined;
    listen<{ done: number; total: number | null }>("update-progress", (e) => {
      const { done, total } = e.payload;
      setPct(total ? Math.min(100, Math.round((done / total) * 100)) : null);
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => {
      stop = true;
      window.clearTimeout(first);
      window.clearInterval(every);
      window.removeEventListener("kairos-update", onManual);
      unlisten?.();
    };
  }, []);

  if (!found) return null;

  async function update() {
    setPhase("download");
    setPct(0);
    try {
      await installUpdate();
      setPhase("install");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  function later() {
    dismissed.current = found!.label;
    setFound(null);
  }

  const busy = phase === "download" || phase === "install";
  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={busy ? undefined : later}>
      <div className="modal card update-dialog" role="dialog" aria-label="Update available" onClick={(e) => e.stopPropagation()}>
        <h2 className="card-title">Update available</h2>
        <p className="update-version">Kairos {found.label}</p>
        {found.notes && phase === "ask" && <p className="update-notes">{found.notes}</p>}
        {busy && (
          <>
            <div className="update-bar" aria-hidden="true">
              <span style={{ width: `${phase === "install" ? 100 : pct ?? 30}%` }} data-unknown={pct === null || undefined} />
            </div>
            <p className="hint" role="status">
              {phase === "install" ? "Installing. Kairos will reopen." : pct === null ? "Downloading…" : `Downloading… ${pct}%`}
            </p>
          </>
        )}
        {phase === "error" && <p className="hint update-error" role="alert">Couldn't update: {error}</p>}
        {!busy && (
          <div className="update-actions">
            <button type="button" className="button primary" onClick={() => void update()} autoFocus>
              {phase === "error" ? "Try again" : "Update"}
            </button>
            <button type="button" className="button" onClick={later}>
              Later
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
