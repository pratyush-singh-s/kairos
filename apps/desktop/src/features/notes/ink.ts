
/**
 * A handwritten note's drawing, stored as JSON in the note's body:
 * `{"v":1,"page":{"w":210,"h":297},"strokes":[{"t":"pen","c":"#ffffff","w":2,"m":"p","p":[x,y,pressure, ...]}]}`.
 * Points are in page units (CSS pixels at 100 % zoom); y grows down the page.
 */
export interface Stroke {
  /** pen: pressure-shaped ink. marker: a wide see-through highlighter. */
  t: "pen" | "marker";
  /** Colour, #rrggbb. */
  c: string;
  /** Width setting (the number in the toolbar). */
  w: number;
  /** x, y, pressure (0-1), flattened. */
  p: number[];
  /** How the width changes along the stroke: p = pen pressure, v = speed, c = constant. */
  m?: "p" | "v" | "c";
  /** Before 0.21.36.B: 1 meant the width came from the speed (now m: "v"). */
  s?: 1;
  /**
   * A shape (line, rectangle, oval): the points are drawn as straight lines of one width, in
   * this line style (s = solid, d = dashes, o = dots, do = dash-dot). Apps before 0.21.47.B
   * show it as a plain pen line.
   */
  g?: LineStyle;
  /** A rectangle's or oval's fill, in the stroke's colour: how see-through (1 = solid). None when missing. */
  f?: number;
  /** 0: the shape has no outline (only its fill). */
  o?: 0;
  /**
   * 1: the width setting is in page units, 1:1 (like rnote), since 0.21.87.B. Missing: older
   * lines, drawn 1.6 times their setting as before so they keep their look.
   */
  u?: 1;
}

export type LineStyle = "s" | "d" | "o" | "do";
export type ShapeKind = "line" | "rect" | "oval";

export const isShape = (s: Stroke) => s.g !== undefined;

/** The size of one PDF page, in millimetres. */
export interface Page {
  w: number;
  h: number;
}

/**
 * What the board is: pages of a size, null for one endless page (goes on right and down), or
 * "infinite" for a board with no edges at all (goes on every way, also left and up).
 */
export type Sheet = Page | null | "infinite";

export const INFINITE = "infinite" as const;

/** The page size when the board has pages, else null. */
export const pagesOf = (s: Sheet): Page | null => (s && typeof s === "object" ? s : null);

/** What is drawn behind the writing: dots, a grid of lines or nothing, and a paper texture. */
export interface Backdrop {
  k: "dots" | "lines" | "grid" | "none";
  /** Space between dots or lines, in page units. */
  gap: number;
}

export const DEFAULT_GAP = 32;
export const DEFAULT_BACKDROP: Backdrop = { k: "dots", gap: DEFAULT_GAP };
export const MIN_GAP = 7;
export const MAX_GAP = 400;

const sameBackdrop = (a: Backdrop, b: Backdrop) => a.k === b.k && a.gap === b.gap;

function validBackdrop(b: unknown): Backdrop {
  const q = (b ?? {}) as Partial<Backdrop>;
  return {
    k: q.k === "grid" || q.k === "lines" || q.k === "none" ? q.k : "dots",
    gap: typeof q.gap === "number" && q.gap >= MIN_GAP && q.gap <= MAX_GAP ? q.gap : DEFAULT_GAP,
  };
}

export interface InkDoc {
  v: 1;
  strokes: Stroke[];
  page: Sheet;
  bg: Backdrop;
}

/** Page units per millimetre (CSS pixels at 96 per inch). */
export const MM = 96 / 25.4;

export const PAGE_PRESETS: [string, Sheet][] = [
  ["A4", { w: 210, h: 297 }],
  ["A4 landscape", { w: 297, h: 210 }],
  ["A5", { w: 148, h: 210 }],
  ["A3", { w: 297, h: 420 }],
  ["Letter", { w: 215.9, h: 279.4 }],
  ["No pages (endless)", null],
  ["Infinite", INFINITE],
];

/** New handwritten notes start on A4. */
export const DEFAULT_PAGE: Page = { w: 210, h: 297 };

export const samePage = (a: Sheet, b: Sheet) => {
  const pa = pagesOf(a);
  const pb = pagesOf(b);
  return pa && pb ? pa.w === pb.w && pa.h === pb.h : a === b;
};

const validPage = (p: unknown): Sheet => {
  if (p === INFINITE) return INFINITE;
  const q = p as Partial<Page> | null;
  return q && typeof q.w === "number" && typeof q.h === "number" && q.w >= 20 && q.h >= 20 && q.w <= 5000 && q.h <= 5000 ? { w: q.w, h: q.h } : null;
};

export function parseInk(body: string): InkDoc {
  if (!body) return { v: 1, strokes: [], page: DEFAULT_PAGE, bg: DEFAULT_BACKDROP };
  try {
    const doc = JSON.parse(body) as Partial<Omit<InkDoc, "bg">> & { bg?: unknown };
    const strokes = Array.isArray(doc.strokes) ? doc.strokes.filter((s) => s && Array.isArray(s.p) && s.p.length >= 3) : [];
    return { v: 1, strokes, page: validPage(doc.page), bg: validBackdrop(doc.bg) };
  } catch {
    return { v: 1, strokes: [], page: DEFAULT_PAGE, bg: DEFAULT_BACKDROP };
  }
}

/** "" for an empty note on the default page (what a new note is). */
export function serializeInk(strokes: Stroke[], page: Sheet, bg: Backdrop = DEFAULT_BACKDROP): string {
  const plainBg = sameBackdrop(bg, DEFAULT_BACKDROP);
  if (!strokes.length && samePage(page, DEFAULT_PAGE) && plainBg) return "";
  return JSON.stringify({ v: 1, ...(page ? { page } : {}), ...(plainBg ? {} : { bg }), strokes });
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Adds a point, rounded so the saved note stays small. */
export function pushPoint(s: Stroke, x: number, y: number, pressure: number) {
  s.p.push(round1(x), round1(y), round2(Math.min(1, Math.max(0.05, pressure))));
}

/** Pen sizes, in page units, for each width setting: 1:1 now (u: 1), 1.6x for older lines. */
const PEN_SCALE = 1;
const OLD_PEN_SCALE = 1.6;
const MARKER_SCALE = 7;
export const MARKER_ALPHA = 0.35;

const modeOf = (s: Stroke) => s.m ?? (s.s === 1 ? "v" : "p");
/** How wide a pen or marker line of width setting `w` is, in page units. */
export const penSize = (marker: boolean, w: number) => w * (marker ? MARKER_SCALE : PEN_SCALE);
const thickness = (s: Stroke) => (s.t === "marker" ? s.w * MARKER_SCALE : s.w * (s.u === 1 ? PEN_SCALE : OLD_PEN_SCALE));

function points(s: Stroke): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 2 < s.p.length; i += 3) out.push([s.p[i]!, s.p[i + 1]!, s.p[i + 2]!]);
  return out;
}

/** A shape's line as an SVG path to draw (not fill), in page units. */
export function shapeSvg(s: Stroke): string {
  const f = (n: number) => Math.round(n * 100) / 100;
  let d = "";
  for (let i = 0; i + 1 < s.p.length; i += 3) d += `${i ? "L" : "M"}${f(s.p[i]!)} ${f(s.p[i + 1]!)}`;
  return d;
}

/** The dash pattern of a shape's line, in page units ([] = solid). Dots are round line caps. */
export function dashOf(s: Stroke): number[] {
  const lw = thickness(s);
  switch (s.g) {
    case "d":
      return [lw * 4, lw * 2.5];
    case "o":
      return [0.01, lw * 2.2];
    case "do":
      return [lw * 4, lw * 2.2, 0.01, lw * 2.2];
    default:
      return [];
  }
}

/** Line width of a stroke, in page units. */
export const widthOf = (s: Stroke) => thickness(s);

/**
 * The points of a shape dragged from (x0, y0) to (x1, y1). `even`: Shift is held, so a
 * rectangle is a square, an oval a circle, and a line snaps to steps of 45°.
 */
export function shapePoints(kind: ShapeKind, x0: number, y0: number, x1: number, y1: number, even: boolean): number[] {
  let dx = x1 - x0;
  let dy = y1 - y0;
  if (even) {
    if (kind === "line") {
      const len = Math.hypot(dx, dy);
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      dx = Math.cos(a) * len;
      dy = Math.sin(a) * len;
    } else {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * m;
    }
  }
  const out: number[] = [];
  const add = (x: number, y: number) => out.push(round1(x), round1(y), 0.5);
  if (kind === "line") {
    add(x0, y0);
    add(x0 + dx, y0 + dy);
  } else if (kind === "rect") {
    add(x0, y0);
    add(x0 + dx, y0);
    add(x0 + dx, y0 + dy);
    add(x0, y0 + dy);
    add(x0, y0);
  } else {
    const cx = x0 + dx / 2;
    const cy = y0 + dy / 2;
    const rx = Math.abs(dx) / 2;
    const ry = Math.abs(dy) / 2;
    const n = Math.max(24, Math.min(160, Math.round((rx + ry) / 2)));
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      add(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    }
  }
  return out;
}

/**
 * The pen's ink as an SVG path to fill, in page units. Drawn the way note apps (rnote,
 * Xournal++, OneNote) draw a pen: the points are smoothed into a curve, each point gets a
 * width (from the pen's pressure, the writing speed, or always the same), and the line is a row of
 * round-ended pieces from point to point. A dot is a round dot of the pen's width, a short drag a
 * short round line, and a sharp turn stays round, with no blobs or gaps.
 * All pieces turn the same way round, so filling them together (nonzero) makes one clean shape.
 */
export function strokeSvg(s: Stroke, _last = true): string {
  const marker = s.t === "marker";
  const mode = marker ? "c" : modeOf(s);
  const size = thickness(s);
  const raw = points(s);
  if (!raw.length) return "";

  // 1. Smooth the hand's wobble: each point moves part of the way toward where the pen went.
  //    The last point is the pen's real last point, so the line ends where it was lifted.
  const follow = marker ? 0.5 : 0.35;
  const sm: number[][] = [raw[0]!.slice()];
  for (let i = 1; i < raw.length; i++) {
    const prev = sm[sm.length - 1]!;
    const p = raw[i]!;
    const q = [prev[0]! + (p[0]! - prev[0]!) * (1 - follow), prev[1]! + (p[1]! - prev[1]!) * (1 - follow), p[2]!];
    if (Math.hypot(q[0]! - prev[0]!, q[1]! - prev[1]!) > 0.15) sm.push(q);
  }
  const end = raw[raw.length - 1]!;
  const lastSm = sm[sm.length - 1]!;
  if (sm.length > 1 || Math.hypot(end[0]! - lastSm[0]!, end[1]! - lastSm[1]!) > 0.15) sm.push(end.slice());

  // 2. The half-width at each point.
  //    Both pressure and speed change slowly along the line: a pen's reports and the gaps
  //    between mouse events jump about, and following them closely made the line beaded.
  const radii: number[] = [];
  let r = size / 2;
  let pressure = sm[0]![2]!;
  const steps: number[] = [];
  for (let i = 0; i < sm.length; i++) {
    if (mode === "p") {
      pressure += (sm[i]![2]! - pressure) * 0.35;
      r = Math.max(0.25, size * (0.2 + 0.6 * pressure));
    } else if (mode === "v" && i > 0) {
      // Faster writing makes the line clearly thinner, slower fuller (like ink from a brush pen):
      // from about 1.3x the width when slow down to about 0.3x when very fast.
      // Speed = the average step over the last few points, and the width eases toward its target,
      // so it swells and thins smoothly instead of jumping.
      steps.push(Math.hypot(sm[i]![0]! - sm[i - 1]![0]!, sm[i]![1]! - sm[i - 1]![1]!));
      if (steps.length > 8) steps.shift();
      const step = steps.reduce((a, b) => a + b, 0) / steps.length;
      const target = (size / 2) * (0.3 + 1.0 * Math.exp(-step / (size * 1.5 + 3)));
      r = Math.max(0.15, r + (target - r) * 0.14);
    }
    radii.push(r);
  }

  const f = (n: number) => Math.round(n * 10) / 10;
  // A full circle, the same way round as the pieces.
  const circle = (x: number, y: number, rr: number) =>
    `M${f(x - rr)} ${f(y)}A${f(rr)} ${f(rr)} 0 1 0 ${f(x + rr)} ${f(y)}A${f(rr)} ${f(rr)} 0 1 0 ${f(x - rr)} ${f(y)}Z`;
  if (sm.length === 1) return circle(sm[0]![0]!, sm[0]![1]!, radii[0]!);

  // 3. A smooth curve through the points (centripetal Catmull-Rom: no loops or kinks where the
  //    points are unevenly spaced), in short steps.
  const curve: number[][] = [];
  for (let i = 0; i + 1 < sm.length; i++) {
    const p0 = sm[Math.max(0, i - 1)]!;
    const p1 = sm[i]!;
    const p2 = sm[i + 1]!;
    const p3 = sm[Math.min(sm.length - 1, i + 2)]!;
    const len = Math.hypot(p2[0]! - p1[0]!, p2[1]! - p1[1]!);
    // Short steps (about one page unit), so the curve stays round when zoomed in far.
    const n = Math.max(1, Math.min(48, Math.ceil(len)));
    const knot = (a: number[], b: number[]) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!)));
    const t0 = 0;
    const t1 = t0 + (p0 === p1 ? knot(p1, p2) : knot(p0, p1));
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + (p3 === p2 ? knot(p1, p2) : knot(p2, p3));
    const at = (k: 0 | 1, t: number) => {
      const a1 = ((t1 - t) / (t1 - t0)) * p0[k]! + ((t - t0) / (t1 - t0)) * p1[k]!;
      const a2 = ((t2 - t) / (t2 - t1)) * p1[k]! + ((t - t1) / (t2 - t1)) * p2[k]!;
      const a3 = ((t3 - t) / (t3 - t2)) * p2[k]! + ((t - t2) / (t3 - t2)) * p3[k]!;
      const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
      const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
      return ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
    };
    for (let k = 0; k < n; k++) {
      const u = k / n;
      const t = t1 + (t2 - t1) * u;
      curve.push([at(0, t), at(1, t), radii[i]! + (radii[i + 1]! - radii[i]!) * u]);
    }
  }
  const tail = sm[sm.length - 1]!;
  curve.push([tail[0]!, tail[1]!, radii[radii.length - 1]!]);

  // 4. One outline around the whole line: along its left edge, round the end, back along its
  //    right edge and round the start. A single smooth edge (drawing many overlapping pieces
  //    made little bumps along the edge where they met).
  const pts = curve.filter((q, i) => i === 0 || Math.hypot(q[0]! - curve[i - 1]![0]!, q[1]! - curve[i - 1]![1]!) > 0.05);
  if (pts.length < 2) return circle(sm[0]![0]!, sm[0]![1]!, radii[0]!);
  const dirs: [number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1]![0]! - pts[i]![0]!;
    const dy = pts[i + 1]![1]! - pts[i]![1]!;
    const l = Math.hypot(dx, dy) || 1;
    dirs.push([dx / l, dy / l]);
  }
  const left: number[][] = [];
  const right: number[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = dirs[Math.max(0, i - 1)]!;
    const b = dirs[Math.min(dirs.length - 1, i)]!;
    let ux = a[0] + b[0];
    let uy = a[1] + b[1];
    const l = Math.hypot(ux, uy);
    if (l < 1e-3) [ux, uy] = b;
    else {
      ux /= l;
      uy /= l;
    }
    const rr = pts[i]![2]!;
    left.push([pts[i]![0]! - uy * rr, pts[i]![1]! + ux * rr]);
    right.push([pts[i]![0]! + uy * rr, pts[i]![1]! - ux * rr]);
  }
  // The edges are drawn as smooth curves (each point is a control point, the curve passes
  // through the midpoints between them) and the ends as true half circles, so the line stays a
  // clean vector shape at any zoom instead of a chain of short straight pieces.
  const g = (n: number) => Math.round(n * 1000) / 1000;
  const smooth = (list: number[][]) => {
    let out = "";
    for (let i = 1; i < list.length - 1; i++) {
      const a = list[i]!;
      const b = list[i + 1]!;
      out += `Q${g(a[0]!)} ${g(a[1]!)} ${g((a[0]! + b[0]!) / 2)} ${g((a[1]! + b[1]!) / 2)}`;
    }
    const z = list[list.length - 1]!;
    return out + `L${g(z[0]!)} ${g(z[1]!)}`;
  };
  // A half circle from one edge to the other, the same way round as before (sweep 0).
  const cap = (to: number[], rr: number) => `A${g(rr)} ${g(rr)} 0 0 0 ${g(to[0]!)} ${g(to[1]!)}`;
  const last = pts.length - 1;
  const back = right.slice().reverse();
  let d = `M${g(left[0]![0]!)} ${g(left[0]![1]!)}`;
  d += smooth(left);
  d += cap(back[0]!, pts[last]![2]!);
  d += smooth(back);
  d += cap(left[0]!, pts[0]![2]!);
  return d + "Z";
}

/** The stroke's outline as a filled shape, in page units. */
export const strokePath = (s: Stroke, last = true) => new Path2D(isShape(s) ? shapeSvg(s) : strokeSvg(s, last));

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The area a stroke covers, its width included. */
export function strokeBox(s: Stroke): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < s.p.length; i += 3) {
    const x = s.p[i]!;
    const y = s.p[i + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const pad = thickness(s);
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** The box around several strokes, or null when there are none. */
export function boxOf(strokes: Stroke[]): Box | null {
  if (!strokes.length) return null;
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of strokes) {
    const sb = strokeBox(s);
    b.x0 = Math.min(b.x0, sb.x0);
    b.y0 = Math.min(b.y0, sb.y0);
    b.x1 = Math.max(b.x1, sb.x1);
    b.y1 = Math.max(b.y1, sb.y1);
  }
  return b;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** True when the eraser at (x, y) with radius r touches the stroke. */
export function touches(s: Stroke, box: Box, x: number, y: number, r: number): boolean {
  if (x < box.x0 - r || x > box.x1 + r || y < box.y0 - r || y > box.y1 + r) return false;
  const reach = r + thickness(s) / 2;
  const p = s.p;
  if (p.length < 6) return Math.hypot(x - p[0]!, y - p[1]!) <= reach;
  for (let i = 0; i + 5 < p.length; i += 3) {
    if (segmentDistance(x, y, p[i]!, p[i + 1]!, p[i + 3]!, p[i + 4]!) <= reach) return true;
  }
  return false;
}

/**
 * Precise erasing: rubs out only the part of the stroke under the eraser, leaving the rest as
 * one or more strokes. Returns null when the eraser does not touch it.
 */
export function rubOut(s: Stroke, x: number, y: number, r: number): Stroke[] | null {
  const reach = r + thickness(s) / 4;
  const step = Math.max(0.75, r / 3);
  // Add points along long straight runs, so the middle of a line can be rubbed out too.
  const pts: number[] = [];
  const p = s.p;
  for (let i = 0; i + 2 < p.length; i += 3) {
    if (i > 0) {
      const [ax, ay, ap] = [p[i - 3]!, p[i - 2]!, p[i - 1]!];
      const [bx, by, bp] = [p[i]!, p[i + 1]!, p[i + 2]!];
      const n = Math.floor(Math.hypot(bx - ax, by - ay) / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        pts.push(round1(ax + (bx - ax) * t), round1(ay + (by - ay) * t), round2(ap + (bp - ap) * t));
      }
    }
    pts.push(p[i]!, p[i + 1]!, p[i + 2]!);
  }
  const pieces: number[][] = [[]];
  let hit = false;
  for (let i = 0; i + 2 < pts.length; i += 3) {
    if (Math.hypot(pts[i]! - x, pts[i + 1]! - y) <= reach) {
      hit = true;
      if (pieces[pieces.length - 1]!.length) pieces.push([]);
    } else pieces[pieces.length - 1]!.push(pts[i]!, pts[i + 1]!, pts[i + 2]!);
  }
  if (!hit) return null;
  // Pieces of a filled shape are open lines: they keep only the outline.
  const { f: _fill, o: _outline, ...rest } = s;
  const base: Stroke = isShape(s) ? rest : s;
  return pieces.filter((q) => q.length >= 6).map((q) => ({ ...base, p: q }));
}

/** True when (x, y) is inside the polygon (flattened x, y pairs). */
export function insidePolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i]!;
    const yi = poly[i + 1]!;
    const xj = poly[j]!;
    const yj = poly[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A stroke counts as picked when most of it lies inside the area. */
export function pickedBy(s: Stroke, inside: (x: number, y: number) => boolean): boolean {
  let n = 0;
  let total = 0;
  for (let i = 0; i + 1 < s.p.length; i += 3) {
    total++;
    if (inside(s.p[i]!, s.p[i + 1]!)) n++;
  }
  return total > 0 && n / total >= 0.5;
}

/** A copy of the stroke moved by (dx, dy). */
export function moved(s: Stroke, dx: number, dy: number): Stroke {
  const p = s.p.slice();
  for (let i = 0; i + 1 < p.length; i += 3) {
    p[i] = round1(p[i]! + dx);
    p[i + 1] = round1(p[i + 1]! + dy);
  }
  return { ...s, p };
}
