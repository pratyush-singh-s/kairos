import { useEffect } from "react";

/** How far (css px) from a window edge that edge starts to glow. */
const REACH = 160;
type Side = "t" | "r" | "b" | "l";

/**
 * Glass theme edge glow (Settings > Edge glow; styles.css "window edge glow"): slides each side's
 * .wg-bar to the point on that edge nearest the mouse and fades it in as the mouse gets closer to
 * that edge. Only transform and opacity change, at most once a frame and only when they differ, so
 * the browser never repaints for it. Also marks <html data-edge-glow> while on.
 */
export function useWindowGlow(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    root.setAttribute("data-edge-glow", "");
    let mx = 0;
    let my = 0;
    let raf = 0;
    let bars = new Map<Side, HTMLElement>();
    const last = new Map<Side, string>();
    const near = (d: number) => {
      const p = Math.max(0, 1 - d / REACH);
      return p * p * (3 - 2 * p);
    };
    const set = (side: Side, t: string, op: number) => {
      const el = bars.get(side);
      if (!el) return;
      const o = op.toFixed(2);
      const key = o === "0.00" ? "off" : t + o;
      if (last.get(side) === key) return;
      last.set(side, key);
      el.style.opacity = o;
      if (key !== "off") el.style.transform = t;
    };
    const frame = () => {
      raf = 0;
      const first = bars.values().next().value;
      if (!first || !first.isConnected) {
        bars = new Map([...document.querySelectorAll<HTMLElement>(".window-glow > .wg-bar")].map((el) => [el.dataset.side as Side, el]));
        last.clear();
      }
      const w = window.innerWidth;
      const h = window.innerHeight;
      const x = Math.min(Math.max(mx, 0), w);
      const y = Math.min(Math.max(my, 0), h);
      set("t", `translate3d(${x.toFixed(0)}px,0,0)`, near(my));
      set("b", `translate3d(${x.toFixed(0)}px,0,0)`, near(h - my));
      set("l", `translate3d(0,${y.toFixed(0)}px,0)`, near(mx));
      set("r", `translate3d(0,${y.toFixed(0)}px,0)`, near(w - mx));
    };
    const move = (e: PointerEvent) => {
      mx = e.clientX;
      my = e.clientY;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const away = () => {
      for (const el of bars.values()) el.style.opacity = "0";
      last.clear();
    };
    window.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerleave", away);
    window.addEventListener("blur", away);
    return () => {
      cancelAnimationFrame(raf);
      root.removeAttribute("data-edge-glow");
      window.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", away);
      window.removeEventListener("blur", away);
    };
  }, [on]);
}
