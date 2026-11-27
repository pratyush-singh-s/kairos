import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUi } from "../theme/UiProvider";
import { PAGE_COMMANDS } from "./terminal/shell";
import type { RouteId } from "./routes";
import { Logo } from "../components/Logo";

const SHELL_NAMES = { powershell: "Windows PowerShell", bash: "bash", cmd: "Command Prompt" } as const;

const HIDE_DELAY_MS = 600;

/**
 * Our own title bar (the Windows one is turned off). In "auto" mode it stays hidden and slides
 * down when the cursor touches the top edge of the window, like Zen Browser's compact mode.
 * It also appears whenever a keyboard user tabs into it.
 */
export function TitleBar(props: { title: string; command: RouteId }) {
  const { titleBar, theme, terminalShell } = useUi();
  const auto = titleBar === "auto";
  const [shown, setShown] = useState(!auto);
  const [maximized, setMaximized] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const win = useRef(safeWindow());

  useEffect(() => setShown(!auto), [auto]);

  useEffect(() => {
    const w = win.current;
    if (!w) return;
    let unlisten: (() => void) | undefined;
    const refresh = () => void w.isMaximized().then(setMaximized).catch(() => {});
    refresh();
    w.onResized(refresh)
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  function show() {
    window.clearTimeout(hideTimer.current);
    setShown(true);
  }
  function hideSoon() {
    if (!auto) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShown(false), HIDE_DELAY_MS);
  }

  const w = win.current;
  return (
    <>
      {auto && <div className="titlebar-hotzone" onMouseEnter={show} onMouseLeave={hideSoon} aria-hidden="true" />}
      <header
        className="titlebar"
        data-mode={titleBar}
        data-shown={shown}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hideSoon();
        }}
      >
        {theme === "terminal" ? (
          // Terminal theme: a tab strip, as if Focus were running inside Windows Terminal.
          <div className="titlebar-drag titlebar-tabs" data-tauri-drag-region>
            <div className="titlebar-tab" data-tauri-drag-region title={`Kairos: ${props.title}`}>
              <svg className="titlebar-tab-icon" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="0.5" y="1.5" width="15" height="13" rx="1.5" />
                <path d="M3.5 5.5l2.5 2.5-2.5 2.5M8 10.5h4" />
              </svg>
              <span data-tauri-drag-region>
                {SHELL_NAMES[terminalShell]} <span className="titlebar-tab-sub">· focus {PAGE_COMMANDS[props.command]}</span>
              </span>
            </div>
          </div>
        ) : (
          <div className="titlebar-drag" data-tauri-drag-region>
            <Logo size={16} className="titlebar-logo" />
            <span data-tauri-drag-region>Kairos</span>
          </div>
        )}
        <div className="titlebar-buttons">
          <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void w?.minimize()}>
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" /></svg>
          </button>
          <button
            type="button"
            aria-label={maximized ? "Restore" : "Maximize"}
            title={maximized ? "Restore" : "Maximize"}
            onClick={() => void w?.toggleMaximize()}
          >
            {maximized ? (
              <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 0.5h7.5v7.5M0.5 2h7.5v7.5h-7.5z" /></svg>
            ) : (
              <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
            )}
          </button>
          <button type="button" className="titlebar-close" aria-label="Close" title="Close" onClick={() => void w?.close()}>
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" /></svg>
          </button>
        </div>
      </header>
    </>
  );
}

/** The window API throws outside Tauri (e.g. in a plain browser preview). */
function safeWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return undefined;
  }
}
