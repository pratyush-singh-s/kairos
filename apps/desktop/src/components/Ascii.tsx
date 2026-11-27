import { useUi } from "../theme/UiProvider";

/** True when the Terminal theme draws its graphics with text characters (Settings > Terminal > ASCII graphics). */
export function useAscii(): boolean {
  const { theme, terminalAscii } = useUi();
  return theme === "terminal" && terminalAscii;
}

/** The dots of a ring on a `n`×`n` grid: lit ones from 12 o'clock clockwise for `fraction` of the way. */
export function ringDots(fraction: number, n: number, thickness: number): { x: number; y: number; lit: boolean }[] {
  const c = (n - 1) / 2;
  const outer = n / 2;
  const inner = outer - thickness;
  const f = Math.max(0, Math.min(1, fraction));
  const dots: { x: number; y: number; lit: boolean }[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy);
      if (d > outer || d < inner) continue;
      // 0 at 12 o'clock, going clockwise to 1.
      const a = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1;
      dots.push({ x, y, lit: a < f });
    }
  }
  return dots;
}

/**
 * A ring of text dots (•), like btop's braille graphs: each dot sits in its own cell of a square
 * grid, so the ring stays round whatever the font. `size` px, or the whole (square) box.
 */
export function AsciiRing(props: { fraction: number; size?: number; dots?: number; thickness?: number; className?: string }) {
  // About one dot per 4 px.
  const n = props.dots ?? Math.max(12, Math.min(80, Math.round((props.size ?? 280) / 4)));
  const dots = ringDots(props.fraction, n, props.thickness ?? Math.max(1.5, n / 18));
  const style = { ["--ring-dots" as string]: n, ...(props.size ? { width: props.size, height: props.size } : {}) };
  return (
    <div className={`ascii-ring ${props.className ?? ""}`} style={style} aria-hidden="true">
      <div className="ascii-ring-grid">
        {dots.map((d) => (
          <span key={`${d.x}-${d.y}`} className={d.lit ? "lit" : undefined} style={{ gridColumn: d.x + 1, gridRow: d.y + 1 }}>
            •
          </span>
        ))}
      </div>
    </div>
  );
}

/** A text progress bar: ████████░░░░ */
export function asciiBlocks(fraction: number, width: number): { full: string; empty: string } {
  const f = Math.max(0, Math.min(1, fraction));
  const n = Math.round(f * width);
  return { full: "█".repeat(n), empty: "░".repeat(width - n) };
}

export function AsciiBar(props: { fraction: number; width?: number; className?: string }) {
  const b = asciiBlocks(props.fraction, props.width ?? 20);
  return (
    <span className={`ascii-bar ${props.className ?? ""}`} aria-hidden="true">
      <span className="ascii-bar-full">{b.full}</span>
      <span className="ascii-bar-empty">{b.empty}</span>
    </span>
  );
}

/** One column of a text bar chart, `rows` characters tall, with eighth-blocks at the top: ▁▂▃▄▅▆▇█ */
export function asciiColumn(fraction: number, rows: number): string[] {
  const eighths = Math.round(Math.max(0, Math.min(1, fraction)) * rows * 8);
  const out: string[] = [];
  for (let r = rows - 1; r >= 0; r--) {
    const v = Math.max(0, Math.min(8, eighths - r * 8));
    out.push(v === 0 ? " " : " ▁▂▃▄▅▆▇█"[v]!);
  }
  return out;
}
