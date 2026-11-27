import { useRef, useState, type PointerEvent } from "react";

/** Where a card can land: a day column ("YYYY-MM-DD") or the No date list (null). */
export type DropDay = string | null;

/** How far the pointer must move before a press becomes a drag rather than a click. */
const DRAG_START_PX = 5;

/**
 * Moving board cards with the mouse. Built on pointer events rather than HTML drag and drop,
 * which the Windows webview hands to the native file-drop handler and so never starts.
 * Drop targets carry `data-drop-day` ("" = No date). A press that does not move is a click.
 */
export function useCardDrag(onDrop: (taskId: string, day: DropDay) => void) {
  const [dropDay, setDropDay] = useState<DropDay | undefined>(undefined);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Set when a drag ends, so the click that follows the pointerup does not open the card.
  const justDragged = useRef(false);

  function targetAt(x: number, y: number): DropDay | undefined {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-day]");
    if (!el) return undefined;
    return el.dataset.dropDay || null;
  }

  /** Spread onto a card. `enabled` false keeps it clickable but not movable. */
  function cardProps(taskId: string, enabled: boolean) {
    return {
      "data-dragging": draggingId === taskId,
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (!enabled || e.button !== 0) return;
        // The tick box keeps its own click.
        if ((e.target as HTMLElement).closest("input, select, textarea")) return;
        const card = e.currentTarget;
        // Keep getting the moves even if the pointer leaves the window, and stop the webview
        // from starting its own text or image drag.
        e.preventDefault();
        try {
          card.setPointerCapture(e.pointerId);
        } catch {
          /* capture is a nicety */
        }
        const startX = e.clientX;
        const startY = e.clientY;
        let ghost: HTMLElement | null = null;
        let over: DropDay | undefined;

        const move = (ev: globalThis.PointerEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!ghost) {
            if (Math.hypot(dx, dy) < DRAG_START_PX) return;
            const box = card.getBoundingClientRect();
            ghost = card.cloneNode(true) as HTMLElement;
            ghost.classList.add("task-card-ghost");
            Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` });
            document.body.appendChild(ghost);
            document.body.classList.add("is-dragging-card");
            setDraggingId(taskId);
          }
          ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(2deg)`;
          over = targetAt(ev.clientX, ev.clientY);
          setDropDay(over);
        };
        const finish = (drop: boolean) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cancel);
          window.removeEventListener("keydown", esc);
          if (!ghost) return;
          ghost.remove();
          document.body.classList.remove("is-dragging-card");
          justDragged.current = true;
          setTimeout(() => (justDragged.current = false), 0);
          setDraggingId(null);
          setDropDay(undefined);
          if (drop && over !== undefined) onDrop(taskId, over);
        };
        const up = () => finish(true);
        const cancel = () => finish(false);
        const esc = (ev: KeyboardEvent) => ev.key === "Escape" && finish(false);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", esc);
      },
    };
  }

  /** Spread onto a column or the No date list. */
  const targetProps = (day: DropDay) => ({
    "data-drop-day": day ?? "",
    "data-drop": dropDay === day,
  });

  /** True right after a drag, so the card's click handler can ignore it. */
  const wasDrag = () => justDragged.current;

  return { cardProps, targetProps, wasDrag };
}
