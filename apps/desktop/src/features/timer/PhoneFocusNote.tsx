import { useEffect, useState } from "react";
import { timeOfDay } from "@focus/core";
import { invoke } from "@tauri-apps/api/core";
import { useCommand } from "../../useCommand";

/** Mirrors `LiveClock` in crates/focus-store/src/phone_block.rs. */
interface LiveClock {
  deviceId: string;
  phase: "focus" | "break";
  round: number;
  rounds: number;
  paused: boolean;
  leftMs: number | null;
  endsAtMs: number | null;
}

/** Mirrors `FocusLive` in crates/focus-store/src/phone_block.rs (the phone's `focus.livePhone`). */
interface PhoneFocus {
  active: boolean;
  paused: boolean;
  endsAtMs: number | null;
  presetName: string | null;
  updatedAtMs: number;
  /** Missing from phone apps older than 0.24.22. */
  clock?: LiveClock | null;
}

type Action = "pause" | "resume" | "skip" | "stop";

const phoneFocus = () => invoke<PhoneFocus | null>("phone_focus_state");
const phoneTimerAction = (action: Action) => invoke<void>("phone_timer_action", { action });
const CLOCK = { format: timeOfDay };

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * The phone's (or Focus launcher's) timer, counting down here too, with Pause, Skip and Stop
 * sent back to the phone. They land when the phone next syncs: at once while Focus is open
 * there, otherwise within a minute or so if its blocking service is on.
 */
export function PhoneFocusNote() {
  const [phone, reload] = useCommand(phoneFocus, 3_000);
  const [now, setNow] = useState(Date.now());
  const [sent, setSent] = useState<{ action: Action; at: number; seen: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const p = phone.kind === "ready" ? phone.value : null;
  // The phone answered (its state changed since the press), or it's been a while: stop saying "sent".
  const waiting = sent && p && p.updatedAtMs === sent.seen && now - sent.at < 60_000 ? sent : null;
  if (!p) return null;
  const c = p.clock;
  if (!c) {
    // An older phone app: it only says that it's in focus.
    if (!p.active) return null;
    return (
      <p className="pill pill-ok phone-focus-note" role="status">
        <span aria-hidden="true">● </span>
        Your phone is in focus{p.presetName ? ` (${p.presetName})` : ""}
        {p.paused ? ", paused" : p.endsAtMs ? ` until ${CLOCK.format(new Date(p.endsAtMs))}` : ""}. This PC is blocking too.
      </p>
    );
  }

  const left = c.paused ? (c.leftMs ?? 0) : (c.endsAtMs ?? now) - now;
  const label = c.phase === "break" ? "Break" : c.rounds > 1 ? `Focus ${c.round} of ${c.rounds}` : "Focus";
  const send = (action: Action) => {
    setError(null);
    phoneTimerAction(action).then(
      () => {
        setSent({ action, at: Date.now(), seen: p.updatedAtMs });
        reload();
      },
      (e: unknown) => setError(String(e)),
    );
  };

  return (
    <div className="phone-timer" role="status" data-phase={c.phase}>
      <p className="phone-timer-head">
        <span aria-hidden="true">📱</span> Phone timer · {label}
        {c.paused ? " · paused" : ""}
      </p>
      <p className="phone-timer-left">{mmss(left)}</p>
      <p className="muted small">
        {c.phase === "focus" ? "This PC is blocking too." : "Nothing is blocked during the break."}
        {waiting ? ` Sent "${waiting.action}" to your phone…` : ""}
      </p>
      <div className="phone-timer-actions">
        {c.phase === "focus" && (
          <button type="button" className="button small-button" onClick={() => send(c.paused ? "resume" : "pause")}>
            {c.paused ? "Resume" : "Pause"}
          </button>
        )}
        <button type="button" className="button small-button" onClick={() => send("skip")}>
          {c.phase === "break" ? "Skip break" : "Skip"}
        </button>
        <button type="button" className="link-button small" onClick={() => send("stop")}>
          Stop
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
