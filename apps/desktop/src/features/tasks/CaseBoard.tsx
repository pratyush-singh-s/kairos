import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { timeOfDay } from "@focus/core";
import { listen } from "@tauri-apps/api/event";
import { computeDeadline, formatDurationShort } from "@focus/core";
import { listBoardItems, newBoardId, saveBoardItems, type BoardItem, type CardData, type ListData, type PinData, type PinRef, type DeadlineLook, type StickyData, type StringData } from "../../ipc/boards";
import { listDeadlines, type Deadline } from "../../ipc/deadlines";
import { getNote, listNotes, type NoteSummary } from "../../ipc/notes";
import { createSpace, listSpaces, type Space } from "../../ipc/spaces";
import { listTasks, setTaskDone, type Task } from "../../ipc/tasks";
import { useUi } from "../../theme/UiProvider";
import { DeadlineRing } from "../deadlines/DeadlineRing";
import { DeadlineFocusPanel, loggedFor, useDeadlineFocus } from "./DeadlineFocus";
import { noteHtml } from "./noteHtml";
import type { Undo } from "./UndoToast";
import { between, useBoard } from "./useBoard";

type PinItem = BoardItem<PinData>;
type StickyItem = BoardItem<StickyData>;
type StringItem = BoardItem<StringData>;
type Thing = PinItem | StickyItem;

/** Card and sticky note sizes on the board, in board units (1 = 1px at 100%). */
const PIN_W = 124;
const PIN_H = 150;
const STICKY_W = 150;
const STICKY_H = 128;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const HOLD_MS = 500;

/** String colours, as in the picker. */
export const STRING_COLORS: [string, string][] = [
  ["#d63a3a", "Red"],
  ["#3a7bd6", "Blue"],
  ["#e8c547", "Yellow"],
  ["#3fae5a", "Green"],
  ["#9b4fd1", "Purple"],
  ["#f2f0e6", "White"],
  ["#1d1d1d", "Black"],
];
/** Pin colours, as in the picker ("" = the theme's accent). */
const PIN_COLORS: [string, string][] = [["", "Theme colour"], ...STRING_COLORS];
const STICKY_COLORS: [string, string][] = [
  ["#f6e27a", "Yellow"],
  ["#f4a7c0", "Pink"],
  ["#a7d3f4", "Blue"],
  ["#b9e6a1", "Green"],
  ["#f7c08a", "Orange"],
  ["#f5f3ea", "White"],
];

/** Pictures for a plain card: original line drawings on a 24 by 24 grid. */
const GLYPHS: Record<string, [string, string]> = {
  doc: ["Document", "M7 3h7l4 4v14H7zM14 3v4h4M9.5 11h6M9.5 14h6M9.5 17h4"],
  person: ["Person", "M12 4a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7M5 20c.8-4 3.6-6 7-6s6.2 2 7 6"],
  unknown: ["Unknown", "M9.2 9a2.9 2.9 0 1 1 4.3 2.5c-1 .6-1.5 1.2-1.5 2.4M12 17.2v.3"],
  place: ["Place", "M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11zM12 7.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5"],
  clock: ["Time", "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 1 1 0-17M12 7.5V12l3 2"],
  key: ["Key", "M8 9.5a4 4 0 1 1 0 .1M11.6 11.5L20 11.5M17 11.5v3M19.5 11.5v2"],
  idea: ["Idea", "M9 17h6M10 20h4M12 3.5a5.5 5.5 0 0 0-3 10.1V17h6v-3.4A5.5 5.5 0 0 0 12 3.5z"],
  bug: ["Bug", "M8.5 9.5h7v5a3.5 3.5 0 0 1-7 0zM10 9.5a2 2 0 0 1 4 0M4.5 12h4M15.5 12h4M5.5 7.5l3 2M18.5 7.5l-3 2M5.5 17.5l3-2M18.5 17.5l-3-2"],
  phone: ["Phone", "M8 3h8v18H8zM11 18h2"],
  money: ["Money", "M3.5 7h17v10h-17zM12 9.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5M6 9.5v5M18 9.5v5"],
  link: ["Link", "M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"],
  star: ["Star", "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z"],
  board: ["Board", "M3.5 4.5h17v15h-17zM9.2 4.5v15M14.8 4.5v15M5 7.5h2.7M5 10h2.7M10.7 7.5h2.6M16.3 7.5h2.7M16.3 10h2.7M16.3 12.5h2.7"],
};
const REF_GLYPH: Record<PinRef["type"], string> = { note: "doc", task: "task", deadline: "clock", board: "board" };
/** What each kind of pinned thing is called on buttons, menus and the preview. */
const REF_NAME: Record<PinRef["type"], string> = { note: "note", task: "task", deadline: "deadline", board: "free board" };

/** How a pinned deadline shows the time left, as in the picker. */
const LOOKS: [DeadlineLook, string][] = [
  ["days", "Days left"],
  ["ring", "Ring"],
  ["boxes", "Boxes"],
];
const TASK_GLYPH = "M5 5h14v14H5zM8.5 12.5l2.5 2.5 4.5-5.5";

interface View {
  x: number;
  y: number;
  z: number;
}

/** What the open preview shows. */
type Preview = { id: string; tab: "summary" | "links" };

/** Menus that pop up on the board (screen coordinates inside the board). */
type Menu =
  | { kind: "board"; sx: number; sy: number; wx: number; wy: number }
  | { kind: "item"; sx: number; sy: number; id: string }
  | { kind: "string"; sx: number; sy: number; id: string }
  | null;

const viewKey = (spaceId: string) => `focus.caseView.${spaceId}`;

function hasView(spaceId: string): boolean {
  try {
    return localStorage.getItem(viewKey(spaceId)) !== null;
  } catch {
    return false;
  }
}

function readView(spaceId: string): View {
  try {
    const v = JSON.parse(localStorage.getItem(viewKey(spaceId)) ?? "null") as View | null;
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) return v;
  } catch {
    // Only a convenience.
  }
  return { x: 40, y: 40, z: 1 };
}

/** A small steady tilt per card, so the board looks pinned by hand. */
function tilt(id: string, range: number): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 1000) / 1000 - 0.5) * 2 * range;
}

const sizeOf = (t: Thing): [number, number] => (t.kind === "sticky" ? [STICKY_W, STICKY_H] : [PIN_W, PIN_H]);
/** Where strings tie on: the pin at the top of the card. */
const anchorOf = (t: Thing, at?: { x: number; y: number }) => {
  const [w] = sizeOf(t);
  const p = at ?? t.data;
  return { x: p.x + w / 2, y: p.y + 9 };
};

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Local noon of the day `ms` falls on (noon keeps clock changes from shifting the day). */
const noonOf = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
};

/** Calendar days from today to the deadline's day: 0 on the day, negative when it has passed. */
function daysLeft(d: Deadline, now = Date.now()): number {
  return Math.round((noonOf(d.dueAt) - noonOf(now)) / 86_400_000);
}

/** What a deadline card says: a big number and the words under it. */
function daysWords(d: Deadline, now = Date.now()): { big: string; small: string } {
  if (d.completedAt) return { big: "✓", small: "done" };
  const n = daysLeft(d, now);
  if (n === 0) return { big: now > d.dueAt ? "!" : "0", small: now > d.dueAt ? "due today" : "today" };
  if (n < 0) return { big: String(-n), small: -n === 1 ? "day late" : "days late" };
  return { big: String(n), small: n === 1 ? "day left" : "days left" };
}

/**
 * A detective board: cards (your own, or showing one of your notes, tasks or deadlines) and
 * sticky notes pinned anywhere on a big board, tied together with coloured string. Drag the
 * board to look around, scroll or pinch to zoom, drag from a pin to another card to tie a string.
 */
export function CaseBoard(props: { space: Space; undo: Undo; onEditSpace: () => void; onOpenNote?: (id: string) => void; onOpenSpace?: (id: string) => void }) {
  const spaceId = props.space.id;
  const board = useBoard(spaceId);
  const linked = useLinked();
  const focus = useDeadlineFocus();
  const square = useUi().theme === "terminal";
  // Deadline cards count days, so look again now and then.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(() => readView(spaceId));
  const viewRef = useRef(view);
  viewRef.current = view;
  const [moving, setMoving] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pulling, setPulling] = useState<{ from: string; x: number; y: number; over: string | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [picking, setPicking] = useState<{ type: PinRef["type"]; wx: number; wy: number } | null>(null);

  const things = useMemo(() => board.items.filter((i) => i.kind === "pin" || i.kind === "sticky") as unknown as Thing[], [board.items]);
  const strings = useMemo(() => board.items.filter((i) => i.kind === "string") as unknown as StringItem[], [board.items]);
  const byId = useMemo(() => new Map(things.map((t) => [t.id, t])), [things]);
  const latest = useRef({ things, strings, byId });
  latest.current = { things, strings, byId };

  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(viewKey(spaceId), JSON.stringify(view));
      } catch {
        // Only a convenience.
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [spaceId, view]);

  // The first time a board is opened here (e.g. on the phone), show everything on it.
  const fitted = useRef(hasView(spaceId));
  useEffect(() => {
    if (fitted.current || !board.loaded) return;
    fitted.current = true;
    if (things.length) fit();
  }, [board.loaded]);

  const posOf = (t: Thing) => (moving?.id === t.id ? moving : t.data);

  /** Screen point (client) to board units. */
  function toWorld(cx: number, cy: number) {
    const r = rootRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
  }
  function centre() {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? toWorld(r.left + r.width / 2, r.top + r.height / 2) : { x: 0, y: 0 };
  }
  function zoomAt(cx: number, cy: number, z: number) {
    const r = rootRef.current!.getBoundingClientRect();
    setView((v) => {
      const nz = clampZoom(z);
      const px = cx - r.left;
      const py = cy - r.top;
      return { x: px - ((px - v.x) / v.z) * nz, y: py - ((py - v.y) / v.z) * nz, z: nz };
    });
  }
  function fit() {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    if (things.length === 0) return setView({ x: 40, y: 40, z: 1 });
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const t of things) {
      const [w, h] = sizeOf(t);
      x0 = Math.min(x0, t.data.x);
      y0 = Math.min(y0, t.data.y);
      x1 = Math.max(x1, t.data.x + w);
      y1 = Math.max(y1, t.data.y + h);
    }
    const pad = 48;
    const z = clampZoom(Math.min(1.4, (r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0)));
    setView({ x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z, z });
  }
  function lookAt(id: string) {
    const t = byId.get(id);
    const r = rootRef.current?.getBoundingClientRect();
    if (!t || !r) return;
    const [w, h] = sizeOf(t);
    setView((v) => ({ ...v, x: r.width / 2 - (t.data.x + w / 2) * v.z, y: r.height / 2 - (t.data.y + h / 2) * v.z }));
    setSelected(id);
  }

  // Wheel zooms around the cursor (a touchpad pinch arrives as a wheel with Ctrl).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".case-preview, .case-menu")) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      zoomAt(e.clientX, e.clientY, viewRef.current.z * factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // Delete removes the chosen card; Escape closes things.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable='true']");
      if (e.key === "Escape") {
        setMenu(null);
        if (!typing) setPreview(null);
      }
      if (!typing && selected && (e.key === "Delete" || e.key === "Backspace") && !preview) {
        e.preventDefault();
        void removeThing(selected);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // ---- making and changing things

  function addPin(at: { x: number; y: number }, data: Partial<PinData> = {}) {
    const id = newBoardId();
    board.put([{ id, kind: "pin", data: { title: "New card", icon: "doc", ...data, x: Math.round(at.x - PIN_W / 2), y: Math.round(at.y - 20) } }]);
    setSelected(id);
    if (!data.ref) setPreview({ id, tab: "summary" });
  }
  function addSticky(at: { x: number; y: number }) {
    const id = newBoardId();
    board.put([{ id, kind: "sticky", data: { text: "", color: STICKY_COLORS[0]![0], x: Math.round(at.x - STICKY_W / 2), y: Math.round(at.y - 20) } }]);
    setSelected(id);
    setPreview({ id, tab: "summary" });
  }
  function tie(from: string, to: string) {
    if (from === to) return;
    const exists = latest.current.strings.some((s) => (s.data.from === from && s.data.to === to) || (s.data.from === to && s.data.to === from));
    if (!exists) board.put([{ id: newBoardId(), kind: "string", data: { from, to, color: STRING_COLORS[0]![0] } }]);
  }
  async function removeThing(id: string) {
    const t = byId.get(id);
    const gone = await board.remove([id]);
    setSelected(null);
    setPreview(null);
    if (gone.length) props.undo.offer(`Took "${t ? titleOf(t, linked) : "it"}" off the board.`, () => void board.restore(gone));
  }
  async function cut(id: string) {
    const gone = await board.remove([id]);
    if (gone.length) props.undo.offer("Cut the string.", () => void board.restore(gone));
  }

  // ---- the pointer: pan, pinch, move a card, pull a string, hold for the menu

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; z: number } | null>(null);
  const lastTap = useRef<{ id: string; at: number } | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.closest(".case-preview, .case-menu, .case-tools")) return;
    // Mouse: left drag works on what is under it; middle drag, or Alt + left drag (mouse or pen), always pans.
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    const panOnly = (e.pointerType === "mouse" && e.button === 1) || (e.pointerType !== "touch" && e.altKey);
    if (panOnly) e.preventDefault();
    setMenu(null);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two fingers: pinch to zoom (whatever the first finger was doing stops).
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), z: viewRef.current.z };
      setMoving(null);
      setPulling(null);
      return;
    }

    const root = rootRef.current!;
    const startX = e.clientX;
    const startY = e.clientY;
    const head = target.closest<HTMLElement>("[data-pin-head]");
    const itemEl = target.closest<HTMLElement>("[data-item-id]");
    const id = itemEl?.dataset.itemId;
    const thing = id ? latest.current.byId.get(id) : undefined;
    const mode: "pull" | "move" | "pan" = panOnly ? "pan" : head && thing ? "pull" : thing ? "move" : "pan";
    const v0 = viewRef.current;
    let moved = false;
    let menuTimer: number | undefined;
    if (mode === "pan" && !panOnly && e.pointerType !== "mouse") {
      menuTimer = window.setTimeout(() => {
        if (moved) return;
        const r = root.getBoundingClientRect();
        const w = toWorld(startX, startY);
        navigator.vibrate?.(12);
        setMenu({ kind: "board", sx: startX - r.left, sy: startY - r.top, wx: w.x, wy: w.y });
        stop();
      }, HOLD_MS);
    }
    if (mode !== "pan") board.hold(true);

    const move = (ev: PointerEvent) => {
      if (!pointers.current.has(ev.pointerId)) return;
      pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch.current && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, (pinch.current.z * dist) / Math.max(1, pinch.current.dist));
        moved = true;
        return;
      }
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      window.clearTimeout(menuTimer);
      if (mode === "pan") {
        setView({ ...v0, x: v0.x + dx, y: v0.y + dy });
      } else if (mode === "move" && thing) {
        setMoving({ id: thing.id, x: Math.round(thing.data.x + dx / v0.z), y: Math.round(thing.data.y + dy / v0.z) });
      } else if (mode === "pull" && thing) {
        const w = toWorld(ev.clientX, ev.clientY);
        const over = document.elementsFromPoint(ev.clientX, ev.clientY).map((n) => n.closest<HTMLElement>("[data-item-id]")?.dataset.itemId).find((x) => x && x !== thing.id);
        setPulling({ from: thing.id, x: w.x, y: w.y, over: over ?? null });
      }
    };
    const up = (ev: PointerEvent) => {
      pointers.current.delete(ev.pointerId);
      if (pinch.current) {
        if (pointers.current.size === 0) {
          pinch.current = null;
          stop();
        }
        return;
      }
      if (ev.pointerId !== e.pointerId) return;
      stop();
      if (!moved) {
        if (panOnly) return; // a middle or Alt click does nothing
        if (thing) {
          // A second click (or a tap on the chosen card) opens it. While a preview is open,
          // one click on another card shows that card instead.
          const now = Date.now();
          const again = lastTap.current?.id === thing.id && now - lastTap.current.at < 450;
          if (again || selected === thing.id || preview) setPreview({ id: thing.id, tab: "summary" });
          lastTap.current = { id: thing.id, at: now };
          setSelected(thing.id);
        } else {
          // A click on empty board closes the open card.
          setSelected(null);
          setPreview(null);
        }
        return;
      }
      if (mode === "move" && thing) {
        const dx = (ev.clientX - startX) / v0.z;
        const dy = (ev.clientY - startY) / v0.z;
        board.put([{ id: thing.id, kind: thing.kind, data: { ...thing.data, x: Math.round(thing.data.x + dx), y: Math.round(thing.data.y + dy) } }]);
        setMoving(null);
      } else if (mode === "pull" && thing) {
        const over = document.elementsFromPoint(ev.clientX, ev.clientY).map((n) => n.closest<HTMLElement>("[data-item-id]")?.dataset.itemId).find((x) => x && x !== thing.id);
        if (over) tie(thing.id, over);
        setPulling(null);
      }
    };
    const cancel = (ev: PointerEvent) => {
      pointers.current.delete(ev.pointerId);
      stop();
      setMoving(null);
      setPulling(null);
    };
    function stop() {
      window.clearTimeout(menuTimer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      board.hold(false);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  function onContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest(".case-preview, .case-menu, .case-tools")) return;
    e.preventDefault();
    const r = rootRef.current!.getBoundingClientRect();
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-item-id]")?.dataset.itemId;
    const sid = (e.target as Element).closest<SVGElement>("[data-string-id]")?.dataset.stringId;
    if (sid) return setMenu({ kind: "string", sx: e.clientX - r.left, sy: e.clientY - r.top, id: sid });
    if (id) {
      setSelected(id);
      return setMenu({ kind: "item", sx: e.clientX - r.left, sy: e.clientY - r.top, id });
    }
    const w = toWorld(e.clientX, e.clientY);
    setMenu({ kind: "board", sx: e.clientX - r.left, sy: e.clientY - r.top, wx: w.x, wy: w.y });
  }

  // ---- drawing

  const worldStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` };
  const previewed = preview ? byId.get(preview.id) : undefined;
  // The preview eases out when it closes: keep the last one on screen for the length of the animation.
  const lastPreviewed = useRef<Thing | undefined>(undefined);
  const [closing, setClosing] = useState<Thing | null>(null);
  if (previewed) lastPreviewed.current = previewed;
  const previewOpen = !!previewed;
  useEffect(() => {
    if (previewOpen) {
      setClosing(null);
      return;
    }
    const last = lastPreviewed.current;
    if (!last) return;
    lastPreviewed.current = undefined;
    setClosing(last);
    const t = window.setTimeout(() => setClosing(null), 200);
    return () => window.clearTimeout(t);
  }, [previewOpen]);

  return (
    <>
      <div className="board-toolbar case-toolbar">
        <button type="button" className="button small-button" onClick={() => addPin(centre())}>
          + Card
        </button>
        <button type="button" className="button small-button" onClick={() => addSticky(centre())}>
          + Sticky note
        </button>
        <span className="case-toolbar-group" role="group" aria-label="Pin something of yours">
          <span className="muted small">Pin a</span>
          {(["note", "task", "deadline", "board"] as const).map((type) => (
            <button key={type} type="button" className="button small-button" onClick={() => {
                const c = centre();
                setPicking({ type, wx: c.x, wy: c.y });
              }}>
              {REF_NAME[type]}
            </button>
          ))}
        </span>
        <span className="push-right" />
        <button type="button" className="button small-button" onClick={props.onEditSpace}>
          Edit space
        </button>
      </div>
      {board.error && (
        <p className="error" role="alert">
          {board.error}
        </p>
      )}

      <div
        ref={rootRef}
        className="case-board"
        data-no-swipe="true"
        data-panning={moving || pulling ? "true" : undefined}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        role="application"
        aria-label={`${props.space.name}: detective board`}
      >
        <div className="case-world" style={worldStyle}>
          <svg className="case-strings" aria-hidden="false">
            {strings.map((s) => {
              const a = byId.get(s.data.from);
              const b = byId.get(s.data.to);
              if (!a || !b) return null;
              return (
                <StringLine
                  key={s.id}
                  id={s.id}
                  from={anchorOf(a, posOf(a))}
                  to={anchorOf(b, posOf(b))}
                  color={s.data.color ?? STRING_COLORS[0]![0]}
                  square={square}
                  onPick={(cx, cy) => {
                    const r = rootRef.current!.getBoundingClientRect();
                    setMenu({ kind: "string", sx: cx - r.left, sy: cy - r.top, id: s.id });
                  }}
                />
              );
            })}
            {pulling &&
              (() => {
                const a = byId.get(pulling.from);
                if (!a) return null;
                const p = anchorOf(a);
                const end = pulling.over && byId.get(pulling.over) ? anchorOf(byId.get(pulling.over)!) : pulling;
                return <path className="case-string-pull" d={square ? elbow(p, end) : sag(p, end)} />;
              })()}
          </svg>
          {things.map((t) =>
            t.kind === "sticky" ? (
              <StickyNote key={t.id} item={t as StickyItem} at={posOf(t)} selected={selected === t.id} lifted={moving?.id === t.id} target={pulling?.over === t.id} />
            ) : (
              <PinCard key={t.id} item={t as PinItem} at={posOf(t)} linked={linked} focus={focus} selected={selected === t.id} lifted={moving?.id === t.id} target={pulling?.over === t.id} />
            ),
          )}
        </div>

        {board.loaded && things.length === 0 && (
          <div className="case-empty">
            <p>Nothing on this board yet</p>
            <p className="small">Right-click (or press and hold) anywhere to add a card or a sticky note, or pin a note, task or deadline.</p>
          </div>
        )}

        <div className="case-tools" role="group" aria-label="Zoom">
          <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAround(0.8)}>
            −
          </button>
          <span className="num small">{Math.round(view.z * 100)}%</span>
          <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAround(1.25)}>
            +
          </button>
          <button type="button" className="icon-button" aria-label="Show everything" title="Show everything" onClick={fit}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />
            </svg>
          </button>
        </div>
        <p className="case-hint small" aria-hidden="true">
          Drag from a pin to another card to connect them · click a line to change its colour
        </p>

        {menu && (
          <BoardMenu
            menu={menu}
            onClose={() => setMenu(null)}
            onCard={(at) => addPin(at)}
            onSticky={(at) => addSticky(at)}
            onPick={(type, at) => setPicking({ type, wx: at.x, wy: at.y })}
            onOpen={(id) => setPreview({ id, tab: "summary" })}
            onRemove={(id) => void removeThing(id)}
            stringColor={menu.kind === "string" ? strings.find((s) => s.id === menu.id)?.data.color ?? STRING_COLORS[0]![0] : undefined}
            onRecolor={(color) => {
              if (menu.kind !== "string") return;
              const s = strings.find((x) => x.id === menu.id);
              if (s) board.put([{ id: s.id, kind: "string", data: { ...s.data, color } }]);
              setMenu(null);
            }}
            onCut={() => {
              if (menu.kind === "string") void cut(menu.id);
              setMenu(null);
            }}
            pinColor={menu.kind === "item" ? byId.get(menu.id)?.data.pin : undefined}
            onPinColor={(id, pin) => {
              const t = byId.get(id);
              if (t) board.put([{ id: t.id, kind: t.kind, data: { ...t.data, pin } }]);
            }}
          />
        )}

        {previewed && preview && (
          <CasePreview
            key={previewed.id}
            item={previewed}
            focus={focus}
            tab={preview.tab}
            onTab={(tab) => setPreview({ ...preview, tab })}
            linked={linked}
            connections={strings
              .filter((s) => s.data.from === previewed.id || s.data.to === previewed.id)
              .map((s) => ({ string: s, other: byId.get(s.data.from === previewed.id ? s.data.to : s.data.from) }))
              .filter((c): c is { string: StringItem; other: Thing } => !!c.other)}
            onGo={(id) => {
              lookAt(id);
              setPreview({ id, tab: "summary" });
            }}
            onSave={(data) => board.put([{ id: previewed.id, kind: previewed.kind, data: { ...previewed.data, ...data } }])}
            onRemove={() => void removeThing(previewed.id)}
            onOpenSpace={props.onOpenSpace}
            onOpenNote={props.onOpenNote}
            onClose={() => setPreview(null)}
          />
        )}
        {!previewed && closing && (
          <CasePreview
            key={`closing-${closing.id}`}
            closing
            item={closing}
            focus={focus}
            tab="summary"
            onTab={() => {}}
            linked={linked}
            connections={[]}
            onGo={() => {}}
            onSave={() => {}}
            onRemove={() => {}}
            onClose={() => {}}
          />
        )}
      </div>

      {picking && (
        <PinPicker
          type={picking.type}
          linked={linked}
          onPick={(ref, title) => {
            addPin({ x: picking.wx, y: picking.wy }, { ref, title, icon: REF_GLYPH[ref.type] });
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );

  function zoomAround(f: number) {
    const r = rootRef.current?.getBoundingClientRect();
    if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, viewRef.current.z * f);
  }
}

// ---------------------------------------------------------------- your notes, tasks and deadlines

interface Linked {
  notes: Map<string, NoteSummary>;
  tasks: Map<string, Task>;
  deadlines: Map<string, Deadline>;
  /** Your free boards (spaces of kind "free"). */
  boards: Map<string, Space>;
  boardsLoaded: boolean;
  reload: () => void;
}

/** Your notes, tasks and deadlines, kept fresh, so pinned cards show their current titles. */
function useLinked(): Linked {
  const [notes, setNotes] = useState(new Map<string, NoteSummary>());
  const [tasks, setTasks] = useState(new Map<string, Task>());
  const [deadlines, setDeadlines] = useState(new Map<string, Deadline>());
  const [boards, setBoards] = useState(new Map<string, Space>());
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const reload = useMemo(
    () => () => {
      listNotes("")
        .then((l) => setNotes(new Map(l.map((n) => [n.id, n]))))
        .catch(() => {});
      listTasks()
        .then((l) => setTasks(new Map(l.map((t) => [t.id, t]))))
        .catch(() => {});
      listDeadlines()
        .then((l) => setDeadlines(new Map(l.map((d) => [d.id, d]))))
        .catch(() => {});
      listSpaces()
        .then((l) => {
          setBoards(new Map(l.filter((sp) => sp.kind === "free").map((sp) => [sp.id, sp])));
          setBoardsLoaded(true);
        })
        .catch(() => {});
    },
    [],
  );
  useEffect(() => {
    reload();
    const offs: (() => void)[] = [];
    let gone = false;
    for (const ev of ["notes-changed", "tasks-changed", "deadlines-changed"]) {
      listen(ev, reload)
        .then((un) => (gone ? un() : offs.push(un)))
        .catch(() => {});
    }
    return () => {
      gone = true;
      offs.forEach((f) => f());
    };
  }, [reload]);
  return { notes, tasks, deadlines, boards, boardsLoaded, reload };
}

function titleOf(t: Thing, linked: Linked): string {
  if (t.kind === "sticky") return (t as StickyItem).data.text.split("\n")[0]?.slice(0, 40) || "Sticky note";
  const d = (t as PinItem).data;
  const ref = d.ref;
  if (ref?.type === "note") return linked.notes.get(ref.id)?.title || d.title || "Untitled note";
  if (ref?.type === "task") return linked.tasks.get(ref.id)?.title ?? d.title;
  if (ref?.type === "deadline") return linked.deadlines.get(ref.id)?.title ?? d.title;
  if (ref?.type === "board") return linked.boards.get(ref.id)?.name ?? d.title;
  return d.title || "Card";
}

/** True when the pinned note, task, deadline or free board was deleted. */
function refGone(d: PinData, linked: Linked): boolean {
  const ref = d.ref;
  if (!ref) return false;
  const m: Map<string, unknown> =
    ref.type === "note" ? linked.notes : ref.type === "task" ? linked.tasks : ref.type === "board" ? linked.boards : linked.deadlines;
  // A free board's map can be empty when the last one was deleted, so it counts as gone then too.
  return (m.size > 0 || ref.type === "board") && !m.has(ref.id) && (ref.type !== "board" || linked.boardsLoaded);
}

// ---------------------------------------------------------------- pieces on the board

function Glyph(props: { name: string }) {
  const d = props.name === "task" ? TASK_GLYPH : (GLYPHS[props.name] ?? GLYPHS.doc!)[1];
  return (
    <svg viewBox="0 0 24 24" className="case-glyph" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function PinHead(props: { color?: string | null }) {
  return (
    <span className="case-pin" data-pin-head="true" title="Drag onto another card to tie a string" style={props.color ? { ["--pin" as string]: props.color } : undefined}>
      <span className="case-pin-head" />
    </span>
  );
}

/** A row of pin colours to pick from. */
function PinColors(props: { color?: string | null; onPick: (color: string | null) => void }) {
  return (
    <div className="case-swatches case-pin-colors" role="radiogroup" aria-label="Pin colour">
      {PIN_COLORS.map(([c, name]) => (
        <button
          key={c || "theme"}
          type="button"
          role="radio"
          aria-checked={(props.color || "") === c}
          aria-label={name}
          title={name}
          className="case-swatch"
          data-theme-pin={c ? undefined : "true"}
          style={c ? { background: c } : undefined}
          onClick={() => props.onPick(c || null)}
        />
      ))}
    </div>
  );
}

function PinCard(props: { item: PinItem; at: { x: number; y: number }; linked: Linked; focus: DeadlineFocusHook; selected: boolean; lifted: boolean; target: boolean }) {
  const d = props.item.data;
  const ref = d.ref ?? null;
  const task = ref?.type === "task" ? props.linked.tasks.get(ref.id) : undefined;
  const deadline = ref?.type === "deadline" ? props.linked.deadlines.get(ref.id) : undefined;
  const freeBoard = ref?.type === "board" ? props.linked.boards.get(ref.id) : undefined;
  const tint = task?.color ?? deadline?.color ?? freeBoard?.color ?? null;
  const gone = refGone(d, props.linked);
  const days = deadline ? daysWords(deadline) : null;
  const logged = deadline ? loggedFor(props.focus.state, deadline.id) : null;
  const focusing = deadline !== undefined && props.focus.state.active?.deadlineId === deadline.id;
  return (
    <div
      className="case-card"
      data-item-id={props.item.id}
      data-ref={ref?.type}
      data-selected={props.selected}
      data-lifted={props.lifted}
      data-target={props.target}
      data-gone={gone ? "true" : undefined}
      data-done={task?.done || deadline?.completedAt ? "true" : undefined}
      data-look={deadline ? (d.look ?? "days") : undefined}
      data-late={deadline && !deadline.completedAt && Date.now() > deadline.dueAt ? "true" : undefined}
      style={{ left: props.at.x, top: props.at.y, ["--tilt" as string]: `${tilt(props.item.id, 2.2)}deg`, ...(tint ? { ["--pic" as string]: tint } : {}) }}
    >
      <PinHead color={d.pin} />
      <span className="case-card-pic">
        {deadline && days ? (
          <DeadlinePic deadline={deadline} look={d.look ?? "days"} days={days} />
        ) : freeBoard ? (
          <FreeBoardPic spaceId={freeBoard.id} />
        ) : (
          <Glyph name={ref ? (ref.type === "task" ? "task" : REF_GLYPH[ref.type]) : (d.icon ?? "doc")} />
        )}
      </span>
      {(focusing || logged) && (
        <span className="case-card-focus" data-running={focusing ? "true" : undefined} title={focusing ? "Focusing on this now" : "Focus logged on this deadline"}>
          {focusing ? "Focusing" : formatDurationShort(logged!.seconds)}
        </span>
      )}
      <span className="case-card-caption">{titleOf(props.item, props.linked)}</span>
    </div>
  );
}

function StickyNote(props: { item: StickyItem; at: { x: number; y: number }; selected: boolean; lifted: boolean; target: boolean }) {
  const d = props.item.data;
  return (
    <div
      className="case-sticky"
      data-item-id={props.item.id}
      data-selected={props.selected}
      data-lifted={props.lifted}
      data-target={props.target}
      style={{ left: props.at.x, top: props.at.y, ["--tilt" as string]: `${tilt(props.item.id, 3)}deg`, ["--sticky" as string]: d.color ?? STICKY_COLORS[0]![0] }}
    >
      <PinHead color={d.pin} />
      <span className="case-sticky-text">{d.text || <span className="case-sticky-empty">empty</span>}</span>
    </div>
  );
}

/** A string between two pins, hanging a little like real string. */
function sag(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 + Math.min(40, Math.hypot(b.x - a.x, b.y - a.y) * 0.08);
  return `M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}`;
}

/**
 * The terminal theme's string: only straight horizontal and vertical runs. It rises from the
 * first pin, runs across above both cards, and drops onto the second pin.
 */
function elbow(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const top = Math.round(Math.min(a.y, b.y) - 22);
  return `M${a.x} ${a.y} V${top} H${b.x} V${b.y}`;
}

function StringLine(props: { id: string; from: { x: number; y: number }; to: { x: number; y: number }; color: string; square: boolean; onPick: (cx: number, cy: number) => void }) {
  const d = props.square ? elbow(props.from, props.to) : sag(props.from, props.to);
  return (
    <g className="case-string" data-string-id={props.id} style={{ ["--string" as string]: props.color }}>
      <path className="case-string-shadow" d={d} />
      <path className="case-string-line" d={d} />
      <path
        className="case-string-hit"
        d={d}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          props.onPick(e.clientX, e.clientY);
        }}
      />
    </g>
  );
}

// ---------------------------------------------------------------- menus

function BoardMenu(props: {
  menu: NonNullable<Menu>;
  onClose: () => void;
  onCard: (at: { x: number; y: number }) => void;
  onSticky: (at: { x: number; y: number }) => void;
  onPick: (type: PinRef["type"], at: { x: number; y: number }) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  stringColor?: string;
  onRecolor: (color: string) => void;
  onCut: () => void;
  pinColor?: string | null;
  onPinColor: (id: string, color: string | null) => void;
}) {
  const m = props.menu;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: m.sx, top: m.sy });
  // Keep the menu inside the board.
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    setPos({ left: Math.max(6, Math.min(m.sx, parent.clientWidth - el.offsetWidth - 6)), top: Math.max(6, Math.min(m.sy, parent.clientHeight - el.offsetHeight - 6)) });
  }, [m.sx, m.sy]);
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && props.onClose();
    const t = window.setTimeout(() => document.addEventListener("pointerdown", away), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", away);
    };
  });

  const run = (f: () => void) => () => {
    f();
    props.onClose();
  };
  let body: ReactNode;
  if (m.kind === "board") {
    const at = { x: m.wx, y: m.wy };
    body = (
      <>
        <button type="button" role="menuitem" onClick={run(() => props.onCard(at))}>
          Card
        </button>
        <button type="button" role="menuitem" onClick={run(() => props.onSticky(at))}>
          Sticky note
        </button>
        <hr />
        <button type="button" role="menuitem" onClick={run(() => props.onPick("note", at))}>
          Pin a note…
        </button>
        <button type="button" role="menuitem" onClick={run(() => props.onPick("task", at))}>
          Pin a task…
        </button>
        <button type="button" role="menuitem" onClick={run(() => props.onPick("deadline", at))}>
          Pin a deadline…
        </button>
        <button type="button" role="menuitem" onClick={run(() => props.onPick("board", at))}>
          Pin a free board…
        </button>
      </>
    );
  } else if (m.kind === "item") {
    body = (
      <>
        <button type="button" role="menuitem" onClick={run(() => props.onOpen(m.id))}>
          Open
        </button>
        <span className="case-menu-label">Pin colour</span>
        <PinColors color={props.pinColor} onPick={(c) => run(() => props.onPinColor(m.id, c))()} />
        <hr />
        <button type="button" role="menuitem" className="danger-text" onClick={run(() => props.onRemove(m.id))}>
          Take off the board
        </button>
      </>
    );
  } else {
    body = (
      <>
        <div className="case-swatches" role="radiogroup" aria-label="String colour">
          {STRING_COLORS.map(([c, name]) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={props.stringColor === c}
              aria-label={name}
              title={name}
              className="case-swatch case-swatch-wide"
              style={{ background: c }}
              onClick={() => props.onRecolor(c)}
            />
          ))}
        </div>
        <button type="button" role="menuitem" className="danger-text" onClick={props.onCut}>
          Cut string
        </button>
      </>
    );
  }
  return (
    <div ref={ref} className="case-menu card" role="menu" style={pos} data-kind={m.kind}>
      {body}
    </div>
  );
}

function PinPicker(props: { type: PinRef["type"]; linked: Linked; onPick: (ref: PinRef, title: string) => void; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);
  const q = search.trim().toLowerCase();
  const rows: { id: string; title: string; sub: string }[] =
    props.type === "note"
      ? [...props.linked.notes.values()].map((n) => ({ id: n.id, title: n.title || "Untitled", sub: n.preview }))
      : props.type === "task"
        ? [...props.linked.tasks.values()].map((t) => ({ id: t.id, title: t.title, sub: [t.dueDate, t.category].filter(Boolean).join(" · ") }))
        : props.type === "deadline"
          ? [...props.linked.deadlines.values()].map((d) => ({ id: d.id, title: d.title, sub: new Date(d.dueAt).toLocaleDateString() }))
          : [...props.linked.boards.values()].map((sp) => ({ id: sp.id, title: sp.name, sub: "" }));
  const name = REF_NAME[props.type];
  /** Free boards only: makes a new free board named after the search box and pins it. */
  async function makeBoard() {
    const title = search.trim() || "Free board";
    setMaking(true);
    setError(null);
    try {
      const sp = await createSpace({ name: title, kind: "free", color: null, startDate: null, days: 7 });
      props.linked.reload();
      props.onPick({ type: "board", id: sp.id }, sp.name);
    } catch (e) {
      setError(String(e));
      setMaking(false);
    }
  }
  const shown = rows.filter((r) => !q || r.title.toLowerCase().includes(q) || r.sub.toLowerCase().includes(q)).slice(0, 200);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal card case-picker" role="dialog" aria-modal="true" aria-label={`Pin a ${name}`}>
        <h2 className="card-title">
          <span className="card-title-text">Pin a {name}</span>
        </h2>
        <input
          className="task-title-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && props.type === "board" && shown.length === 0 && !making) void makeBoard();
          }}
          placeholder={props.type === "board" ? "Search, or name a new free board" : "Search"}
          autoFocus
          aria-label="Search"
        />
        <ul className="case-picker-list">
          {props.type === "board" && (
            <li>
              <button type="button" className="case-picker-new" disabled={making} onClick={() => void makeBoard()}>
                <strong>+ New free board{search.trim() ? `: ${search.trim()}` : ""}</strong>
                <span className="muted small">Makes a new free board (lists of cards) and pins it here.</span>
              </button>
            </li>
          )}
          {shown.length === 0 && props.type !== "board" && <li className="muted small">Nothing here yet.</li>}
          {shown.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => props.onPick({ type: props.type, id: r.id }, r.title)}>
                <strong>{r.title}</strong>
                {r.sub && <span className="muted small">{r.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the preview

const dateOnlyShort = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const dateTime = { format: (d: Date) => `${dateOnlyShort.format(d)}, ${timeOfDay(d)}` };
const dateOnly = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

type DeadlineFocusHook = ReturnType<typeof useDeadlineFocus>;

function CasePreview(props: {
  item: Thing;
  focus: DeadlineFocusHook;
  tab: Preview["tab"];
  onTab: (tab: Preview["tab"]) => void;
  linked: Linked;
  connections: { string: StringItem; other: Thing }[];
  onGo: (id: string) => void;
  onSave: (data: Partial<PinData & StickyData>) => void;
  onRemove: () => void;
  onOpenNote?: (id: string) => void;
  onOpenSpace?: (id: string) => void;
  onClose: () => void;
  /** Drawn only while it eases out after closing. */
  closing?: boolean;
}) {
  const t = props.item;
  const isSticky = t.kind === "sticky";
  const pin = isSticky ? null : (t as PinItem).data;
  const ref = pin?.ref ?? null;
  const kindLabel = isSticky ? "Sticky note" : ref ? { note: "Note", task: "Task", deadline: "Deadline", board: "Free board" }[ref.type] : "Card";
  const glyph = isSticky ? "doc" : ref ? (ref.type === "task" ? "task" : REF_GLYPH[ref.type]) : (pin?.icon ?? "doc");

  return (
    <aside
      className="case-preview"
      aria-label={`${kindLabel}: ${titleOf(t, props.linked)}`}
      aria-hidden={props.closing || undefined}
      inert={props.closing || undefined}
      data-closing={props.closing || undefined}
      data-sticky={isSticky ? "true" : undefined}
    >
      <span className="case-pin case-preview-pin" aria-hidden="true">
        <span className="case-pin-head" />
      </span>
      <header className="case-preview-head">
        <Glyph name={glyph} />
        <span className="case-preview-kind">{kindLabel}</span>
        <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={props.onClose}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </header>
      <div className="case-preview-body">
        <div className="case-paper" style={isSticky ? { ["--sticky" as string]: (t as StickyItem).data.color ?? STICKY_COLORS[0]![0] } : undefined}>
          {props.tab === "summary" ? (
            isSticky ? (
              <StickyEditor item={t as StickyItem} onSave={props.onSave} />
            ) : (
              <>
                {ref ? <RefSummary pin={pin!} linked={props.linked} onOpenNote={props.onOpenNote} onOpenSpace={props.onOpenSpace} /> : <CardEditor pin={pin!} onSave={props.onSave} />}
                {ref?.type === "deadline" && !refGone(pin!, props.linked) && (
                  <DeadlineFocusPanel deadlineId={ref.id} done={props.linked.deadlines.get(ref.id)?.completedAt != null} focus={props.focus} />
                )}
                {ref?.type === "deadline" && <LookPicker look={pin!.look ?? "days"} onPick={(look) => props.onSave({ look })} />}
              </>
            )
          ) : (
            <Connections connections={props.connections} linked={props.linked} onGo={props.onGo} />
          )}
        </div>
        <nav className="case-tabs" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={props.tab === "summary"} onClick={() => props.onTab("summary")}>
            Summary
          </button>
          <button type="button" role="tab" aria-selected={props.tab === "links"} onClick={() => props.onTab("links")}>
            Links <span className="num">{props.connections.length}</span>
          </button>
        </nav>
      </div>
      <footer className="case-preview-foot">
        <span className="case-preview-pincolor">
          <span className="muted small">Pin</span>
          <PinColors color={t.data.pin} onPick={(pin) => props.onSave({ pin })} />
        </span>
        <button type="button" className="link-button small danger-text" onClick={props.onRemove}>
          Take off the board
        </button>
      </footer>
    </aside>
  );
}

/** Runs the newest `save` when the preview closes (Escape or another card), which skips the blur. */
function useSaveOnClose(save: () => void) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => () => latest.current(), []);
}

function CardEditor(props: { pin: PinData; onSave: (d: Partial<PinData>) => void }) {
  const [title, setTitle] = useState(props.pin.title);
  const [text, setText] = useState(props.pin.text ?? "");
  const save = () => {
    if (title.trim() !== props.pin.title || text !== (props.pin.text ?? "")) props.onSave({ title: title.trim() || "Card", text });
  };
  useSaveOnClose(save);
  return (
    <div className="case-card-editor">
      <input
        className="case-paper-title"
        value={title}
        maxLength={80}
        aria-label="Card title"
        autoFocus={props.pin.title === "New card"}
        onFocus={(e) => props.pin.title === "New card" && e.currentTarget.select()}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <textarea className="case-paper-text" value={text} rows={7} placeholder="What do you know about it?" maxLength={20000} onChange={(e) => setText(e.target.value)} onBlur={save} />
      <div className="case-glyphs" role="radiogroup" aria-label="Picture">
        {Object.entries(GLYPHS).map(([id, [name]]) => (
          <button key={id} type="button" role="radio" aria-checked={(props.pin.icon ?? "doc") === id} aria-label={name} title={name} onClick={() => props.onSave({ icon: id })}>
            <Glyph name={id} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Small drawings of each look for the picker. */
const LOOK_ICON: Record<DeadlineLook, ReactNode> = {
  days: <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" stroke="none" fill="currentColor">12</text>,
  ring: (
    <>
      <circle cx="12" cy="12" r="8" opacity="0.35" />
      <path d="M12 4a8 8 0 0 1 8 8" />
    </>
  ),
  boxes: <path d="M4 6h4v4H4zM10 6h4v4h-4zM16 6h4v4h-4zM4 14h4v4H4zM10 14h4v4h-4zM16 14h4v4h-4z" />,
};

function LookPicker(props: { look: DeadlineLook; onPick: (look: DeadlineLook) => void }) {
  return (
    <div className="case-looks" role="radiogroup" aria-label="Show time left as">
      <span className="case-looks-label">Show as</span>
      {LOOKS.map(([id, name]) => (
        <button key={id} type="button" role="radio" aria-checked={props.look === id} title={name} onClick={() => props.onPick(id)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {LOOK_ICON[id]}
          </svg>
          <span>{name}</span>
        </button>
      ))}
    </div>
  );
}

/** A pinned deadline's picture: the days left as a number, a ring, or a box per day. */
function DeadlinePic(props: { deadline: Deadline; look: DeadlineLook; days: { big: string; small: string } }) {
  const d = props.deadline;
  const tip = `Due ${dateTime.format(new Date(d.dueAt))}`;
  if (props.look === "days") {
    return (
      <span className="case-card-days" title={tip}>
        <span className="case-card-days-num num">{props.days.big}</span>
        <span className="case-card-days-word">{props.days.small}</span>
      </span>
    );
  }
  const v = computeDeadline(d, Date.now());
  if (props.look === "ring") {
    return (
      <span className="case-card-ring" title={tip}>
        <DeadlineRing view={v} size={84} color={d.color}>
          <span className="case-card-ring-num num">{props.days.big}</span>
          <span className="case-card-ring-word">{props.days.small.replace(/^day(s)? /, "")}</span>
        </DeadlineRing>
      </span>
    );
  }
  // Boxes as big as fit in the picture (about 104 by 84), one per day (or per week when long).
  const n = Math.max(1, v.cells.length);
  const size = Math.max(4, Math.min(14, Math.floor(Math.sqrt((100 * 80) / n)) - 3));
  return (
    <span className="case-card-boxes" title={`${tip} · ${props.days.big} ${props.days.small}`} style={{ ["--cell" as string]: `${size}px`, ...(d.color ? { ["--dl-color" as string]: d.color } : {}) }}>
      {v.cells.map((c) => (
        <span key={c.dayIndex} data-kind={c.kind} data-due={c.isDueDay} />
      ))}
    </span>
  );
}

function StickyEditor(props: { item: StickyItem; onSave: (d: Partial<StickyData>) => void }) {
  const [text, setText] = useState(props.item.data.text);
  useSaveOnClose(() => text !== props.item.data.text && props.onSave({ text }));
  return (
    <div className="case-card-editor">
      <textarea
        className="case-paper-text case-sticky-input"
        value={text}
        rows={8}
        autoFocus={!props.item.data.text}
        placeholder="Write a thought, a lead, a question…"
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== props.item.data.text && props.onSave({ text })}
      />
      <div className="case-swatches" role="radiogroup" aria-label="Sticky note colour">
        {STICKY_COLORS.map(([c, name]) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={(props.item.data.color ?? STICKY_COLORS[0]![0]) === c}
            aria-label={name}
            title={name}
            className="case-swatch"
            style={{ background: c }}
            onClick={() => props.onSave({ color: c, text })}
          />
        ))}
      </div>
    </div>
  );
}

function RefSummary(props: { pin: PinData; linked: Linked; onOpenNote?: (id: string) => void; onOpenSpace?: (id: string) => void }) {
  const ref = props.pin.ref!;
  if (refGone(props.pin, props.linked)) {
    return (
      <div className="case-ref">
        <h3 className="case-paper-heading">{props.pin.title}</h3>
        <p className="case-paper-muted">This {REF_NAME[ref.type]} was deleted. The card keeps its name.</p>
      </div>
    );
  }
  if (ref.type === "note") return <NoteSummaryView id={ref.id} fallback={props.pin.title} onOpenNote={props.onOpenNote} />;
  if (ref.type === "board") {
    const sp = props.linked.boards.get(ref.id);
    return <FreeBoardSummary spaceId={ref.id} name={sp?.name ?? props.pin.title} onOpenSpace={props.onOpenSpace} />;
  }
  if (ref.type === "task") {
    const t = props.linked.tasks.get(ref.id);
    if (!t) return <p className="case-paper-muted">Loading…</p>;
    const when = [t.dueDate ? dateOnly.format(new Date(`${t.dueDate}T12:00:00`)) : "No date", t.startTime && t.endTime ? `${t.startTime}–${t.endTime}` : t.startTime].filter(Boolean).join(", ");
    return (
      <div className="case-ref">
        <h3 className="case-paper-heading">{t.title}</h3>
        <p className="case-paper-line">
          <label className="check-row">
            <input
              type="checkbox"
              checked={t.done}
              onChange={(e) => {
                void setTaskDone(t.id, e.target.checked).then(props.linked.reload);
              }}
            />
            <span>{t.done ? "Done" : "Not done yet"}</span>
          </label>
        </p>
        <p className="case-paper-line">
          <strong>When:</strong> {when}
        </p>
        {t.category && (
          <p className="case-paper-line">
            <strong>Label:</strong> {t.category}
          </p>
        )}
        {t.description && <p className="case-paper-text-block">{t.description}</p>}
      </div>
    );
  }
  const d = props.linked.deadlines.get(ref.id);
  if (!d) return <p className="case-paper-muted">Loading…</p>;
  const days = daysLeft(d);
  const late = !d.completedAt && Date.now() > d.dueAt;
  const ticked = d.tasks.filter((x) => x.done).length;
  return (
    <div className="case-ref">
      <h3 className="case-paper-heading">{d.title}</h3>
      <p className="case-paper-line">
        <strong>Due:</strong> {d.allDay ? dateOnly.format(new Date(d.dueAt)) : dateTime.format(new Date(d.dueAt))}
      </p>
      <p className="case-paper-line">
        <strong>{d.completedAt ? "Finished" : late ? "Overdue" : "Days left:"}</strong>{" "}
        {d.completedAt ? "" : days === 0 ? (late ? "it was due today" : "due today") : late ? `by ${-days} ${-days === 1 ? "day" : "days"}` : `${days} ${days === 1 ? "day" : "days"}`}
      </p>
      {d.description && <p className="case-paper-text-block">{d.description}</p>}
      {d.tasks.length > 0 && (
        <>
          <p className="case-paper-line">
            <strong>Checklist:</strong> {ticked} of {d.tasks.length}
          </p>
          <ul className="case-paper-list">
            {d.tasks.map((x) => (
              <li key={x.id} data-done={x.done}>
                {x.done ? "☑" : "☐"} {x.title}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function NoteSummaryView(props: { id: string; fallback: string; onOpenNote?: (id: string) => void }) {
  const [state, setState] = useState<{ title: string; html: string } | "loading" | "missing">("loading");
  useEffect(() => {
    let live = true;
    const load = () =>
      getNote(props.id)
        .then((n) => live && setState(n ? { title: n.title, html: noteHtml(n.body, n.plainText) } : "missing"))
        .catch(() => live && setState("missing"));
    void load();
    let off: (() => void) | undefined;
    listen("notes-changed", () => void load())
      .then((un) => (live ? (off = un) : un()))
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, [props.id]);
  if (state === "loading") return <p className="case-paper-muted">Loading…</p>;
  if (state === "missing") return <p className="case-paper-muted">This note was deleted.</p>;
  return (
    <div className="case-ref">
      <h3 className="case-paper-heading">{state.title || props.fallback || "Untitled"}</h3>
      {state.html ? (
        // Built by the editor's own schema from the saved note, so only its known marks and nodes appear.
        <div className="case-note-body" dangerouslySetInnerHTML={{ __html: state.html }} />
      ) : (
        <p className="case-paper-muted">An empty note.</p>
      )}
      {props.onOpenNote && (
        <button type="button" className="link-button small case-open-note" onClick={() => props.onOpenNote!(props.id)}>
          Open in Notes
        </button>
      )}
    </div>
  );
}

function Connections(props: { connections: { string: StringItem; other: Thing }[]; linked: Linked; onGo: (id: string) => void }) {
  if (props.connections.length === 0) {
    return <p className="case-paper-muted">No strings yet. Drag this card's pin onto another card to tie them.</p>;
  }
  return (
    <ul className="case-links">
      {props.connections.map(({ string, other }) => (
        <li key={string.id}>
          <button type="button" onClick={() => props.onGo(other.id)}>
            <span className="case-link-swatch" style={{ background: string.data.color ?? STRING_COLORS[0]![0] }} aria-hidden="true" />
            {titleOf(other, props.linked)}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- pinned free boards

type FreeList = BoardItem<ListData>;
type FreeCard = BoardItem<CardData>;

/** The lists and cards on a pinned free board, kept fresh as it changes here or on another device. */
function useFreeBoard(spaceId: string) {
  const [state, setState] = useState<{ lists: FreeList[]; cards: Map<string, FreeCard[]> } | null>(null);
  const reload = useMemo(
    () => () =>
      listBoardItems(spaceId)
        .then((items) => {
          const lists = (items.filter((i) => i.kind === "list") as unknown as FreeList[]).sort((a, b) => a.data.order - b.data.order);
          const cards = new Map<string, FreeCard[]>();
          for (const c of items.filter((i) => i.kind === "card") as unknown as FreeCard[]) {
            const arr = cards.get(c.data.list) ?? [];
            arr.push(c);
            cards.set(c.data.list, arr);
          }
          for (const arr of cards.values()) arr.sort((a, b) => a.data.order - b.data.order);
          setState({ lists, cards });
        })
        .catch(() => setState((now) => now ?? { lists: [], cards: new Map() })),
    [spaceId],
  );
  useEffect(() => {
    void reload();
    let off: (() => void) | undefined;
    let gone = false;
    listen("boards-changed", () => void reload())
      .then((un) => (gone ? un() : (off = un)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [reload]);
  return { state, reload };
}

/** The picture on a pinned free board's card: its first lists as little columns of cards. */
function FreeBoardPic(props: { spaceId: string }) {
  const { state } = useFreeBoard(props.spaceId);
  const lists = state?.lists.slice(0, 4) ?? [];
  if (lists.length === 0) return <Glyph name="board" />;
  return (
    <span className="case-card-kanban" aria-hidden="true">
      {lists.map((l) => {
        const cards = state!.cards.get(l.id) ?? [];
        return (
          <span key={l.id} className="case-card-kanban-col">
            {cards.slice(0, 6).map((c) => (
              <span key={c.id} data-done={c.data.done ? "true" : undefined} />
            ))}
            {cards.length > 6 && <i>+{cards.length - 6}</i>}
          </span>
        );
      })}
    </span>
  );
}

/** A pinned free board in the preview: every list and card, ticks, quick add, and a way to open it. */
function FreeBoardSummary(props: { spaceId: string; name: string; onOpenSpace?: (id: string) => void }) {
  const { state, reload } = useFreeBoard(props.spaceId);
  const [error, setError] = useState<string | null>(null);
  const save = (items: { id: string; kind: "card" | "list"; data: CardData | ListData }[]) =>
    saveBoardItems(items.map((i) => ({ id: i.id, spaceId: props.spaceId, kind: i.kind, data: i.data as unknown as Record<string, unknown> })))
      .then(() => {
        setError(null);
        void reload();
      })
      .catch((e: unknown) => setError(String(e)));
  if (!state) return <p className="case-paper-muted">Loading…</p>;
  const all = [...state.cards.values()].flat();
  const done = all.filter((c) => c.data.done).length;
  return (
    <div className="case-ref case-free">
      <h3 className="case-paper-heading">{props.name}</h3>
      <p className="case-paper-line">
        <strong>On it:</strong> {state.lists.length} {state.lists.length === 1 ? "list" : "lists"}, {all.length} {all.length === 1 ? "card" : "cards"}
        {all.length > 0 && `, ${done} done`}
      </p>
      {state.lists.length === 0 && <p className="case-paper-muted">No lists yet. Add one below, e.g. To do.</p>}
      {state.lists.map((l) => {
        const cards = state.cards.get(l.id) ?? [];
        return (
          <section key={l.id} className="case-free-list">
            <h4>
              {l.data.title || "Untitled list"} <span className="num">{cards.length}</span>
            </h4>
            <ul>
              {cards.map((c) => (
                <li key={c.id} data-done={c.data.done ? "true" : undefined}>
                  <label className="check-row">
                    <input type="checkbox" checked={!!c.data.done} onChange={(e) => void save([{ id: c.id, kind: "card", data: { ...c.data, done: e.target.checked } }])} />
                    {c.data.color && <span className="case-free-dot" style={{ background: c.data.color }} aria-hidden="true" />}
                    <span>{c.data.title || "Untitled card"}</span>
                  </label>
                </li>
              ))}
            </ul>
            <QuickLine
              placeholder="+ Add a card"
              onAdd={(title) => void save([{ id: newBoardId(), kind: "card", data: { list: l.id, title, order: between(cards.at(-1)?.data.order, undefined) } }])}
            />
          </section>
        );
      })}
      <QuickLine
        placeholder="+ Add a list"
        onAdd={(title) => void save([{ id: newBoardId(), kind: "list", data: { title, order: between(state.lists.at(-1)?.data.order, undefined) } }])}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {props.onOpenSpace && (
        <button type="button" className="link-button small case-open-note" onClick={() => props.onOpenSpace!(props.spaceId)}>
          Open board
        </button>
      )}
    </div>
  );
}

/** A one-line box: type and press Enter to add. */
function QuickLine(props: { placeholder: string; onAdd: (title: string) => void }) {
  const [text, setText] = useState("");
  return (
    <input
      className="case-free-add"
      value={text}
      placeholder={props.placeholder}
      aria-label={props.placeholder.replace("+ ", "")}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && text.trim()) {
          props.onAdd(text.trim());
          setText("");
        } else if (e.key === "Escape") {
          setText("");
          e.stopPropagation();
        }
      }}
    />
  );
}
