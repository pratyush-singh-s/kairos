import { useEffect, useRef } from "react";
import { altKeyAt, visibleRoutes, type RouteId } from "./routes";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Places where the arrow keys already mean something: typing, lists, sliders, the code editor. */
function arrowsBelongTo(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest('.cm-editor, [contenteditable="true"], [role="listbox"], [role="menu"], [role="slider"], .modal')) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    // Text fields keep Left/Right for the caret; radios and sliders keep all four.
    return !["checkbox", "button", "submit", "reset", "color", "file"].includes(el.type);
  }
  return false;
}

function visible(el: HTMLElement): boolean {
  if (el.closest("[inert], [aria-hidden='true']")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && getComputedStyle(el).visibility !== "hidden";
}

type Dir = "up" | "down" | "left" | "right";

/** The nearest control in a direction: mostly straight ahead, a little to the side. */
function nearest(from: DOMRect, dir: Dir, candidates: HTMLElement[]): HTMLElement | undefined {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | undefined;
  let bestScore = Infinity;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const ahead = dir === "down" ? r.top - from.bottom + 1 : dir === "up" ? from.top - r.bottom + 1 : dir === "right" ? r.left - from.right + 1 : from.left - r.right + 1;
    if (ahead < -4) continue; // behind us
    // Distance across the direction of travel counts double, so we keep to the row or column.
    const side = dir === "up" || dir === "down" ? Math.max(0, Math.abs(x - cx) - (r.width + from.width) / 2) : Math.max(0, Math.abs(y - cy) - (r.height + from.height) / 2);
    const score = Math.max(0, ahead) + side * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/**
 * Keyboard moves. Alt+1 … Alt+9 and Alt+0 open the pages in menu order (every theme). In the
 * Terminal theme the arrow keys also move between buttons, links and fields, like moving between
 * windows in Neovim, unless the focused thing uses the arrows itself.
 */
export function useKeyboardNav(theme: string, navigate: (id: RouteId) => void) {
  const nav = useRef(navigate);
  nav.current = navigate;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit\d$/.test(e.code)) {
        const digit = e.code.slice(5);
        const routes = visibleRoutes(theme);
        const index = routes.findIndex((_, i) => altKeyAt(i) === digit);
        if (index >= 0) {
          e.preventDefault();
          nav.current(routes[index]!.id);
        }
        return;
      }
      if (theme !== "terminal" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const dir = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const)[e.key as "ArrowUp"];
      if (!dir) return;
      const active = document.activeElement as HTMLElement | null;
      const typing = active && active !== document.body && arrowsBelongTo(active);
      // In a one-line text field Up/Down still move on; Left/Right move the caret.
      if (typing && !(active instanceof HTMLInputElement && (dir === "up" || dir === "down") && !active.classList.contains("term-input"))) return;
      if (typing && active instanceof HTMLInputElement && ["radio", "range"].includes(active.type)) return;
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el !== active && visible(el) && !el.classList.contains("skip-link") && !el.classList.contains("page-focus-target"),
      );
      const here = active && active !== document.body && !active.classList.contains("page-focus-target") ? active.getBoundingClientRect() : new DOMRect(window.innerWidth / 2, 0, 0, 0);
      const next = nearest(here, dir, candidates);
      if (!next) return;
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [theme]);
}
