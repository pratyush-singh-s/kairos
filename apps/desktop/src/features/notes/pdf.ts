import { LineCapStyle, PDFDocument, PDFPage, clip, closePath, endPath, lineTo, moveTo, popGraphicsState, pushGraphicsState, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import regularUrl from "../../assets/fonts/DejaVuSans.ttf?url";
import boldUrl from "../../assets/fonts/DejaVuSans-Bold.ttf?url";
import italicUrl from "../../assets/fonts/DejaVuSans-Oblique.ttf?url";
import boldItalicUrl from "../../assets/fonts/DejaVuSans-BoldOblique.ttf?url";
import type { Note } from "../../ipc/notes";
import { MARKER_ALPHA, MM, dashOf, isShape, pagesOf, parseInk, shapeSvg, strokeBox, strokeSvg, widthOf, type Page, type Stroke } from "./ink";

/** "light": white paper, light ink made dark so it prints. "dark": the page as the app shows it. */
export type Paper = "light" | "dark";

// A4, in points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 50;
/** CSS pixels to points. */
const PX = 0.75;
const DARK_BG = "#11151c";

type Rgb = [number, number, number];

function hex(c: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const n = m ? parseInt(m[1]!, 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A colour picked for a dark page, made readable on the chosen paper. */
function inkColor(c: string | undefined, paper: Paper) {
  if (!c) return paper === "dark" ? rgb(0.92, 0.92, 0.92) : rgb(0.1, 0.1, 0.1);
  let [r, g, b] = hex(c);
  if (paper === "light") {
    const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    // White and grey ink become black and dark grey; bright colours are deepened.
    if (Math.max(r, g, b) - Math.min(r, g, b) < 24) [r, g, b] = light > 0.8 ? [26, 26, 26] : [90, 90, 90];
    else if (light > 0.45) {
      const k = light > 0.7 ? 0.55 : 0.7;
      [r, g, b] = [r * k, g * k, b * k];
    }
  }
  return rgb(r / 255, g / 255, b / 255);
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  const load = async (url: string) => doc.embedFont(await (await fetch(url)).arrayBuffer(), { subset: true });
  const [regular, bold, italic, boldItalic] = await Promise.all([load(regularUrl), load(boldUrl), load(italicUrl), load(boldItalicUrl)]);
  return { regular: regular!, bold: bold!, italic: italic!, boldItalic: boldItalic! };
}

/** Pages that know where the next line goes. */
class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    readonly doc: PDFDocument,
    readonly paper: Paper,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    if (this.paper === "dark") this.page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: inkColor(DARK_BG, "dark") });
    this.y = PAGE_H - MARGIN;
  }
  /** Room for `h` more points on this page, or a new page. */
  need(h: number) {
    if (this.y - h < MARGIN) this.newPage();
  }
}

function drawTitle(w: Writer, fonts: Fonts, title: string) {
  const size = 20;
  for (const line of wrapPlain(title || "Untitled", fonts.bold, size, PAGE_W - 2 * MARGIN)) {
    w.need(size * 1.3);
    w.y -= size;
    w.page.drawText(line, { x: MARGIN, y: w.y, size, font: fonts.bold, color: inkColor(undefined, w.paper) });
    w.y -= size * 0.3;
  }
  w.y -= 14;
}

function wrapPlain(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/(\s+)/)) {
    const next = line + word;
    if (line && font.widthOfTextAtSize(next.trimEnd(), size) > width) {
      lines.push(line.trimEnd());
      line = word.trimStart();
    } else line = next;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.length ? lines : [""];
}

// ------------------------------------------------------------ typed notes

interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}
interface PmNode {
  type: string;
  text?: string;
  marks?: Mark[];
  attrs?: Record<string, unknown>;
  content?: PmNode[];
}

interface Run {
  text: string;
  font: PDFFont;
  size: number;
  color: ReturnType<typeof rgb>;
  rise: number;
  underline: boolean;
  strike: boolean;
}

const BASE_PX = 15;

function runsOf(nodes: PmNode[] | undefined, fonts: Fonts, paper: Paper): Run[] {
  const runs: Run[] = [];
  for (const n of nodes ?? []) {
    if (n.type === "hardBreak") {
      runs.push({ text: "\n", font: fonts.regular, size: BASE_PX * PX, color: inkColor(undefined, paper), rise: 0, underline: false, strike: false });
      continue;
    }
    if (n.type !== "text" || !n.text) continue;
    const has = (t: string) => n.marks?.some((m) => m.type === t) ?? false;
    const style = n.marks?.find((m) => m.type === "textStyle")?.attrs ?? {};
    const px = typeof style.fontSize === "string" && parseFloat(style.fontSize) > 0 ? parseFloat(style.fontSize) : BASE_PX;
    const sup = has("superscript");
    const sub = has("subscript");
    const size = px * PX * (sup || sub ? 0.7 : 1);
    const bold = has("bold");
    const italic = has("italic");
    runs.push({
      text: n.text,
      font: bold && italic ? fonts.boldItalic : bold ? fonts.bold : italic ? fonts.italic : fonts.regular,
      size,
      color: inkColor(typeof style.color === "string" ? style.color : undefined, paper),
      rise: sup ? px * PX * 0.35 : sub ? -px * PX * 0.15 : 0,
      underline: has("underline"),
      strike: has("strike"),
    });
  }
  return runs;
}

/** Lays out one paragraph's runs from x to the right margin, starting a new page when needed. */
function drawParagraph(w: Writer, runs: Run[], x: number, marker?: { text: string; font: PDFFont; color: ReturnType<typeof rgb> }) {
  const width = PAGE_W - MARGIN - x;
  type Piece = Run & { w: number };
  const lines: Piece[][] = [[]];
  let lineW = 0;
  for (const run of runs) {
    if (run.text === "\n") {
      lines.push([]);
      lineW = 0;
      continue;
    }
    for (const token of run.text.split(/(\s+)/)) {
      if (!token) continue;
      const tw = run.font.widthOfTextAtSize(token, run.size);
      const line = lines[lines.length - 1]!;
      if (lineW + tw > width && line.length > 0 && !/^\s+$/.test(token)) {
        lines.push([]);
        lineW = 0;
      }
      if (lineW === 0 && /^\s+$/.test(token)) continue;
      // A single word longer than the line is split by letters.
      if (tw > width) {
        let part = "";
        for (const ch of token) {
          if (run.font.widthOfTextAtSize(part + ch, run.size) > width - lineW && part) {
            lines[lines.length - 1]!.push({ ...run, text: part, w: run.font.widthOfTextAtSize(part, run.size) });
            lines.push([]);
            lineW = 0;
            part = "";
          }
          part += ch;
        }
        const pw = run.font.widthOfTextAtSize(part, run.size);
        lines[lines.length - 1]!.push({ ...run, text: part, w: pw });
        lineW += pw;
        continue;
      }
      lines[lines.length - 1]!.push({ ...run, text: token, w: tw });
      lineW += tw;
    }
  }
  lines.forEach((line, i) => {
    const size = Math.max(BASE_PX * PX, ...line.map((p) => (p.rise ? p.size / 0.7 : p.size)));
    const height = size * 1.5;
    w.need(height);
    const base = w.y - size * 1.15;
    if (i === 0 && marker) w.page.drawText(marker.text, { x: x - marker.font.widthOfTextAtSize(marker.text, BASE_PX * PX) - 6, y: base, size: BASE_PX * PX, font: marker.font, color: marker.color });
    let cx = x;
    for (const p of line) {
      w.page.drawText(p.text, { x: cx, y: base + p.rise, size: p.size, font: p.font, color: p.color });
      if (p.underline) w.page.drawLine({ start: { x: cx, y: base + p.rise - 1.5 }, end: { x: cx + p.w, y: base + p.rise - 1.5 }, thickness: 0.6, color: p.color });
      if (p.strike) w.page.drawLine({ start: { x: cx, y: base + p.rise + p.size * 0.3 }, end: { x: cx + p.w, y: base + p.rise + p.size * 0.3 }, thickness: 0.6, color: p.color });
      cx += p.w;
    }
    w.y -= height;
  });
}

function drawBlocks(w: Writer, nodes: PmNode[] | undefined, fonts: Fonts, x: number) {
  for (const n of nodes ?? []) {
    if (n.type === "paragraph") {
      drawParagraph(w, runsOf(n.content, fonts, w.paper), x);
      w.y -= BASE_PX * PX * 0.5;
    } else if (n.type === "bulletList" || n.type === "orderedList") {
      const start = typeof n.attrs?.start === "number" ? n.attrs.start : 1;
      (n.content ?? []).forEach((item, i) => {
        const marker = { text: n.type === "bulletList" ? "•" : `${start + i}.`, font: fonts.regular, color: inkColor(undefined, w.paper) };
        const indent = x + 20;
        (item.content ?? []).forEach((child, j) => {
          if (child.type === "paragraph") drawParagraph(w, runsOf(child.content, fonts, w.paper), indent, j === 0 ? marker : undefined);
          else drawBlocks(w, [child], fonts, indent);
        });
      });
      w.y -= BASE_PX * PX * 0.5;
    } else if (n.content) {
      drawBlocks(w, n.content, fonts, x);
    }
  }
}

// ------------------------------------------------------------ handwritten notes

/** One stroke onto a PDF page: pen and marker lines are filled outlines, shapes are drawn lines. */
function drawStroke(page: PDFPage, s: Stroke, x: number, y: number, scale: number, paper: Paper) {
  const opacity = s.t === "marker" ? MARKER_ALPHA : 1;
  if (isShape(s)) {
    const d = shapeSvg(s);
    if (!d) return;
    const dash = dashOf(s).map((n) => n * scale);
    const outline = s.o !== 0;
    page.drawSvgPath(d, {
      x,
      y,
      scale,
      color: s.f ? inkColor(s.c, paper) : undefined,
      opacity: s.f ?? undefined,
      borderColor: outline ? inkColor(s.c, paper) : undefined,
      borderWidth: outline ? widthOf(s) * scale : 0,
      borderOpacity: opacity,
      borderDashArray: dash.length ? dash : undefined,
      borderLineCap: LineCapStyle.Round,
    });
    return;
  }
  const d = strokeSvg(s);
  if (!d) return;
  page.drawSvgPath(d, { x, y, scale, color: inkColor(s.c, paper), opacity, borderWidth: 0 });
}

/** Board pages as PDF pages: each page the size you chose, the writing at its real size. */
function drawInkPages(doc: PDFDocument, strokes: Stroke[], page: Page, paper: Paper) {
  const pw = page.w * MM;
  const ph = page.h * MM;
  const boxes = strokes.map(strokeBox);
  const bottom = boxes.reduce((m, b) => Math.max(m, b.y1), 0);
  // The last page with writing on it (a stroke just over a line does not make a page of its own).
  const pages = Math.max(1, Math.ceil((bottom - 4) / ph));
  for (let k = 0; k < pages; k++) {
    const pdfPage = doc.addPage([pw * PX, ph * PX]);
    if (paper === "dark") pdfPage.drawRectangle({ x: 0, y: 0, width: pw * PX, height: ph * PX, color: inkColor(DARK_BG, "dark") });
    const top = k * ph;
    strokes.forEach((s, i) => {
      const b = boxes[i]!;
      if (b.y1 < top || b.y0 > top + ph || b.x0 > pw) return;
      drawStroke(pdfPage, s, 0, ph * PX + top * PX, PX, paper);
    });
  }
}

function drawInk(w: Writer, body: string) {
  const strokes = parseInk(body).strokes;
  if (!strokes.length) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const boxes = strokes.map((s) => {
    const b = strokeBox(s);
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
    return b;
  });
  const width = PAGE_W - 2 * MARGIN;
  // Real size where it fits; a wide page is shrunk to the paper's width.
  const scale = Math.min(PX, width / Math.max(1, x1 - x0));
  let top = y0;
  while (top < y1) {
    const room = w.y - MARGIN;
    if (room < 60) {
      w.newPage();
      continue;
    }
    const bottom = top + room / scale;
    const ox = MARGIN - x0 * scale;
    const oy = w.y + top * scale;
    // Keep each page's strokes inside its own band, so a stroke that crosses pages is cut cleanly.
    w.page.pushOperators(pushGraphicsState(), moveTo(MARGIN - 20, MARGIN), lineTo(PAGE_W - MARGIN + 20, MARGIN), lineTo(PAGE_W - MARGIN + 20, w.y), lineTo(MARGIN - 20, w.y), closePath(), clip(), endPath());
    strokes.forEach((s, i) => {
      const b = boxes[i]!;
      if (b.y1 < top || b.y0 > bottom) return;
      drawStroke(w.page, s, ox, oy, scale, w.paper);
    });
    w.page.pushOperators(popGraphicsState());
    top = bottom;
    if (top < y1) w.newPage();
  }
}

/** The note as a PDF: its title, then its text or its handwriting, on A4 pages. */
export async function noteToPdf(note: Pick<Note, "title" | "kind">, body: string, paper: Paper): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(note.title || "Untitled");
  doc.setCreator("Kairos");
  if (note.kind === "ink") {
    const ink = parseInk(body);
    // With a page size, the PDF pages are the board's pages, exactly as drawn.
    const pages = pagesOf(ink.page);
    if (pages) {
      drawInkPages(doc, ink.strokes, pages, paper);
      return doc.save();
    }
  }
  const fonts = await embedFonts(doc);
  const w = new Writer(doc, paper);
  drawTitle(w, fonts, note.title);
  if (note.kind === "ink") drawInk(w, body);
  else if (body) {
    try {
      drawBlocks(w, (JSON.parse(body) as PmNode).content, fonts, MARGIN);
    } catch {
      // An unreadable body leaves just the title.
    }
  }
  return doc.save();
}

/** A file name from the title, without characters Windows or Android refuse. */
export function pdfName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${clean || "Note"}.pdf`;
}
