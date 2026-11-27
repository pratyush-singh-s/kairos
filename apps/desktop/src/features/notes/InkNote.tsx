import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { saveNote, type Note } from "../../ipc/notes";
import { useUi } from "../../theme/UiProvider";
import { grainOn, paintGrain } from "./grain";
import { AttachmentList, useNoteFiles } from "./Attachments";
import { NoteHead, type SaveState } from "./NoteEditor";
import {
  DEFAULT_GAP,
  DEFAULT_PAGE,
  MAX_GAP,
  MIN_GAP,
  INFINITE,
  MARKER_ALPHA,
  MM,
  PAGE_PRESETS,
  boxOf,
  dashOf,
  insidePolygon,
  isShape,
  moved,
  pagesOf,
  parseInk,
  penSize,
  pickedBy,
  pushPoint,
  rubOut,
  samePage,
  serializeInk,
  shapePoints,
  widthOf,
  strokeBox,
  strokePath,
  touches,
  type Backdrop,
  type Box,
  type LineStyle,
  type ShapeKind,
  type Sheet,
  type Stroke,
} from "./ink";

type Tool = "pen" | "marker" | "shape" | "eraser" | "select" | "hand";
type Fill = "none" | "soft" | "solid";
const FILL_ALPHA: Record<Fill, number | undefined> = { none: undefined, soft: 0.3, solid: 1 };

/** Ink colours (the page is dark in both themes, so no black). */
export const INK_COLORS: [string, string][] = [
  ["#f4f4f4", "White"],
  ["#9aa0a6", "Grey"],
  ["#b197fc", "Purple"],
  ["#a5d8ff", "Light blue"],
  ["#4d8dff", "Blue"],
  ["#40c057", "Green"],
  ["#ffd43b", "Yellow"],
  ["#ff922b", "Orange"],
  ["#fa5252", "Red"],
];

const MIN_WIDTH = 0.1;
const MAX_WIDTH = 40;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
/** Dot grid spacing, in page units. */
const GRID = 32;
/** Eraser radius on screen, in pixels. */
const ERASER_PX = 12;
const SAVE_DELAY_MS = 800;
const HISTORY = 100;
/** How long a tool button is held to open its options. */
const HOLD_MS = 450;
const SETTINGS_KEY = "focus.ink.settings";

interface Settings {
  tool: Tool;
  color: string;
  /** The three width dots; each keeps the size you give it. */
  widths: [number, number, number];
  /** Which dot is in use. */
  slot: 0 | 1 | 2;
  /** Pen pressure changes the pen's width (with a stylus). */
  pressure: boolean;
  /** Writing speed changes the pen's width (finger, mouse, or a stylus when pressure is off). */
  speed: boolean;
  /** Rub out whole strokes, or only what the eraser goes over. */
  eraser: "stroke" | "precise";
  select: "lasso" | "box";
  shape: ShapeKind;
  /** A shape's line: solid, dashes, dots or dash-dot. */
  line: LineStyle;
  /** Inside a rectangle or oval: nothing, a see-through tint, or solid colour. */
  fill: Fill;
  /** Whether a rectangle or oval has its outline (a line always does). */
  outline: boolean;
}

const TOOLS: Tool[] = ["pen", "marker", "shape", "eraser", "select", "hand"];
/** Ctrl+1 … Ctrl+6 pick these, in the toolbar's order (pen and eraser side by side). */
const TOOL_KEYS: Tool[] = ["pen", "eraser", "marker", "shape", "select", "hand"];
const SHAPES: ShapeKind[] = ["line", "rect", "oval"];
const LINES: LineStyle[] = ["s", "d", "o", "do"];
const isWidth = (w: unknown): w is number => typeof w === "number" && w >= MIN_WIDTH && w <= MAX_WIDTH;

function readSettings(): Settings {
  const fallback: Settings = {
    tool: "pen",
    color: INK_COLORS[0]![0],
    widths: [1, 2, 4],
    slot: 1,
    pressure: true,
    speed: true,
    eraser: "stroke",
    select: "lasso",
    shape: "rect",
    line: "s",
    fill: "none",
    outline: true,
  };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as (Partial<Settings> & { width?: number }) | null;
    if (!s) return fallback;
    const widths = Array.isArray(s.widths) && s.widths.length === 3 && s.widths.every(isWidth) ? (s.widths as Settings["widths"]) : fallback.widths;
    return {
      tool: TOOLS.includes(s.tool as Tool) ? (s.tool as Tool) : fallback.tool,
      color: typeof s.color === "string" && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : fallback.color,
      widths,
      slot: s.slot === 0 || s.slot === 1 || s.slot === 2 ? s.slot : fallback.slot,
      pressure: typeof s.pressure === "boolean" ? s.pressure : fallback.pressure,
      speed: typeof s.speed === "boolean" ? s.speed : fallback.speed,
      eraser: s.eraser === "precise" ? "precise" : "stroke",
      select: s.select === "box" ? "box" : "lasso",
      shape: SHAPES.includes(s.shape as ShapeKind) ? (s.shape as ShapeKind) : fallback.shape,
      line: LINES.includes(s.line as LineStyle) ? (s.line as LineStyle) : fallback.line,
      fill: s.fill === "soft" || s.fill === "solid" ? s.fill : "none",
      outline: typeof s.outline === "boolean" ? s.outline : true,
    };
  } catch {
    return fallback;
  }
}

function writeSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Only a convenience.
  }
}

const cache = new WeakMap<Stroke, { path: Path2D; box: Box }>();
function shape(s: Stroke) {
  let c = cache.get(s);
  if (!c) {
    c = { path: strokePath(s), box: strokeBox(s) };
    cache.set(s, c);
  }
  return c;
}

/** Copied strokes, shared by every handwritten note while the app is open. */
let clipboard: Stroke[] = [];

interface Viewport {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

/**
 * A handwritten note: a dotted drawing board (after rnote), written on with a pen, a finger or
 * the mouse. Pages of a chosen size (A4 …) show where each PDF page ends. Pen, marker, eraser,
 * select (lasso or box) and hand tools; hold a tool for its options. Two fingers move and zoom
 * the page; once a pen has touched it, one finger moves it too, so a resting hand does not draw.
 */
export function InkNote(props: {
  note: Note;
  onSaved: (n: Note) => void;
  onPin: (pinned: boolean) => void;
  onDelete: () => void;
  fullscreen?: boolean;
  onFullscreen?: (on: boolean) => void;
}) {
  const [title, setTitle] = useState(props.note.title);
  const [state, setState] = useState<SaveState>("saved");
  const [settings, setSettings] = useState(readSettings);
  // What the page shows, for the zoom label, the scroll bars and the selection bar (the board itself reads `view`).
  const [vp, setVp] = useState<Viewport>({ x: -GRID / 2, y: -GRID / 2, z: 1, w: 0, h: 0 });
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const files = useNoteFiles(props.note.id);

  const initial = useRef(parseInk(props.note.body));
  const strokes = useRef<Stroke[]>(initial.current.strokes);
  const [page, setPageState] = useState<Sheet>(initial.current.page);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [bg, setBgState] = useState<Backdrop>(initial.current.bg);
  const bgRef = useRef(bg);
  bgRef.current = bg;
  const [selected, setSelected] = useState<Stroke[]>([]);
  const selection = useRef<Stroke[]>([]);
  const past = useRef<Stroke[][]>([]);
  const future = useRef<Stroke[][]>([]);
  const view = useRef({ x: -GRID / 2, y: -GRID / 2, z: 1 });
  const board = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(settings);
  const fullRef = useRef(!!props.fullscreen);
  fullRef.current = !!props.fullscreen;
  settingsRef.current = settings;
  const redraw = useRef<() => void>(() => {});

  const id = props.note.id;
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const titleRef = useRef(title);
  titleRef.current = title;
  const onSaved = useRef(props.onSaved);
  onSaved.current = props.onSaved;

  async function flush() {
    window.clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    setState("saving");
    try {
      const saved = await saveNote(id, titleRef.current, serializeInk(strokes.current, pageRef.current, bgRef.current), "");
      setState(dirty.current ? "unsaved" : "saved");
      onSaved.current(saved);
    } catch (err) {
      dirty.current = true;
      setState({ error: String(err) });
    }
  }

  function schedule() {
    dirty.current = true;
    setState("unsaved");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  // Leaving the note (or the page) saves what is not saved yet.
  useEffect(() => () => void flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function select(list: Stroke[]) {
    selection.current = list;
    setSelected(list);
    redraw.current();
  }

  /** Replaces the drawing, keeping the old one for Undo. */
  function commit(next: Stroke[], before = strokes.current) {
    past.current.push(before);
    if (past.current.length > HISTORY) past.current.shift();
    future.current = [];
    strokes.current = next;
    schedule();
    bump();
    redraw.current();
  }

  function undo() {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(strokes.current);
    strokes.current = prev;
    select([]);
    schedule();
    bump();
  }

  function redo() {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(strokes.current);
    strokes.current = next;
    select([]);
    schedule();
    bump();
  }

  // What can be done with the selected strokes.
  function copySelection() {
    clipboard = selection.current.slice();
    bump();
  }
  function deleteSelection() {
    const gone = new Set(selection.current);
    if (!gone.size) return;
    commit(strokes.current.filter((s) => !gone.has(s)));
    select([]);
  }
  function paste() {
    if (!clipboard.length) return;
    const b = boxOf(clipboard)!;
    const v = view.current;
    const el = canvas.current;
    // Into the middle of what is on screen (a little lower and to the right if that is where they came from).
    const cx = v.x + (el ? el.clientWidth / 2 : 300) / v.z;
    const cy = v.y + (el ? el.clientHeight / 2 : 300) / v.z;
    let dx = cx - (b.x0 + b.x1) / 2;
    let dy = cy - (b.y0 + b.y1) / 2;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      dx = 24;
      dy = 24;
    }
    const copies = clipboard.map((s) => moved(s, dx, dy));
    commit([...strokes.current, ...copies]);
    update({ tool: "select" });
    select(copies);
  }
  function recolorSelection(color: string) {
    const picked = new Set(selection.current);
    const recolored = new Map<Stroke, Stroke>();
    const next = strokes.current.map((s) => {
      if (!picked.has(s)) return s;
      const r = { ...s, c: color };
      recolored.set(s, r);
      return r;
    });
    commit(next);
    select(selection.current.map((s) => recolored.get(s) ?? s));
  }

  function setPage(p: Sheet) {
    if (samePage(p, pageRef.current)) return;
    pageRef.current = p;
    setPageState(p);
    schedule();
    redraw.current();
  }

  function setBg(next: Partial<Backdrop>) {
    const b = { ...bgRef.current, ...next };
    bgRef.current = b;
    setBgState(b);
    schedule();
    redraw.current();
  }

  function setView(x: number, y: number, z: number) {
    const v = view.current;
    v.z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    // The page goes on to the right and down; keep its top-left corner from drifting far away.
    // An infinite board has no corner: it goes on every way.
    // Half a screen of room past the top-left corner, so the page can be dragged every way.
    const el = canvas.current;
    const infinite = pageRef.current === INFINITE;
    v.x = infinite ? x : Math.max(-GRID * 2 - (el ? el.clientWidth / 2 : 0) / v.z, x);
    v.y = infinite ? y : Math.max(-GRID * 2 - (el ? el.clientHeight / 2 : 0) / v.z, y);
    redraw.current();
  }

  /** Zooms by `factor` keeping the page point under (sx, sy) on the screen where it is. */
  function zoomAt(factor: number, sx?: number, sy?: number) {
    const v = view.current;
    const el = canvas.current;
    const cx = sx ?? (el ? el.clientWidth / 2 : 0);
    const cy = sy ?? (el ? el.clientHeight / 2 : 0);
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * factor));
    const px = v.x + cx / v.z;
    const py = v.y + cy / v.z;
    setView(px - cx / z, py - cy / z, z);
  }

  function update(s: Partial<Settings>) {
    if (s.tool && s.tool !== "select" && selection.current.length) select([]);
    setSettings((cur) => {
      const next = { ...cur, ...s };
      writeSettings(next);
      settingsRef.current = next;
      return next;
    });
  }

  // The drawing board itself: drawing, painting, pointers and keys.
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    /** from: where a shape was started; at: where the pointer is (Shift redraws it). */
    let live: { pointer: number; stroke: Stroke; from?: { x: number; y: number; kind: ShapeKind }; at?: { x: number; y: number }; even?: boolean } | null = null;
    /** right: the right mouse button (or the pen's side button) is held, so this is the eraser for now. */
    let erasing: { pointer: number; before: Stroke[]; right?: boolean } | null = null;
    let lasso: { pointer: number; pts: number[] } | null = null;
    let box: { pointer: number; x0: number; y0: number; x1: number; y1: number } | null = null;
    let moving: { pointer: number; x: number; y: number; dx: number; dy: number } | null = null;
    let pan: { pointer: number; x: number; y: number } | null = null;
    const touchesDown = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; z: number; px: number; py: number } | null = null;
    let penSeen = false;
    /** When a pen last moved or touched (performance.now()). */
    let penAt = -1e9;
    /** Some pen drivers send the side button as a separate mouse right button, next to the pen
     * tip's own pointer. While that "mouse" button is held (id here), the pen erases. */
    let sideMouse: number | null = null;
    const sideHeld = (e: PointerEvent) => (e.pointerType === "pen" && (e.buttons & 2) !== 0) || sideMouse !== null;
    let space = false;
    /** The tool to go back to when a held E key (the eraser, for now) is let go. */
    let springFrom: Tool | null = null;
    let springAt = 0;
    let cursor: { x: number; y: number } | null = null;
    let frame = 0;

    function report(w: number, h: number) {
      const { x, y, z } = view.current;
      setVp((cur) => (cur.x === x && cur.y === y && cur.z === z && cur.w === w && cur.h === h ? cur : { x, y, z, w, h }));
    }

    function paint() {
      frame = 0;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      const { x, y, z } = view.current;
      report(w, h);
      const style = getComputedStyle(el);
      const muted = style.color;
      const accent = style.getPropertyValue("--accent").trim() || "#74c0fc";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);

      // Paper grain: drawn in page units, so it pans and zooms with the writing like real paper.
      if (grainOn()) {
        const paper = pagesOf(pageRef.current);
        paintGrain(ctx, view.current, dpr, paper ? { x0: 0, y0: 0, x1: paper.w * MM, y1: 1e9 } : null);
      }

      const bg = bgRef.current;
      // Dots, ruled lines or grid lines, drawn in screen pixels so they stay crisp at any zoom.
      // Zoomed far out they thin out, so the page does not turn grey.
      let gap = bg.gap;
      while (gap * z < 10) gap *= 2;
      if (bg.k === "dots") {
        ctx.fillStyle = muted;
        ctx.globalAlpha = 0.45;
        const r = Math.max(1, 1.1 * dpr);
        for (let gx = Math.floor(x / gap) * gap; gx <= x + w / z; gx += gap) {
          for (let gy = Math.floor(y / gap) * gap; gy <= y + h / z; gy += gap) {
            ctx.fillRect(Math.round((gx - x) * z * dpr) - r / 2, Math.round((gy - y) * z * dpr) - r / 2, r, r);
          }
        }
      } else if (bg.k === "grid" || bg.k === "lines") {
        ctx.strokeStyle = muted;
        ctx.globalAlpha = bg.k === "lines" ? 0.24 : 0.18;
        ctx.lineWidth = Math.max(1, Math.round(dpr));
        ctx.beginPath();
        // Lines: only the across lines, like ruled notebook paper.
        if (bg.k === "grid") for (let gx = Math.floor(x / gap) * gap; gx <= x + w / z; gx += gap) {
          const sx0 = Math.round((gx - x) * z * dpr) + 0.5;
          ctx.moveTo(sx0, 0);
          ctx.lineTo(sx0, el.height);
        }
        for (let gy = Math.floor(y / gap) * gap; gy <= y + h / z; gy += gap) {
          const sy0 = Math.round((gy - y) * z * dpr) + 0.5;
          ctx.moveTo(0, sy0);
          ctx.lineTo(el.width, sy0);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // The pages: shade what is off the page, a dashed line where each page ends.
      const pg = pagesOf(pageRef.current);
      const sx = (px: number) => (px - x) * z * dpr;
      const sy = (py: number) => (py - y) * z * dpr;
      if (pg) {
        const pw = pg.w * MM;
        const ph = pg.h * MM;
        ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
        if (x < 0) ctx.fillRect(0, 0, sx(0), el.height);
        if (x + w / z > pw) ctx.fillRect(sx(pw), 0, el.width - sx(pw), el.height);
        if (y < 0) ctx.fillRect(Math.max(0, sx(0)), 0, Math.min(el.width, sx(pw)) - Math.max(0, sx(0)), sy(0));
        ctx.strokeStyle = muted;
        ctx.lineWidth = dpr;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(sx(0), Math.max(0, sy(0)));
        ctx.lineTo(sx(0), el.height);
        ctx.moveTo(sx(pw), Math.max(0, sy(0)));
        ctx.lineTo(sx(pw), el.height);
        ctx.moveTo(sx(0), sy(0));
        ctx.lineTo(sx(pw), sy(0));
        ctx.stroke();
        ctx.setLineDash([6 * dpr, 5 * dpr]);
        ctx.font = `${11 * dpr}px system-ui, sans-serif`;
        ctx.fillStyle = muted;
        for (let k = Math.max(1, Math.floor(y / ph)); k * ph <= y + h / z; k++) {
          ctx.beginPath();
          ctx.moveTo(sx(0), sy(k * ph));
          ctx.lineTo(sx(pw), sy(k * ph));
          ctx.stroke();
          ctx.fillText(`Page ${k + 1}`, sx(0) + 6 * dpr, sy(k * ph) + 14 * dpr);
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      ctx.setTransform(z * dpr, 0, 0, z * dpr, -x * z * dpr, -y * z * dpr);
      const seen = { x0: x, y0: y, x1: x + w / z, y1: y + h / z };
      const draw = (s: Stroke, path: Path2D) => {
        if (isShape(s)) {
          if (s.f) {
            ctx.globalAlpha = s.f;
            ctx.fillStyle = s.c;
            ctx.fill(path);
          }
          if (s.o !== 0) {
            ctx.globalAlpha = 1;
            ctx.strokeStyle = s.c;
            ctx.lineWidth = widthOf(s);
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.setLineDash(dashOf(s));
            ctx.stroke(path);
            ctx.setLineDash([]);
          }
          return;
        }
        ctx.globalAlpha = s.t === "marker" ? MARKER_ALPHA : 1;
        ctx.fillStyle = s.c;
        ctx.fill(path);
      };
      const picked = new Set(selection.current);
      const mdx = moving?.dx ?? 0;
      const mdy = moving?.dy ?? 0;
      for (const s of strokes.current) {
        const { path, box: b } = shape(s);
        const off = picked.has(s) ? { dx: mdx, dy: mdy } : { dx: 0, dy: 0 };
        if (b.x1 + off.dx < seen.x0 || b.x0 + off.dx > seen.x1 || b.y1 + off.dy < seen.y0 || b.y0 + off.dy > seen.y1) continue;
        if (off.dx || off.dy) {
          ctx.save();
          ctx.translate(off.dx, off.dy);
          draw(s, path);
          ctx.restore();
        } else draw(s, path);
      }
      if (live) draw(live.stroke, strokePath(live.stroke, false));
      ctx.globalAlpha = 1;

      // Selection, lasso and box, in screen pixels.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      const sb = boxOf(selection.current);
      if (sb) {
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.08;
        ctx.fillRect(sx(sb.x0 + mdx), sy(sb.y0 + mdy), (sb.x1 - sb.x0) * z * dpr, (sb.y1 - sb.y0) * z * dpr);
        ctx.globalAlpha = 1;
        ctx.strokeRect(sx(sb.x0 + mdx), sy(sb.y0 + mdy), (sb.x1 - sb.x0) * z * dpr, (sb.y1 - sb.y0) * z * dpr);
      }
      if (lasso && lasso.pts.length >= 4) {
        ctx.beginPath();
        ctx.moveTo(sx(lasso.pts[0]!), sy(lasso.pts[1]!));
        for (let i = 2; i + 1 < lasso.pts.length; i += 2) ctx.lineTo(sx(lasso.pts[i]!), sy(lasso.pts[i + 1]!));
        ctx.closePath();
        ctx.stroke();
      }
      if (box) ctx.strokeRect(sx(Math.min(box.x0, box.x1)), sy(Math.min(box.y0, box.y1)), Math.abs(box.x1 - box.x0) * z * dpr, Math.abs(box.y1 - box.y0) * z * dpr);
      ctx.setLineDash([]);

      // Where the eraser or the pen is: a thin ring, the pen's ring as wide as its line.
      const st = settingsRef.current;
      const eraser = st.tool === "eraser" || !!erasing?.right || sideMouse !== null;
      const ring = !!cursor && (eraser || ((st.tool === "pen" || st.tool === "marker" || st.tool === "shape") && !pan && !space));
      // The ring stands in for the mouse pointer: hide Windows' own one while it shows.
      const want = pan ? "grabbing" : ring ? "none" : "";
      if (el.style.cursor !== want) el.style.cursor = want;
      if (cursor && ring) {
        const radius = eraser ? ERASER_PX : Math.max(2, (penSize(st.tool === "marker", st.widths[st.slot]) * z) / 2);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineWidth = 1;
        // A dark edge under a light one, so the ring shows on ink of any colour.
        ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
        ctx.beginPath();
        ctx.arc(cursor.x, cursor.y, radius + 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = eraser ? "rgba(255, 255, 255, 0.85)" : st.color;
        ctx.beginPath();
        ctx.arc(cursor.x, cursor.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    const request = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    redraw.current = request;

    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const toPage = (p: { x: number; y: number }) => {
      const { x, y, z } = view.current;
      return { x: x + p.x / z, y: y + p.y / z };
    };

    function eraseAt(p: { x: number; y: number }) {
      const at = toPage(p);
      const r = ERASER_PX / view.current.z;
      let changed = false;
      const next: Stroke[] = [];
      for (const s of strokes.current) {
        if (!touches(s, shape(s).box, at.x, at.y, r)) {
          next.push(s);
          continue;
        }
        if (settingsRef.current.eraser === "stroke") {
          changed = true;
          continue;
        }
        const pieces = rubOut(s, at.x, at.y, r);
        if (pieces) {
          changed = true;
          next.push(...pieces);
        } else next.push(s);
      }
      if (changed) {
        strokes.current = next;
        request();
      }
    }

    function endErasing() {
      if (!erasing) return;
      const before = erasing.before;
      erasing = null;
      if (before !== strokes.current) {
        const now = strokes.current;
        strokes.current = before;
        commit(now, before);
      }
    }

    function finishPick() {
      let inside: ((x: number, y: number) => boolean) | null = null;
      if (lasso && lasso.pts.length >= 6) {
        const pts = lasso.pts;
        inside = (x, y) => insidePolygon(x, y, pts);
      } else if (box) {
        const [x0, x1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
        const [y0, y1] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
        inside = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
      }
      lasso = null;
      box = null;
      select(inside ? strokes.current.filter((s) => pickedBy(s, inside)) : []);
    }

    function finishMove() {
      if (!moving) return;
      const { dx, dy } = moving;
      moving = null;
      if (!dx && !dy) return request();
      const picked = new Set(selection.current);
      const copies = new Map<Stroke, Stroke>();
      const next = strokes.current.map((s) => {
        if (!picked.has(s)) return s;
        const m = moved(s, dx, dy);
        copies.set(s, m);
        return m;
      });
      commit(next);
      select(selection.current.map((s) => copies.get(s) ?? s));
    }

    function startPinch() {
      const [a, b] = [...touchesDown.values()];
      if (!a || !b) return;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const page = toPage(mid);
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: view.current.z, px: page.x, py: page.y };
    }

    function down(e: PointerEvent) {
      const p = local(e);
      const st = settingsRef.current;
      const tool = st.tool;
      el.focus({ preventScroll: true });
      if (e.pointerType === "pen") {
        penSeen = true;
        penAt = performance.now();
      }
      // A right "mouse" press while the pen is right there: the pen's side button.
      if (e.pointerType === "mouse" && e.button === 2 && performance.now() - penAt < 400) {
        e.preventDefault();
        sideMouse = e.pointerId;
        cursor = p;
        request();
        return;
      }
      if (e.pointerType === "touch") {
        touchesDown.set(e.pointerId, p);
        if (touchesDown.size >= 2) {
          // A second finger: this is a move or a zoom, not writing.
          live = null;
          endErasing();
          lasso = null;
          box = null;
          moving = null;
          pan = null;
          startPinch();
          request();
          return;
        }
        if (penSeen || tool === "hand") {
          pan = { pointer: e.pointerId, ...p };
          el.setPointerCapture(e.pointerId);
          return;
        }
      }
      // Middle drag, or Alt / Space + left drag (mouse or pen), pans (as does the hand tool).
      const mouseOrPen = e.pointerType === "mouse" || e.pointerType === "pen";
      if ((e.pointerType === "mouse" && e.button === 1) || (mouseOrPen && (tool === "hand" || space || e.altKey) && e.button === 0)) {
        e.preventDefault();
        pan = { pointer: e.pointerId, ...p };
        el.setPointerCapture(e.pointerId);
        el.style.cursor = "grabbing";
        request();
        return;
      }
      if (e.button !== 0 && e.button !== 2 && e.button !== 5) return;
      if (live || erasing || lasso || box || moving) return;
      el.setPointerCapture(e.pointerId);
      const at = toPage(p);
      // Holding the right mouse button (or the pen's side button) erases until it is let go.
      // Windows reports a pen touching down with its side button held as the tip (button 0) with
      // the side button in e.buttons (2), so that counts too.
      if (e.button === 2 || (e.pointerType === "pen" && sideHeld(e))) {
        e.preventDefault();
        cursor = p;
        erasing = { pointer: e.pointerId, before: strokes.current, right: true };
        eraseAt(p);
        request();
        return;
      }
      // The pen's eraser end (or its button) always erases.
      if (tool === "eraser" || e.button === 5 || (e.buttons & 32) !== 0) {
        erasing = { pointer: e.pointerId, before: strokes.current };
        eraseAt(p);
        return;
      }
      if (tool === "select") {
        const sb = boxOf(selection.current);
        if (sb && at.x >= sb.x0 && at.x <= sb.x1 && at.y >= sb.y0 && at.y <= sb.y1) {
          moving = { pointer: e.pointerId, x: at.x, y: at.y, dx: 0, dy: 0 };
          return;
        }
        if (selection.current.length) select([]);
        if (st.select === "box") box = { pointer: e.pointerId, x0: at.x, y0: at.y, x1: at.x, y1: at.y };
        else lasso = { pointer: e.pointerId, pts: [at.x, at.y] };
        return;
      }
      if (tool === "hand") return;
      if (tool === "shape") {
        const closed = st.shape !== "line";
        const fill = closed ? FILL_ALPHA[st.fill] : undefined;
        const stroke: Stroke = { t: "pen", c: st.color, w: st.widths[st.slot], p: [], m: "c", g: st.line, u: 1 };
        if (fill) stroke.f = fill;
        if (fill && !st.outline) stroke.o = 0;
        stroke.p = shapePoints(st.shape, at.x, at.y, at.x, at.y, false);
        live = { pointer: e.pointerId, stroke, from: { x: at.x, y: at.y, kind: st.shape }, at, even: e.shiftKey };
        request();
        return;
      }
      const stylus = e.pointerType === "pen";
      const mode = st.pressure && stylus ? "p" : st.speed ? "v" : "c";
      const stroke: Stroke = { t: tool === "marker" ? "marker" : "pen", c: st.color, w: st.widths[st.slot], p: [], m: tool === "marker" ? "c" : mode, ...(tool === "marker" ? {} : { u: 1 as const }) };
      pushPoint(stroke, at.x, at.y, stylus ? e.pressure || 0.5 : 0.5);
      live = { pointer: e.pointerId, stroke };
      request();
    }

    function move(e: PointerEvent) {
      const p = local(e);
      if (e.pointerType === "pen") penAt = performance.now();
      // The side button's "mouse" let go (its pointerup can land outside the page).
      if (sideMouse !== null && e.pointerType === "mouse" && (e.buttons & 2) === 0) releaseSide();
      if (sideMouse !== null && e.pointerId === sideMouse) {
        cursor = p;
        request();
        return;
      }
      cursor = e.pointerType === "touch" ? null : p;
      if (e.pointerType === "touch" && touchesDown.has(e.pointerId)) {
        touchesDown.set(e.pointerId, p);
        if (pinch && touchesDown.size >= 2) {
          const [a, b] = [...touchesDown.values()];
          const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
          const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (pinch.z * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.dist));
          setView(pinch.px - mid.x / z, pinch.py - mid.y / z, z);
          return;
        }
      }
      if (pan && pan.pointer === e.pointerId) {
        const v = view.current;
        setView(v.x - (p.x - pan.x) / v.z, v.y - (p.y - pan.y) / v.z, v.z);
        pan.x = p.x;
        pan.y = p.y;
        return;
      }
      const at = toPage(p);
      // The pen's side button (the pen's right click) held while the tip is down: erase.
      // Some pens only report the button once the pen moves, so this is checked on every move.
      const side = e.pointerType === "pen" && sideHeld(e) && e.pressure > 0;
      if (side && !erasing && !lasso && !box && !moving && (!live || (live.pointer === e.pointerId && !live.from))) {
        if (live) {
          // Pressed just after the tip touched: no line. Pressed later: keep the line so far.
          if (live.stroke.p.length > 30) commit([...strokes.current, live.stroke]);
          live = null;
        }
        if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId);
        cursor = p;
        erasing = { pointer: e.pointerId, before: strokes.current, right: true };
        eraseAt(p);
        request();
        return;
      }
      // The side button let go while the tip is still down: stop erasing.
      if (erasing?.right && erasing.pointer === e.pointerId && e.pointerType === "pen" && !sideHeld(e)) {
        endErasing();
        request();
        return;
      }
      if (live && live.pointer === e.pointerId && live.from) {
        live.at = at;
        live.even = e.shiftKey;
        live.stroke = { ...live.stroke, p: shapePoints(live.from.kind, live.from.x, live.from.y, at.x, at.y, e.shiftKey) };
      } else if (live && live.pointer === e.pointerId) {
        const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
        for (const ev of events.length ? events : [e]) {
          const q = toPage(local(ev));
          pushPoint(live.stroke, q.x, q.y, ev.pointerType === "pen" ? ev.pressure || 0.5 : 0.5);
        }
      } else if (erasing && erasing.pointer === e.pointerId) {
        eraseAt(p);
      } else if (lasso && lasso.pointer === e.pointerId) {
        lasso.pts.push(at.x, at.y);
      } else if (box && box.pointer === e.pointerId) {
        box.x1 = at.x;
        box.y1 = at.y;
      } else if (moving && moving.pointer === e.pointerId) {
        moving.dx = at.x - moving.x;
        moving.dy = at.y - moving.y;
      }
      request();
    }

    function releaseSide() {
      sideMouse = null;
      if (erasing?.right) endErasing();
      request();
    }

    function up(e: PointerEvent) {
      if (sideMouse !== null && e.pointerId === sideMouse) return releaseSide();
      touchesDown.delete(e.pointerId);
      if (touchesDown.size < 2) pinch = null;
      if (pan && pan.pointer === e.pointerId) {
        pan = null;
        el.style.cursor = "";
      }
      if (live && live.pointer === e.pointerId) {
        const { stroke, from, at } = live;
        live = null;
        // A shape needs a drag; a click alone draws nothing.
        const tiny = from && at && Math.hypot(at.x - from.x, at.y - from.y) < 2;
        if (e.type === "pointerup" && !tiny) commit([...strokes.current, stroke]);
      }
      if (erasing && erasing.pointer === e.pointerId) endErasing();
      if ((lasso && lasso.pointer === e.pointerId) || (box && box.pointer === e.pointerId)) finishPick();
      if (moving && moving.pointer === e.pointerId) finishMove();
      request();
    }

    // The right button erases on the board, so it opens no menu there.
    const noMenu = (e: Event) => e.preventDefault();
    // The middle button moves the page: stop Windows' auto-scroll (and middle-click paste) from taking it.
    const noAutoScroll = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };

    function leave(e: PointerEvent) {
      if (e.pointerType !== "touch") cursor = null;
      request();
    }

    function wheel(e: WheelEvent) {
      e.preventDefault();
      const v = view.current;
      if (e.ctrlKey || e.metaKey) {
        const p = local(e);
        zoomAt(Math.exp(-e.deltaY * 0.0025), p.x, p.y);
        return;
      }
      const step = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * step;
      const dy = (e.shiftKey ? 0 : e.deltaY) * step;
      setView(v.x + dx / v.z, v.y + dy / v.z, v.z);
    }

    function key(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Zoom and tool keys work even while typing the title (they do nothing in a text box).
      if (mod && !e.altKey) {
        if (k === "=" || k === "+" || e.code === "NumpadAdd") {
          e.preventDefault();
          return zoomAt(1.25);
        }
        if (k === "-" || e.code === "NumpadSubtract") {
          e.preventDefault();
          return zoomAt(0.8);
        }
        if (k === "0" || e.code === "Numpad0") {
          e.preventDefault();
          return zoomAt(1 / view.current.z);
        }
        const digit = /^(?:Digit|Numpad)([1-6])$/.exec(e.code);
        if (digit && !e.shiftKey) {
          e.preventDefault();
          return update({ tool: TOOL_KEYS[Number(digit[1]) - 1]! });
        }
      }
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const has = selection.current.length > 0;
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        redo();
      } else if (mod && k === "c" && has) {
        e.preventDefault();
        copySelection();
      } else if (mod && k === "x" && has) {
        e.preventDefault();
        copySelection();
        deleteSelection();
      } else if (mod && k === "v" && clipboard.length) {
        e.preventDefault();
        paste();
      } else if (mod && k === "a") {
        e.preventDefault();
        update({ tool: "select" });
        select(strokes.current.slice());
      } else if ((k === "delete" || k === "backspace") && has) {
        e.preventDefault();
        deleteSelection();
      } else if (k === "escape" && has) {
        select([]);
      } else if (!mod && !e.altKey && e.key.startsWith("Arrow") && arrowsMovePage(t)) {
        // Arrow keys move the page; with Shift a screenful at a time.
        e.preventDefault();
        const v = view.current;
        const stepX = e.shiftKey ? (el.clientWidth * 0.9) / v.z : 60 / v.z;
        const stepY = e.shiftKey ? (el.clientHeight * 0.9) / v.z : 60 / v.z;
        const dx = e.key === "ArrowLeft" ? -stepX : e.key === "ArrowRight" ? stepX : 0;
        const dy = e.key === "ArrowUp" ? -stepY : e.key === "ArrowDown" ? stepY : 0;
        setView(v.x + dx, v.y + dy, v.z);
      } else if (!mod && !e.altKey) {
        const tool = ({ p: "pen", m: "marker", e: "eraser", s: "select", h: "hand" } as Record<string, Tool>)[k];
        // E held down = eraser until it is let go (a pen's side button can be set to send E in
        // the pen's own settings). A quick tap switches to the eraser and stays, as before.
        if (k === "e" && !e.repeat && settingsRef.current.tool !== "eraser") {
          springFrom = settingsRef.current.tool;
          springAt = performance.now();
        }
        if (tool && !(k === "e" && e.repeat)) update({ tool });
        else if (e.code === "Space" && t === el) {
          e.preventDefault();
          space = true;
        }
      }
    }
    /** Shift pressed or let go while dragging a shape: square / circle / 45° line, or back. */
    const shiftShape = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || !live?.from || !live.at || live.even === e.shiftKey) return;
      live.even = e.shiftKey;
      live.stroke = { ...live.stroke, p: shapePoints(live.from.kind, live.from.x, live.from.y, live.at.x, live.at.y, e.shiftKey) };
      request();
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") space = false;
      if (e.key.toLowerCase() === "e" && springFrom) {
        if (performance.now() - springAt > 250) {
          if (erasing) endErasing();
          update({ tool: springFrom });
        }
        springFrom = null;
      }
      shiftShape(e);
    };

    const resize = new ResizeObserver(request);
    resize.observe(el);
    // Pen test (Ctrl+Shift+P): lists what the pen and mouse report, to find how a pen's side
    // button arrives on this PC. Nothing is kept; it only shows on screen.
    let probe: HTMLDivElement | null = null;
    const probeLines: string[] = [];
    let lastButtons = -1;
    const probeLog = (e: Event) => {
      if (!probe) return;
      if (e instanceof KeyboardEvent) {
        probeLines.unshift(`${e.type.padEnd(12)} key "${e.key}"${e.ctrlKey ? " +Ctrl" : ""}${e.altKey ? " +Alt" : ""}${e.shiftKey ? " +Shift" : ""}${e.repeat ? " (repeat)" : ""}`);
        probeLines.length = Math.min(probeLines.length, 16);
        probe.textContent = "Pen test (Ctrl+Shift+P to close). Press the side button with the pen on the page:\n\n" + probeLines.join("\n");
        return;
      }
      const pe = e as PointerEvent;
      if (e.type === "pointermove") {
        if (pe.buttons === lastButtons) return;
      }
      if ("buttons" in pe) lastButtons = pe.buttons;
      const kind = "pointerType" in pe && pe.pointerType ? pe.pointerType : "-";
      const line = `${e.type.padEnd(12)} ${String(kind).padEnd(5)} id ${"pointerId" in pe ? pe.pointerId : "-"} button ${(pe as MouseEvent).button} buttons ${(pe as MouseEvent).buttons}${"pressure" in pe ? ` pressure ${pe.pressure.toFixed(2)}` : ""}`;
      probeLines.unshift(line);
      probeLines.length = Math.min(probeLines.length, 16);
      probe.textContent = "Pen test (Ctrl+Shift+P to close). Press the side button with the pen on the page:\n\n" + probeLines.join("\n");
    };
    const probeKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p")) return;
      e.preventDefault();
      if (probe) {
        probe.remove();
        probe = null;
        return;
      }
      probe = document.createElement("div");
      probe.className = "ink-probe";
      probe.textContent = "Pen test (Ctrl+Shift+P to close). Press the side button with the pen on the page.";
      (board.current ?? el.parentElement ?? document.body).appendChild(probe);
    };
    const probeEvents = ["pointerdown", "pointermove", "pointerup", "pointercancel", "contextmenu", "mousedown", "mouseup", "auxclick", "keydown", "keyup"];
    for (const t of probeEvents) window.addEventListener(t, probeLog, true);
    window.addEventListener("keydown", probeKey, true);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("contextmenu", noMenu);
    el.addEventListener("mousedown", noAutoScroll);
    el.addEventListener("auxclick", noAutoScroll);
    // On the whole board (scroll bars and selection bar too), so Ctrl + wheel always zooms the page.
    const area: HTMLElement = board.current ?? el;
    area.addEventListener("wheel", wheel, { passive: false });
    // Alt on its own does nothing here (so the pen keeps writing), and in full screen the
    // Alt + number page keys are off, so a stray press never leaves the drawing.
    const guard = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        e.preventDefault();
        return;
      }
      if (fullRef.current && e.type === "keydown" && e.altKey && !e.ctrlKey && !e.metaKey && /^(?:Digit|Numpad)\d$/.test(e.code)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", guard, true);
    window.addEventListener("keyup", guard, true);
    window.addEventListener("keydown", key);
    window.addEventListener("keydown", shiftShape);
    window.addEventListener("keyup", keyUp);
    request();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("contextmenu", noMenu);
      for (const t of probeEvents) window.removeEventListener(t, probeLog, true);
      window.removeEventListener("keydown", probeKey, true);
      probe?.remove();
      el.removeEventListener("mousedown", noAutoScroll);
      el.removeEventListener("auxclick", noAutoScroll);
      area.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keydown", shiftShape);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("keydown", guard, true);
      window.removeEventListener("keyup", guard, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The eraser and pen rings follow the tool, width and colour.
  useEffect(() => redraw.current(), [settings.tool, settings.slot, settings.widths, settings.color]);
  // Settings → Look → Notes background: the paper grain comes and goes.
  const { notesGrain } = useUi();
  useEffect(() => redraw.current(), [notesGrain]);

  const empty = strokes.current.length === 0;
  const selBox = boxOf(selected);

  return (
    <article className="note-editor card ink-note" aria-label={title || "Untitled note"}>
      <NoteHead
        note={props.note}
        title={title}
        state={state}
        files={files}
        onTitle={(t) => {
          setTitle(t);
          schedule();
        }}
        onEnter={() => canvas.current?.focus()}
        onPin={props.onPin}
        onDelete={props.onDelete}
        body={() => serializeInk(strokes.current, pageRef.current, bgRef.current)}
        fullscreen={props.fullscreen}
        onFullscreen={props.onFullscreen}
      />
      <InkToolbar
        settings={settings}
        zoom={vp.z}
        page={page}
        canUndo={past.current.length > 0}
        canRedo={future.current.length > 0}
        canPaste={clipboard.length > 0}
        empty={empty}
        onChange={update}
        onColor={(color) => {
          if (selection.current.length) recolorSelection(color);
          const tool = settingsRef.current.tool;
          update({ color, tool: tool === "pen" || tool === "marker" || tool === "select" ? tool : "pen" });
        }}
        onPage={setPage}
        bg={bg}
        onBg={setBg}
        onUndo={undo}
        onRedo={redo}
        onPaste={paste}
        onZoom={(f) => zoomAt(f)}
        onResetView={() => setView(-GRID / 2, -GRID / 2, 1)}
        onClear={() => {
          commit([]);
          select([]);
        }}
      />
      <div className="ink-board" ref={board} data-no-swipe="true" data-tool={settings.tool}>
        <canvas ref={canvas} className="ink-canvas" tabIndex={0} aria-label="Drawing board. Write with a pen, a finger or the mouse." />
        {empty && <p className="ink-hint">Start writing.</p>}
        {selBox && vp.w > 0 && (
          <div
            className="ink-selbar"
            role="toolbar"
            aria-label="Selection"
            style={{
              left: Math.min(Math.max(4, (selBox.x0 - vp.x) * vp.z), Math.max(4, vp.w - 250)),
              top: Math.min(Math.max(4, (selBox.y0 - vp.y) * vp.z - 44), Math.max(4, vp.h - 44)),
            }}
          >
            <span className="muted small">{selected.length === 1 ? "1 stroke" : `${selected.length} strokes`}</span>
            <button type="button" className="note-tool" title="Copy (Ctrl+C), then Paste (Ctrl+V)" onClick={copySelection}>
              Copy
            </button>
            <button
              type="button"
              className="note-tool"
              title="Copy and paste in one go"
              onClick={() => {
                copySelection();
                paste();
              }}
            >
              Duplicate
            </button>
            <button type="button" className="note-tool" title="Delete (Del)" onClick={deleteSelection}>
              Delete
            </button>
            <button type="button" className="note-tool" title="Done (Esc)" aria-label="Clear selection" onClick={() => select([])}>
              ✕
            </button>
          </div>
        )}
        <ScrollBars vp={vp} strokes={strokes.current} page={page} onScroll={(x, y) => setView(x, y, view.current.z)} />
      </div>
      <AttachmentList files={files} />
    </article>
  );
}

/** Arrow keys move the page unless the focus is somewhere they mean something else (a text box, a slider, another page part). */
function arrowsMovePage(t: HTMLElement | null): boolean {
  if (!t || t === document.body) return true;
  if (t.closest(".ink-pop")) return false;
  return !!t.closest(".ink-note");
}

/** The part of the page in use: the writing (and the page size) plus room to go on, and wherever the page is now. */
function pageRange(vp: Viewport, strokes: Stroke[], sheet: Sheet) {
  const page = pagesOf(sheet);
  let x1 = page ? page.w * MM : 0;
  let y1 = page ? page.h * MM : 0;
  let x0 = 0;
  let y0 = 0;
  for (const s of strokes) {
    const b = shape(s).box;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
    if (b.x0 < x0) x0 = b.x0;
    if (b.y0 < y0) y0 = b.y0;
  }
  const w = vp.w / vp.z;
  const h = vp.h / vp.z;
  if (sheet === INFINITE) {
    // Room to go on every way from the writing.
    return {
      x0: Math.min(x0 - w / 2, vp.x),
      x1: Math.max(x1 + w / 2, vp.x + w),
      y0: Math.min(y0 - h / 2, vp.y),
      y1: Math.max(y1 + h / 2, vp.y + h),
    };
  }
  return {
    x0: Math.min(-GRID * 2, vp.x),
    x1: Math.max(x1 + (page ? GRID * 2 : w / 2), vp.x + w, w),
    y0: Math.min(-GRID * 2, vp.y),
    y1: Math.max(y1 + h / 2, vp.y + h, h),
  };
}

/**
 * Scroll bars along the bottom and the right side: drag a bar to move the page left and right
 * or up and down, or click beside it to move a screenful. They grow as the writing does.
 */
function ScrollBars(props: { vp: Viewport; strokes: Stroke[]; page: Sheet; onScroll: (x: number, y: number) => void }) {
  const { vp } = props;
  if (!vp.w || !vp.h) return null;
  const range = pageRange(vp, props.strokes, props.page);
  return (
    <>
      <ScrollBar axis="x" start={vp.x} shown={vp.w / vp.z} lo={range.x0} hi={range.x1} onMove={(x) => props.onScroll(x, vp.y)} />
      <ScrollBar axis="y" start={vp.y} shown={vp.h / vp.z} lo={range.y0} hi={range.y1} onMove={(y) => props.onScroll(vp.x, y)} />
    </>
  );
}

function ScrollBar(props: { axis: "x" | "y"; start: number; shown: number; lo: number; hi: number; onMove: (to: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ at: number; start: number; lo: number; hi: number } | null>(null);
  const { axis, start, shown, lo, hi } = props;
  const span = hi - lo;
  const size = Math.min(1, shown / span);
  const pos = Math.min(1 - size, Math.max(0, (start - lo) / span));
  const along = (e: React.PointerEvent) => (axis === "x" ? e.clientX : e.clientY);
  const length = () => {
    const r = track.current?.getBoundingClientRect();
    return r ? (axis === "x" ? r.width : r.height) : 1;
  };
  const label = axis === "x" ? "Move the page left and right" : "Move the page up and down";
  return (
    <div
      ref={track}
      className={`ink-scroll ink-scroll-${axis}`}
      title={label}
      onPointerDown={(e) => {
        // Beside the bar: move one screenful that way.
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const at = (along(e) - (axis === "x" ? r.left : r.top)) / length();
        props.onMove(start + (at < pos ? -shown : shown) * 0.9);
      }}
    >
      <div
        className="ink-scroll-thumb"
        role="scrollbar"
        aria-label={label}
        aria-orientation={axis === "x" ? "horizontal" : "vertical"}
        aria-valuenow={Math.round(pos * 100)}
        style={axis === "x" ? { left: `${pos * 100}%`, width: `${size * 100}%` } : { top: `${pos * 100}%`, height: `${size * 100}%` }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { at: along(e), start, lo, hi };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          props.onMove(d.start + ((along(e) - d.at) / length()) * (d.hi - d.lo));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      />
    </div>
  );
}

/** A small panel under a toolbar button; closes on a click elsewhere or Escape. */
function Popover(props: { onClose: () => void; children: ReactNode; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (ev: PointerEvent) => {
      const t = ev.target as Element | null;
      if (box.current?.contains(t) || t?.closest?.("[data-pop-anchor]")) return;
      props.onClose();
      // A tap on the board only closes the panel; it does not draw.
      if (t?.classList?.contains("ink-canvas")) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    };
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && props.onClose();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ink-pop" ref={box} role="dialog" aria-label={props.label}>
      {props.children}
    </div>
  );
}

/**
 * A tool button. A click picks the tool; holding it (or a right-click) opens its options,
 * shown by the little corner mark.
 */
function ToolButton(props: { active: boolean; label: string; icon: ReactNode; onPick: () => void; options?: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const hold = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const close = () => setOpen(false);
  return (
    <span className="ink-hold" data-pop-anchor={open ? "" : undefined}>
      <button
        type="button"
        className="note-tool ink-tool"
        aria-pressed={props.active}
        aria-haspopup={props.options ? "dialog" : undefined}
        aria-expanded={props.options ? open : undefined}
        title={props.options ? `${props.label} (hold for options)` : props.label}
        aria-label={props.label}
        onPointerDown={() => {
          held.current = false;
          if (!props.options) return;
          window.clearTimeout(hold.current);
          hold.current = window.setTimeout(() => {
            held.current = true;
            props.onPick();
            setOpen(true);
          }, HOLD_MS);
        }}
        onPointerUp={() => window.clearTimeout(hold.current)}
        onPointerLeave={() => window.clearTimeout(hold.current)}
        onContextMenu={(e) => {
          if (!props.options) return;
          e.preventDefault();
          window.clearTimeout(hold.current);
          props.onPick();
          setOpen(true);
        }}
        onClick={() => {
          if (held.current) return;
          // A second click on the chosen tool opens its options too.
          if (props.active && props.options) setOpen((o) => !o);
          else props.onPick();
        }}
      >
        {props.icon}
        {props.options && <span className="ink-hold-mark" aria-hidden="true" />}
      </button>
      {open && props.options && (
        <Popover label={`${props.label} options`} onClose={close}>
          {props.options(close)}
        </Popover>
      )}
    </span>
  );
}

function Choice(props: { checked: boolean; label: ReactNode; onChange: () => void; type?: "radio" | "checkbox"; name?: string }) {
  return (
    <label className="ink-choice">
      <input type={props.type ?? "radio"} name={props.name} checked={props.checked} onChange={props.onChange} />
      <span>{props.label}</span>
    </label>
  );
}

function pageLabel(sheet: Sheet): string {
  if (sheet === INFINITE) return "Infinite";
  const page = pagesOf(sheet);
  if (!page) return "Endless";
  const preset = PAGE_PRESETS.find(([, p]) => pagesOf(p) && samePage(p, page));
  return preset ? preset[0] : `${Math.round(page.w)} × ${Math.round(page.h)} mm`;
}

/** Page size: presets, or your own width and length in millimetres. */
function PageMenu(props: { page: Sheet; onPage: (p: Sheet) => void }) {
  const [w, setW] = useState(String(Math.round((pagesOf(props.page) ?? DEFAULT_PAGE).w)));
  const [h, setH] = useState(String(Math.round((pagesOf(props.page) ?? DEFAULT_PAGE).h)));
  const custom = pagesOf(props.page) !== null && !PAGE_PRESETS.some(([, p]) => samePage(p, props.page));
  const applyCustom = (ws: string, hs: string) => {
    const nw = parseFloat(ws);
    const nh = parseFloat(hs);
    if (nw >= 20 && nh >= 20 && nw <= 5000 && nh <= 5000) props.onPage({ w: nw, h: nh });
  };
  return (
    <>
      <span className="ink-pop-title">Page size</span>
      <span className="muted small">A dashed line shows where each PDF page ends.</span>
      {PAGE_PRESETS.map(([name, p]) => (
        <Choice
          key={name}
          name="ink-page"
          checked={!custom && samePage(p, props.page)}
          label={
            <>
              {name}{" "}
              {pagesOf(p) ? (
                <span className="muted small">{`${pagesOf(p)!.w} × ${pagesOf(p)!.h} mm`}</span>
              ) : p === INFINITE ? (
                <span className="muted small">no edges, goes on every way</span>
              ) : (
                <span className="muted small">goes on right and down</span>
              )}
            </>
          }
          onChange={() => props.onPage(p)}
        />
      ))}
      <Choice name="ink-page" checked={custom} label="Your own size" onChange={() => applyCustom(w, h)} />
      <div className="ink-page-size">
        <label>
          <span className="muted small">Width</span>
          <input type="number" min={20} max={5000} value={w} onChange={(e) => (setW(e.target.value), applyCustom(e.target.value, h))} />
        </label>
        <span aria-hidden="true">×</span>
        <label>
          <span className="muted small">Length</span>
          <input type="number" min={20} max={5000} value={h} onChange={(e) => (setH(e.target.value), applyCustom(w, e.target.value))} />
        </label>
        <span className="muted small">mm</span>
      </div>
    </>
  );
}

const SHAPE_NAMES: Record<ShapeKind, string> = { line: "Line", rect: "Rectangle", oval: "Oval" };
const LINE_NAMES: Record<LineStyle, string> = { s: "Solid", d: "Dashes", o: "Dots", do: "Dash-dot" };
const LINE_DASH: Record<LineStyle, string | undefined> = { s: undefined, d: "6 4", o: "0.1 4", do: "6 3 0.1 3" };

/** Shape options: which shape, its line, its fill and whether it has an outline. */
function ShapeMenu(props: { settings: Settings; onChange: (s: Partial<Settings>) => void }) {
  const s = props.settings;
  const closed = s.shape !== "line";
  return (
    <>
      <span className="ink-pop-title">Shape</span>
      <div className="ink-shape-row" role="group" aria-label="Shape">
        {SHAPES.map((k) => (
          <button key={k} type="button" className="note-tool ink-shape-pick" aria-pressed={s.shape === k} onClick={() => props.onChange({ shape: k, tool: "shape" })}>
            <ShapeIcon kind={k} />
            <span className="small">{SHAPE_NAMES[k]}</span>
          </button>
        ))}
      </div>
      <span className="muted small">Hold Shift while drawing for a square, a circle, or a line at 45° steps.</span>
      <span className="ink-pop-title">Line</span>
      <div className="ink-shape-row" role="group" aria-label="Line style">
        {LINES.map((l) => (
          <button key={l} type="button" className="note-tool ink-shape-pick" aria-pressed={s.line === l} title={LINE_NAMES[l]} onClick={() => props.onChange({ line: l })}>
            <svg className="ink-line-sample" viewBox="0 0 44 8" aria-hidden="true">
              <path d="M4 4H40" strokeDasharray={LINE_DASH[l]} />
            </svg>
            <span className="small">{LINE_NAMES[l]}</span>
          </button>
        ))}
      </div>
      <span className="muted small">Uses the pen size.</span>
      {closed && (
        <>
          <span className="ink-pop-title">Inside</span>
          <Choice name="ink-fill" checked={s.fill === "none"} label="Empty (no fill)" onChange={() => props.onChange({ fill: "none", outline: true })} />
          <Choice name="ink-fill" checked={s.fill === "soft"} label="Soft fill (see-through colour)" onChange={() => props.onChange({ fill: "soft" })} />
          <Choice name="ink-fill" checked={s.fill === "solid"} label="Solid fill" onChange={() => props.onChange({ fill: "solid" })} />
          <Choice
            type="checkbox"
            checked={s.outline || s.fill === "none"}
            label="Outline"
            onChange={() => s.fill !== "none" && props.onChange({ outline: !s.outline })}
          />
          {s.fill === "none" && <span className="muted small">An empty shape always has its outline.</span>}
        </>
      )}
    </>
  );
}

function ShapeIcon(props: { kind: ShapeKind }) {
  return (
    <Icon>
      {props.kind === "line" ? <path d="M4 16L16 4" /> : props.kind === "rect" ? <path d="M3.5 5.5h13v9h-13z" /> : <ellipse cx="10" cy="10" rx="7" ry="5" />}
    </Icon>
  );
}

/** Your own pen size: a slider and a box to type it in. The dot in use keeps it. */
function WidthMenu(props: { width: number; onWidth: (w: number) => void }) {
  const [text, setText] = useState(String(props.width));
  useEffect(() => {
    if (parseFloat(text) !== props.width) setText(String(props.width));
  }, [props.width]); // eslint-disable-line react-hooks/exhaustive-deps
  // The slider moves in fine steps for thin pens and bigger ones for thick pens.
  const toSlider = (w: number) => Math.round(Math.sqrt((w - MIN_WIDTH) / (MAX_WIDTH - MIN_WIDTH)) * 1000);
  const fromSlider = (v: number) => MIN_WIDTH + (v / 1000) ** 2 * (MAX_WIDTH - MIN_WIDTH);
  return (
    <>
      <span className="ink-pop-title">Pen size</span>
      <input
        type="range"
        className="ink-width-slider"
        min={0}
        max={1000}
        value={toSlider(props.width)}
        aria-label="Pen size"
        onChange={(e) => props.onWidth(fromSlider(Number(e.target.value)))}
      />
      <div className="ink-page-size">
        <label>
          <span className="muted small">Size</span>
          <input
            type="number"
            min={MIN_WIDTH}
            max={MAX_WIDTH}
            step={0.1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const n = parseFloat(e.target.value);
              if (n >= MIN_WIDTH && n <= MAX_WIDTH) props.onWidth(n);
            }}
          />
        </label>
        <span className="muted small">{`${MIN_WIDTH} to ${MAX_WIDTH}`}</span>
      </div>
      <span className="muted small">Each dot keeps its own size.</span>
    </>
  );
}

/** Behind the writing: dots, grid lines or nothing (and how far apart), and a paper texture. */
function BackdropMenu(props: { bg: Backdrop; onBg: (b: Partial<Backdrop>) => void }) {
  const { bg } = props;
  const mm = (units: number) => Math.round((units / MM) * 10) / 10;
  const [text, setText] = useState(String(mm(bg.gap)));
  const presets = [5, 8.5, 10, 15, 20];
  const setGap = (m: number) => {
    const units = Math.round(m * MM * 100) / 100;
    if (units >= MIN_GAP && units <= MAX_GAP) props.onBg({ gap: m === 8.5 ? DEFAULT_GAP : units });
  };
  return (
    <>
      <span className="ink-pop-title">Background</span>
      <div className="ink-shape-row" role="group" aria-label="Background">
        {(["dots", "lines", "grid", "none"] as const).map((k) => (
          <button key={k} type="button" className="note-tool ink-shape-pick" aria-pressed={bg.k === k} onClick={() => props.onBg({ k })}>
            <svg className="ink-icon" viewBox="0 0 20 20" aria-hidden="true">
              {k === "dots" ? (
                <path d="M5 5h.01M10 5h.01M15 5h.01M5 10h.01M10 10h.01M15 10h.01M5 15h.01M10 15h.01M15 15h.01" strokeWidth="2.2" />
              ) : k === "lines" ? (
                <path d="M3 5h14M3 10h14M3 15h14" />
              ) : k === "grid" ? (
                <path d="M3 7h14M3 13h14M7 3v14M13 3v14" />
              ) : (
                <path d="M3.5 3.5h13v13h-13z" />
              )}
            </svg>
            <span className="small">{k === "dots" ? "Dots" : k === "lines" ? "Lines" : k === "grid" ? "Grid" : "Plain"}</span>
          </button>
        ))}
      </div>
      {bg.k !== "none" && (
        <>
          <span className="muted small">How far apart</span>
          <div className="ink-zoom-presets">
            {presets.map((m) => (
              <button
                key={m}
                type="button"
                className="note-tool num"
                aria-pressed={mm(bg.gap) === m}
                onClick={() => (setText(String(m)), setGap(m))}
              >
                {m} mm
              </button>
            ))}
          </div>
          <div className="ink-page-size">
            <label>
              <span className="muted small">Your own</span>
              <input
                type="number"
                min={2}
                max={100}
                step={0.5}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  const n = parseFloat(e.target.value);
                  if (n >= 2 && n <= 100) setGap(n);
                }}
              />
            </label>
            <span className="muted small">mm</span>
          </div>
        </>
      )}
    </>
  );
}

function InkToolbar(props: {
  settings: Settings;
  zoom: number;
  page: Sheet;
  bg: Backdrop;
  onBg: (b: Partial<Backdrop>) => void;
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  empty: boolean;
  onChange: (s: Partial<Settings>) => void;
  onColor: (color: string) => void;
  onPage: (p: Sheet) => void;
  onUndo: () => void;
  onRedo: () => void;
  onPaste: () => void;
  onZoom: (factor: number) => void;
  onResetView: () => void;
  onClear: () => void;
}) {
  const s = props.settings;
  const { tool, color } = s;
  const width = s.widths[s.slot];
  const custom = useRef<HTMLInputElement>(null);
  const [pageOpen, setPageOpen] = useState(false);
  const [widthOpen, setWidthOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const plain = (label: string, icon: ReactNode, action: () => void, disabled = false) => (
    <button type="button" className="note-tool ink-tool" title={label} aria-label={label} disabled={disabled} onClick={action}>
      {icon}
    </button>
  );
  /** − and + change the dot in use, and it keeps that size. */
  const setWidth = (w: number) => {
    const widths = s.widths.slice() as Settings["widths"];
    widths[s.slot] = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)) * 10) / 10;
    props.onChange({ widths });
  };
  const known = INK_COLORS.some(([v]) => v === color);
  const pick = (t: Tool) => () => props.onChange({ tool: t });

  return (
    <div className="note-toolbar ink-toolbar" role="toolbar" aria-label="Drawing tools">
      <div className="ink-group">
        <ToolButton
          active={tool === "pen"}
          label="Pen (Ctrl+1)"
          icon={<PencilIcon />}
          onPick={pick("pen")}
          options={() => (
            <>
              <span className="ink-pop-title">Pen width</span>
              <Choice type="checkbox" checked={s.pressure} label="Pen pressure changes the width (stylus)" onChange={() => props.onChange({ pressure: !s.pressure })} />
              <Choice type="checkbox" checked={s.speed} label="Writing speed changes the width" onChange={() => props.onChange({ speed: !s.speed })} />
              <span className="muted small">{!s.pressure && !s.speed ? "Every line keeps one width." : "Turn both off for an even width."}</span>
            </>
          )}
        />
        <ToolButton
          active={tool === "eraser"}
          label="Eraser (Ctrl+2, or hold the right mouse button)"
          icon={<EraserIcon />}
          onPick={pick("eraser")}
          options={(close) => (
            <>
              <span className="ink-pop-title">Eraser</span>
              <Choice name="ink-eraser" checked={s.eraser === "stroke"} label="Whole strokes: a touch rubs out the whole line" onChange={() => (props.onChange({ eraser: "stroke" }), close())} />
              <Choice name="ink-eraser" checked={s.eraser === "precise"} label="Precise: rubs out only what the eraser goes over" onChange={() => (props.onChange({ eraser: "precise" }), close())} />
            </>
          )}
        />
        <ToolButton active={tool === "marker"} label="Marker (Ctrl+3)" icon={<MarkerIcon />} onPick={pick("marker")} />
        <ToolButton
          active={tool === "shape"}
          label={`${SHAPE_NAMES[s.shape]} (Ctrl+4, hold Shift for ${s.shape === "line" ? "straight angles" : s.shape === "rect" ? "a square" : "a circle"})`}
          icon={<ShapeIcon kind={s.shape} />}
          onPick={pick("shape")}
          options={() => <ShapeMenu settings={s} onChange={props.onChange} />}
        />
        <ToolButton
          active={tool === "select"}
          label={s.select === "box" ? "Box select (Ctrl+5)" : "Lasso select (Ctrl+5)"}
          icon={s.select === "box" ? <BoxSelectIcon /> : <LassoIcon />}
          onPick={pick("select")}
          options={(close) => (
            <>
              <span className="ink-pop-title">Select</span>
              <Choice name="ink-select" checked={s.select === "lasso"} label="Lasso: draw round what you want" onChange={() => (props.onChange({ select: "lasso" }), close())} />
              <Choice name="ink-select" checked={s.select === "box"} label="Box: drag a rectangle over it" onChange={() => (props.onChange({ select: "box" }), close())} />
              <span className="muted small">Drag to move it.</span>
            </>
          )}
        />
        <ToolButton active={tool === "hand"} label="Move the page (Ctrl+6, arrow keys, or hold Space or the middle mouse button)" icon={<HandIcon />} onPick={pick("hand")} />
      </div>
      <div className="ink-group ink-colors" role="group" aria-label="Ink colour">
        {INK_COLORS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="note-swatch ink-swatch"
            title={label}
            aria-label={label}
            aria-pressed={color === value}
            style={{ background: value }}
            onClick={() => props.onColor(value)}
          />
        ))}
        <button
          type="button"
          className="note-swatch ink-swatch note-swatch-custom"
          title="Pick any colour"
          aria-label="Pick any colour"
          aria-pressed={!known}
          style={known ? undefined : { background: color }}
          onClick={() => custom.current?.click()}
        >
          {known ? <svg className="swatch-plus" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5v7M1.5 5h7" /></svg> : null}
        </button>
        <input ref={custom} type="color" className="sr-only" tabIndex={-1} aria-hidden="true" value={color} onChange={(ev) => props.onColor(ev.target.value)} />
      </div>
      <div className="ink-group ink-width" role="group" aria-label="Width">
        {plain("Thinner (changes this dot)", "−", () => setWidth(width <= 1 ? width - 0.1 : width - 0.5), width <= MIN_WIDTH)}
        <span className="ink-hold" data-pop-anchor={widthOpen ? "" : undefined}>
          <button
            type="button"
            className="note-tool ink-width-value num"
            title="Your own size: click to type it or slide it"
            aria-haspopup="dialog"
            aria-expanded={widthOpen}
            onClick={() => setWidthOpen((o) => !o)}
          >
            {width.toFixed(1)}
          </button>
          {widthOpen && (
            <Popover label="Pen size" onClose={() => setWidthOpen(false)}>
              <WidthMenu width={width} onWidth={setWidth} />
            </Popover>
          )}
        </span>
        {plain("Thicker (changes this dot)", "+", () => setWidth(width < 1 ? width + 0.1 : width + 0.5), width >= MAX_WIDTH)}
        {s.widths.map((w, i) => (
          <button
            key={i}
            type="button"
            className="note-tool ink-tool ink-dot"
            aria-pressed={s.slot === i}
            title={`Width ${w.toFixed(1)}`}
            aria-label={`Width ${w.toFixed(1)}`}
            onClick={() => props.onChange({ slot: i as Settings["slot"] })}
          >
            <span style={{ width: Math.min(20, 2 + w * 1.8), height: Math.min(20, 2 + w * 1.8) }} />
          </button>
        ))}
      </div>
      <div className="ink-group">
        {plain("Undo (Ctrl+Z)", <UndoIcon />, props.onUndo, !props.canUndo)}
        {plain("Redo (Ctrl+Y)", <UndoIcon redo />, props.onRedo, !props.canRedo)}
        {plain("Paste (Ctrl+V)", <PasteIcon />, props.onPaste, !props.canPaste)}
      </div>
      <div className="ink-group ink-zoom">
        {plain("Zoom out (Ctrl −, or Ctrl + mouse wheel)", "−", () => props.onZoom(0.8))}
        <span className="ink-hold" data-pop-anchor={zoomOpen ? "" : undefined}>
          <button
            type="button"
            className="note-tool ink-zoom-value num"
            title="Zoom: Ctrl + mouse wheel, pinch, or Ctrl+ and Ctrl−. Click for more."
            aria-haspopup="dialog"
            aria-expanded={zoomOpen}
            onClick={() => setZoomOpen((o) => !o)}
          >
            {Math.round(props.zoom * 100)}%
          </button>
          {zoomOpen && (
            <Popover label="Zoom" onClose={() => setZoomOpen(false)}>
              <span className="ink-pop-title">Zoom</span>
              <input
                type="range"
                className="ink-width-slider"
                min={MIN_ZOOM * 100}
                max={MAX_ZOOM * 100}
                step={5}
                value={Math.round(props.zoom * 100)}
                aria-label="Zoom"
                onChange={(e) => props.onZoom(Number(e.target.value) / 100 / props.zoom)}
              />
              <div className="ink-zoom-presets">
                {[50, 75, 100, 150, 200, 300].map((pct) => (
                  <button key={pct} type="button" className="note-tool num" aria-pressed={Math.round(props.zoom * 100) === pct} onClick={() => props.onZoom(pct / 100 / props.zoom)}>
                    {pct}%
                  </button>
                ))}
              </div>
              <button type="button" className="note-tool" onClick={() => (props.onResetView(), setZoomOpen(false))}>
                Back to 100 % and the top of the page
              </button>
              <span className="muted small">Ctrl + mouse wheel or a two-finger pinch zooms where you point. Ctrl+ and Ctrl− zoom too, Ctrl+0 is 100 %.</span>
            </Popover>
          )}
        </span>
        {plain("Zoom in (Ctrl +, or Ctrl + mouse wheel)", "+", () => props.onZoom(1.25))}
      </div>
      <div className="ink-group">
        <span className="ink-hold" data-pop-anchor={pageOpen ? "" : undefined}>
          <button
            type="button"
            className="note-tool ink-tool ink-page-button"
            aria-haspopup="dialog"
            aria-expanded={pageOpen}
            title="Page size"
            onClick={() => setPageOpen((o) => !o)}
          >
            <PageIcon /> <span className="small">{pageLabel(props.page)}</span>
          </button>
          {pageOpen && (
            <Popover label="Page size" onClose={() => setPageOpen(false)}>
              <PageMenu page={props.page} onPage={props.onPage} />
              <BackdropMenu bg={props.bg} onBg={props.onBg} />
            </Popover>
          )}
        </span>
        {plain("Clear the page (Undo brings it back)", <TrashIcon />, props.onClear, props.empty)}
      </div>
    </div>
  );
}

const Icon = (props: { children: ReactNode }) => (
  <svg className="ink-icon" viewBox="0 0 20 20" aria-hidden="true">
    {props.children}
  </svg>
);

/** The pencil that marks handwritten notes everywhere. */
export function PencilIcon() {
  return (
    <Icon>
      <path d="M13.5 3.5l3 3L7 16H4v-3z M11.5 5.5l3 3" />
    </Icon>
  );
}

function MarkerIcon() {
  return (
    <Icon>
      <path d="M12 3l5 5-6.5 6.5-5-5z M5.5 9.5L3.5 14l2.5 2.5 4.5-2" />
      <path d="M3 18h7" />
    </Icon>
  );
}

function EraserIcon() {
  return (
    <Icon>
      <path d="M11 4l5 5-7 7H5l-2-2z M7.5 7.5l5 5 M8 16h9" />
    </Icon>
  );
}

function HandIcon() {
  return (
    <Icon>
      <path d="M6.5 10V5a1.2 1.2 0 0 1 2.4 0v4 M8.9 9V3.8a1.2 1.2 0 0 1 2.4 0V9 M11.3 9V4.8a1.2 1.2 0 0 1 2.4 0V10 M13.7 10V7.5a1.2 1.2 0 0 1 2.4 0V12c0 3-2 5-5 5h-1c-2 0-3-1-4-2.5L4 11.5a1.2 1.2 0 0 1 2-1.3l.5.8" />
    </Icon>
  );
}

function UndoIcon(props: { redo?: boolean }) {
  return (
    <Icon>
      <g transform={props.redo ? "translate(20 0) scale(-1 1)" : undefined}>
        <path d="M7 5L3.5 8.5 7 12 M3.5 8.5H12a4.5 4.5 0 0 1 0 9H9" />
      </g>
    </Icon>
  );
}

function TrashIcon() {
  return (
    <Icon>
      <path d="M4 6h12 M8 6V4h4v2 M5.5 6l1 11h7l1-11 M8.5 9v5 M11.5 9v5" />
    </Icon>
  );
}

/** "Aa" for typed notes, in the new-note choice. */
export function TextNoteIcon() {
  return (
    <Icon>
      <path d="M3 15l3.5-10L10 15 M4.3 11.5h4.4 M12 9.5c.6-.8 1.4-1 2.3-1 1.5 0 2.2.9 2.2 2.2V15 M16.5 12.2c-2.8 0-4.6.5-4.6 1.6 0 .8.6 1.3 1.6 1.3 1.6 0 3-1 3-2.9" />
    </Icon>
  );
}

function LassoIcon() {
  return (
    <Icon>
      <path d="M10 3.5c4 0 7 1.8 7 4.2s-3 4.2-7 4.2-7-1.8-7-4.2 3-4.2 7-4.2z" strokeDasharray="2 2" />
      <path d="M5.5 11c-.8 1.2-.6 2.6.6 3.2 1.2.6 1.4 1.8.6 2.8" />
    </Icon>
  );
}

function BoxSelectIcon() {
  return (
    <Icon>
      <path d="M3.5 3.5h13v13h-13z" strokeDasharray="2 2" />
    </Icon>
  );
}

function PasteIcon() {
  return (
    <Icon>
      <path d="M7 4H5v13.5h10V4h-2 M7.5 2.5h5V5h-5z M8 9.5h4 M8 12.5h4" />
    </Icon>
  );
}

function PageIcon() {
  return (
    <Icon>
      <path d="M5 2.5h10v15H5z M5 10h10" strokeDasharray="0" />
      <path d="M7 6h6" />
    </Icon>
  );
}
