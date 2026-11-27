import { useEffect, useRef, useState } from "react";
import { timeOfDay } from "@focus/core";
import { isActive, isEndless, PHASE_LABEL } from "../../ipc/timer";
import { useTimer } from "../../features/timer/useTimer";
import { PAGE_COMMANDS } from "./shell";
import type { RouteId } from "../routes";

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

type Mode = "NORMAL" | "INSERT" | "COMMAND" | "VISUAL" | "V-LINE" | "V-BLOCK" | "REPLACE";

/**
 * Vim's mode, read from where the keyboard is: a text field = INSERT, the prompt = COMMAND. In the
 * Code page's editor it is the editor's own Vim mode, which the Code page announces.
 */
function useMode(): Mode {
  const [mode, setMode] = useState<Mode>("NORMAL");
  const codeMode = useRef<Mode | null>(null);
  useEffect(() => {
    function read() {
      const el = document.activeElement as HTMLElement | null;
      if (codeMode.current && el?.closest(".code-editor")) setMode(codeMode.current);
      else if (el?.classList.contains("term-input")) setMode("COMMAND");
      else if (el && (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "range", "button", "color"].includes(el.type))))
        setMode("INSERT");
      else setMode("NORMAL");
    }
    const later = () => requestAnimationFrame(read);
    const onCode = (e: Event) => {
      codeMode.current = (e as CustomEvent<Mode | null>).detail;
      read();
    };
    document.addEventListener("focusin", read);
    document.addEventListener("focusout", later);
    window.addEventListener("focus-code-mode", onCode);
    return () => {
      window.removeEventListener("focus-code-mode", onCode);
      document.removeEventListener("focusin", read);
      document.removeEventListener("focusout", later);
    };
  }, []);
  return mode;
}

/** How far down the page is scrolled, as Neovim shows it: Top, Bot, All or a percentage. */
function useScrollPlace(route: RouteId): string {
  const [place, setPlace] = useState("Top");
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".content");
    if (!el) return;
    function read() {
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      setPlace(max <= 2 ? "All" : el.scrollTop <= 2 ? "Top" : el.scrollTop >= max - 2 ? "Bot" : `${Math.round((el.scrollTop / max) * 100)}%`);
    }
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      ro.disconnect();
    };
  }, [route]);
  return place;
}

/** A lualine-style status line along the bottom: mode, page, the timer, scroll place and clock. */
export function StatusLine(props: { route: RouteId; onOpenTimer: () => void; /** Neovim style names the page as a file ("dashboard.md"). */ file?: string }) {
  const [timer] = useTimer();
  const now = useNow(1000);
  const mode = useMode();
  const place = useScrollPlace(props.route);
  const snap = timer.kind === "ready" ? timer.value : null;
  const active = snap && isActive(snap);
  const remaining = snap && active ? (snap.status === "running" && snap.endsAtMs !== null ? snap.endsAtMs - now : snap.remainingMs) : 0;
  // Endless focus counts up.
  const left = snap && active && isEndless(snap) ? snap.durationMs - remaining : remaining;
  const d = new Date(now);
  return (
    <footer className="term-status" aria-label="Status line" data-mode={mode}>
      <span className="term-status-mode">{mode}</span>
      <span className="term-status-seg">focus</span>
      <span className="term-status-file">{props.file ?? PAGE_COMMANDS[props.route]}</span>
      <span className="term-status-fill" />
      {snap && active && (
        <button type="button" className="term-status-timer" data-status={snap.status} data-phase={snap.phase} onClick={props.onOpenTimer}>
          {snap.status === "running" ? "●" : "❚❚"} {PHASE_LABEL[snap.phase].toLowerCase()} {clock(left)}
        </button>
      )}
      <span className="term-status-seg">{place}</span>
      <span className="term-status-clock">
        {timeOfDay(d)} {d.getDate()} {d.toLocaleDateString(undefined, { month: "short" })}
      </span>
    </footer>
  );
}

/** Each hint is a key that really does something where the keyboard is now. */
const HINTS: Record<"NORMAL" | "INSERT" | "COMMAND", [string, string][]> = {
  NORMAL: [
    ["←↑↓→", "move"],
    ["⏎", "press"],
    ["Alt+1…0", "pages"],
    [":", "command"],
    ["Ctrl+B", "menu"],
    ["Ctrl+Shift+Space", "capture"],
  ],
  INSERT: [
    ["Tab", "next field"],
    ["Alt+1…0", "pages"],
    ["Ctrl+`", "command"],
    ["Ctrl+Shift+Space", "capture"],
  ],
  COMMAND: [
    ["⏎", "run"],
    ["Tab", "complete"],
    ["↑↓", "history"],
    ["Ctrl+L", "clear"],
    ["Esc", "leave"],
  ],
};

/** Full-screen app style: lazygit's bar of keys, above the status line. */
export function KeyHints() {
  const mode = useMode();
  const hints = HINTS[mode === "INSERT" || mode === "COMMAND" ? mode : "NORMAL"];
  return (
    <div className="term-hints" aria-label="Keys">
      {hints.map(([key, what]) => (
        <span key={key} className="term-hint">
          <span className="term-hint-key">{key}</span> {what}
        </span>
      ))}
    </div>
  );
}
