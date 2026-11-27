import { useEffect, useRef, useState } from "react";

/** How far a swipe must travel to open or close the menu (px of touch, or wheel delta). */
const OPEN_DISTANCE = 60;
const WHEEL_DISTANCE = 90;
/** A touch has to start this close to the left edge to pull the menu out. */
const EDGE = 28;
/** A pause longer than this ends a touchpad swipe. */
const WHEEL_GAP_MS = 220;

/** True when `el` or a parent can scroll sideways itself (then a sideways swipe is for it). */
function scrollsSideways(el: Element | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const style = getComputedStyle(n);
    if ((style.overflowX === "auto" || style.overflowX === "scroll") && n.scrollWidth > n.clientWidth + 1) return true;
  }
  return false;
}

/**
 * Full-screen pages with the menu tucked away (sidebar "hidden"): a swipe from left to right
 * pulls the menu out over the page, a swipe back (or picking a page, Esc, or clicking the page)
 * puts it away. Works with a touchpad (two-finger swipe), a touch screen or pen (from the left
 * edge), and the mouse (rest it on the left edge).
 */
export function useSidebarSwipe(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      return;
    }
    let wheel = 0;
    let wheelAt = 0;
    function onWheel(e: WheelEvent) {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || e.ctrlKey) return;
      if (scrollsSideways(e.target as Element)) return;
      const now = performance.now();
      if (now - wheelAt > WHEEL_GAP_MS) wheel = 0;
      wheelAt = now;
      // Fingers moving right scroll content left: deltaX goes negative.
      wheel += -e.deltaX;
      if (!openRef.current && wheel > WHEEL_DISTANCE) {
        setOpen(true);
        wheel = 0;
      } else if (openRef.current && wheel < -WHEEL_DISTANCE) {
        setOpen(false);
        wheel = 0;
      }
    }

    let start: { x: number; y: number; id: number } | null = null;
    function onDown(e: PointerEvent) {
      if (e.pointerType === "mouse") return;
      if (openRef.current || e.clientX <= EDGE) start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    }
    function onMove(e: PointerEvent) {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      if (Math.abs(e.clientY - start.y) > Math.abs(dx)) return;
      if (!openRef.current && dx > OPEN_DISTANCE) {
        setOpen(true);
        start = null;
      } else if (openRef.current && dx < -OPEN_DISTANCE) {
        setOpen(false);
        start = null;
      }
    }
    function onUp() {
      start = null;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && openRef.current) setOpen(false);
    }
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled]);

  return { open: enabled && open, setOpen };
}
