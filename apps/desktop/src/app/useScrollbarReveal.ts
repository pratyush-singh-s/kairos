import { useEffect } from "react";

/** How close to a scroll area's right edge the cursor must be to show its scrollbar. */
const EDGE_PX = 16;

function scrollerAt(el: Element | null): HTMLElement | null {
  for (let n = el; n instanceof HTMLElement; n = n.parentElement) {
    const y = getComputedStyle(n).overflowY;
    if ((y === "auto" || y === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  const root = document.scrollingElement;
  return root instanceof HTMLElement && root.scrollHeight > root.clientHeight ? root : null;
}

/**
 * Scrollbars are thin and hidden (styles.css); one shows only while the cursor is on it, i.e.
 * near the right edge of that scroll area, and while it is being dragged.
 */
export function useScrollbarReveal() {
  useEffect(() => {
    let shown: HTMLElement | null = null;
    let dragging = false;
    const show = (el: HTMLElement | null) => {
      if (el === shown) return;
      shown?.removeAttribute("data-scrollbar");
      el?.setAttribute("data-scrollbar", "shown");
      shown = el;
    };
    const move = (e: PointerEvent) => {
      if (dragging) return;
      const el = scrollerAt(document.elementFromPoint(e.clientX, e.clientY));
      const right = el ? (el === document.scrollingElement ? window.innerWidth : el.getBoundingClientRect().right) : 0;
      show(el && right - e.clientX <= EDGE_PX ? el : null);
    };
    const down = () => (dragging = shown !== null);
    const up = () => (dragging = false);
    const leave = () => !dragging && show(null);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      document.documentElement.removeEventListener("pointerleave", leave);
      show(null);
    };
  }, []);
}
