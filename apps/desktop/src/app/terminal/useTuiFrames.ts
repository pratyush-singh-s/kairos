import { useEffect } from "react";

/** Boxes drawn with ┌─┐│└┘, and lines drawn with │ (the menu's edge). */
const BOX = ".content .card, .content .board";
const RIGHT_LINE = ".sidebar";
const LEFT_LINE = ".content .board-col + .board-col";
const FRAME = "tui-frame";

interface Cell {
  w: number;
  h: number;
}

/** The size of one character cell in the frame font. */
function measure(): Cell {
  const probe = document.createElement("span");
  probe.className = FRAME;
  probe.style.cssText = "position:absolute;visibility:hidden;inset:auto;transform:none";
  probe.textContent = "─".repeat(40);
  document.body.appendChild(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  const cell = { w: r.width / 40 || 8, h: r.height || 18 };
  document.documentElement.style.setProperty("--tui-cell-w", `${cell.w}px`);
  document.documentElement.style.setProperty("--tui-cell-h", `${cell.h}px`);
  return cell;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A title set into the top line: the text of the card's title (and a day total on the right). */
function titleOf(el: Element): { left: string; right: string } | null {
  const h = el.querySelector(":scope > .card-title, :scope > .history-day-title, :scope > .board-head, :scope > .plan-day-head");
  if (!h) return null;
  const spans = h.querySelectorAll(":scope > span");
  if (h.classList.contains("history-day-title") && spans.length > 1) {
    return { left: spans[0]!.textContent ?? "", right: spans[spans.length - 1]!.textContent ?? "" };
  }
  if (!h.classList.contains("card-title") && !h.classList.contains("history-day-title")) return null;
  return { left: (h.textContent ?? "").trim(), right: "" };
}

function fit(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

function drawBox(el: HTMLElement, frame: HTMLElement, cell: Cell, index: number) {
  // Box glyphs draw their line through the middle of the cell, so the frame reaches half a cell
  // past each edge to put the lines exactly on the panel's edges.
  const W = el.offsetWidth + cell.w;
  const H = el.offsetHeight + cell.h;
  frame.style.left = `${-cell.w / 2}px`;
  frame.style.top = `${-cell.h / 2}px`;
  const cols = Math.max(4, Math.round(W / cell.w));
  const rows = Math.max(2, Math.round(H / cell.h));
  const title = titleOf(el);
  const inner = cols - 2;
  let top = "┌" + "─".repeat(inner) + "┐";
  if (title) {
    // ┌─¹title────── right ─┐
    const num = el.querySelector(":scope > .card-title") && index > 0 ? String(index) : "";
    const right = title.right ? ` ${title.right} ` : "";
    const room = inner - 1 - num.length - 2 - right.length - 1;
    const left = fit(title.left.toLowerCase(), room);
    const fill = inner - 1 - num.length - (left.length + 2) - right.length - (right ? 1 : 0);
    top =
      "┌─" +
      (num ? `<span class="tui-num">${num}</span>` : "") +
      ` <span class="tui-title">${esc(left)}</span> ` +
      "─".repeat(Math.max(0, fill)) +
      (right ? `<span class="tui-right">${esc(right)}</span>─` : "") +
      "┐";
  }
  const side = "│" + " ".repeat(inner) + "│";
  const lines = [top];
  for (let i = 0; i < rows - 2; i++) lines.push(side);
  lines.push("└" + "─".repeat(inner) + "┘");
  const html = lines.join("\n");
  if (frame.innerHTML !== html) frame.innerHTML = html;
  frame.style.transform = `scale(${W / (cols * cell.w)}, ${H / (rows * cell.h)})`;
}

function drawLine(el: HTMLElement, frame: HTMLElement, cell: Cell) {
  const H = el.offsetHeight;
  const rows = Math.max(1, Math.round(H / cell.h));
  const text = Array(rows).fill("│").join("\n");
  if (frame.textContent !== text) frame.textContent = text;
  frame.style.transform = `scaleY(${H / (rows * cell.h)})`;
  // The line sits on the edge, centred on where the CSS border was.
  frame.style.marginLeft = frame.dataset.kind === "left" ? `${-cell.w / 2}px` : "";
  frame.style.marginRight = frame.dataset.kind === "right" ? `${-cell.w / 2}px` : "";
}

/**
 * Terminal theme: every panel's border is drawn with box-drawing characters, sized to whole
 * character cells and stretched the last fraction of a pixel, so it looks like a real TUI.
 */
export function useTuiFrames(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let cell = measure();
    const sized = new ResizeObserver((entries) => {
      for (const e of entries) redraw(e.target as HTMLElement);
    });
    const tracked = new Set<HTMLElement>();

    function frameOf(el: HTMLElement, kind: string): HTMLElement {
      let f = el.querySelector<HTMLElement>(`:scope > .${FRAME}`);
      if (!f) {
        f = document.createElement("span");
        f.className = FRAME;
        f.dataset.kind = kind;
        f.setAttribute("aria-hidden", "true");
        el.appendChild(f);
      }
      return f;
    }

    function redraw(el: HTMLElement) {
      if (!el.isConnected) return;
      if (el.matches(RIGHT_LINE) || el.matches(LEFT_LINE)) {
        drawLine(el, frameOf(el, el.matches(RIGHT_LINE) ? "right" : "left"), cell);
        return;
      }
      const titled = Array.from(document.querySelectorAll(".content .card")).filter((c) => c.querySelector(":scope > .card-title"));
      drawBox(el, frameOf(el, "box"), cell, titled.indexOf(el) + 1);
    }

    function scan() {
      for (const el of document.querySelectorAll<HTMLElement>(`${BOX}, ${RIGHT_LINE}, ${LEFT_LINE}`)) {
        if (!tracked.has(el)) {
          tracked.add(el);
          el.dataset.tui = "on";
          sized.observe(el);
        }
        redraw(el);
      }
      for (const el of tracked) {
        if (!el.isConnected) {
          sized.unobserve(el);
          tracked.delete(el);
        }
      }
    }

    let queued = 0;
    const changed = new MutationObserver((records) => {
      // Our own frames changing is not a reason to redraw.
      if (records.every((r) => (r.target as Element).classList?.contains(FRAME))) return;
      if (!queued) queued = requestAnimationFrame(() => ((queued = 0), scan()));
    });
    changed.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Fonts arriving change the cell size.
    void document.fonts?.ready.then(() => {
      cell = measure();
      scan();
    });
    scan();

    return () => {
      changed.disconnect();
      sized.disconnect();
      cancelAnimationFrame(queued);
      for (const el of tracked) {
        delete el.dataset.tui;
        el.querySelector(`:scope > .${FRAME}`)?.remove();
      }
    };
  }, [on]);
}
