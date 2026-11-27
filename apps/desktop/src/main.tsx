import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { MiniTimer } from "./features/timer/MiniTimer";
import { AppBlocked } from "./features/blocking/AppBlocked";
import { QuickCapture } from "./features/capture/QuickCapture";
import { UiProvider, paintInitialTheme } from "./theme/UiProvider";
// The Terminal theme's font, bundled with its full weight range so bold text is really bold
// (a PC's own copy of Cascadia may have no bold, and then bold looked like normal text).
import "@fontsource-variable/cascadia-code";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

paintInitialTheme();

// The same page serves the main window and the pop-out mini timer (opened at index.html#mini).
// The blocked-app screen is the same page too (index.html#appblock).
// #mini-countdown is the same small window showing the countdown instead.
const isMini = window.location.hash.startsWith("#mini");
const isAppBlock = window.location.hash === "#appblock";
// Quick capture (Ctrl+Shift+Space) is index.html#capture.
const isCapture = window.location.hash === "#capture";
if (isMini) document.documentElement.classList.add("mini-window");
if (isAppBlock) document.documentElement.classList.add("appblock-window");
if (isCapture) document.documentElement.classList.add("capture-window");

// The main window lets Windows deliver Ctrl + mouse wheel and touchpad pinches to the page (with
// zoom turned off there, WebView2 swallowed them, so a handwritten note could not zoom). The whole
// app must not zoom, though: block the browser's own zoom everywhere. Pages that zoom their own
// content (the handwritten note board) still get the events and zoom just that.
window.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false, capture: true },
);
window.addEventListener(
  "keydown",
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) e.preventDefault();
  },
  { capture: true },
);

// Safety net: if the page ever comes back empty (as Ps saw once), reload it instead of
// showing a blank window. The timer lives in the native core, so nothing is lost.
// No browser menu (Back, Refresh, Print, Inspect) on right-click: Focus is an app, not a web page.
// Text boxes and selected text keep it, for Cut / Copy / Paste and spelling fixes.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  const editable = t?.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
  const selected = (window.getSelection()?.toString() ?? "").trim() !== "";
  if (!editable && !selected) e.preventDefault();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && document.getElementById("root")?.childElementCount === 0) window.location.reload();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <UiProvider>
      <ErrorBoundary>{isMini ? <MiniTimer /> : isAppBlock ? <AppBlocked /> : isCapture ? <QuickCapture /> : <App />}</ErrorBoundary>
    </UiProvider>
  </React.StrictMode>,
);
