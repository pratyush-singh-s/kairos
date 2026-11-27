import { useEffect, useRef } from "react";
import { useUi } from "../../theme/UiProvider";
import type { TerminalGlow } from "../../ipc/ui";

/**
 * Terminal theme background: a screen of hex-dump characters whose brightness rises and falls in slow
 * drifting blobs, a few characters flickering each frame and now and then a band of rows tearing
 * sideways. Drawn on one canvas from a pre-glowed glyph sheet, a few frames a second, so it stays cheap.
 * Settings > Terminal > Glow and distortion picks how strong it is (styles.css "terminal glow" does the
 * text glow and the glitches over the whole window).
 */
const CHARS = "0123456789ABCDEF+-=*/<>_";
const FONT_PX = 14;

const LEVELS: Record<Exclude<TerminalGlow, "off">, { fps: number; alpha: number; flicker: number; tear: number }> = {
  soft: { fps: 8, alpha: 0.35, flicker: 0.015, tear: 0.025 },
  strong: { fps: 12, alpha: 0.7, flicker: 0.035, tear: 0.07 },
};

// Value noise on a 256×256 lattice of random numbers, smoothly interpolated.
const LATTICE = new Float32Array(256 * 256);
for (let i = 0; i < LATTICE.length; i++) LATTICE[i] = Math.random();
function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = xi & 255;
  const y0 = yi & 255;
  const x1 = (x0 + 1) & 255;
  const y1 = (y0 + 1) & 255;
  const a = LATTICE[y0 * 256 + x0]!;
  const b = LATTICE[y0 * 256 + x1]!;
  const c = LATTICE[y1 * 256 + x0]!;
  const d = LATTICE[y1 * 256 + x1]!;
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function TermNoise(props: { level: TerminalGlow }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { terminalPalette, terminalCustom } = useUi();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || props.level === "off") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cfg = LEVELS[props.level];
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const color = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#cfcfcf";
    const font = `${FONT_PX * dpr}px "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace`;

    // The glyph sheet: every character once, already glowing, so a frame is only drawImage calls.
    ctx.font = font;
    const cw = Math.ceil(ctx.measureText("0").width);
    const ch = Math.ceil(FONT_PX * 1.15 * dpr);
    const pad = Math.ceil(4 * dpr);
    const sheet = document.createElement("canvas");
    sheet.width = (cw + pad * 2) * CHARS.length;
    sheet.height = ch + pad * 2;
    const s = sheet.getContext("2d")!;
    s.font = font;
    s.textBaseline = "middle";
    s.fillStyle = color;
    s.shadowColor = color;
    s.shadowBlur = 4 * dpr;
    for (let i = 0; i < CHARS.length; i++) s.fillText(CHARS[i]!, i * (cw + pad * 2) + pad, pad + ch / 2);

    let cols = 0;
    let rows = 0;
    let chars = new Uint8Array(0);
    const resize = () => {
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      cols = Math.ceil(canvas.width / cw) + 1;
      rows = Math.ceil(canvas.height / ch) + 1;
      chars = new Uint8Array(cols * rows);
      for (let i = 0; i < chars.length; i++) chars[i] = (Math.random() * CHARS.length) | 0;
    };
    resize();

    const seedX = Math.random() * 200;
    const seedY = Math.random() * 200;
    const draw = (t: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const flick = Math.floor(chars.length * cfg.flicker);
      for (let i = 0; i < flick; i++) chars[(Math.random() * chars.length) | 0] = (Math.random() * CHARS.length) | 0;
      // A torn band: a few rows pushed sideways for this frame.
      const tearAt = Math.random() < cfg.tear ? (Math.random() * rows) | 0 : -10;
      const tearRows = 1 + ((Math.random() * 4) | 0);
      const tearBy = ((Math.random() - 0.5) * 12) | 0;
      const tx = t * 0.00004;
      const ty = t * 0.00003;
      for (let y = 0; y < rows; y++) {
        const shift = y >= tearAt && y < tearAt + tearRows ? tearBy : 0;
        for (let x = 0; x < cols; x++) {
          // Two octaves: big soft blobs and finer ragged edges.
          const nx = (x + shift) * 0.035;
          const ny = y * 0.075;
          const n = 0.68 * noise(nx + seedX + tx, ny + seedY - ty) + 0.32 * noise(nx * 2.7 + seedY - tx, ny * 2.7 + seedX + ty);
          const b = (n - 0.48) / 0.22;
          if (b <= 0.04) continue;
          const glyph = chars[y * cols + x]!;
          ctx.globalAlpha = cfg.alpha * Math.min(1, b);
          ctx.drawImage(sheet, glyph * (cw + pad * 2), 0, cw + pad * 2, ch + pad * 2, (x + shift) * cw - pad, y * ch - pad, cw + pad * 2, ch + pad * 2);
        }
      }
      ctx.globalAlpha = 1;
    };

    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || t - last < 1000 / cfg.fps) return;
      last = t;
      draw(t);
    };
    const onResize = () => {
      resize();
      draw(performance.now());
    };
    window.addEventListener("resize", onResize);
    if (still) draw(0);
    else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [props.level, terminalPalette, terminalCustom]);

  if (props.level === "off") return null;
  return <canvas ref={ref} className="term-noise" aria-hidden="true" />;
}

/**
 * Now and then the whole window glitches for a moment: html[data-glitch] turns on a sideways
 * displacement (the SVG filter below, with a new random pattern each time) and a small jolt.
 */
export function useTermGlitch(level: TerminalGlow) {
  useEffect(() => {
    if (level === "off" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    const [min, max] = level === "strong" ? [2500, 7000] : [6000, 16000];
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(() => {
        if (!document.hidden) {
          document.getElementById("term-warp-noise")?.setAttribute("seed", String((Math.random() * 1000) | 0));
          root.dataset.glitch = Math.random() < 0.5 ? "a" : "b";
          window.setTimeout(() => delete root.dataset.glitch, 90 + Math.random() * 120);
        }
        next();
      }, min + Math.random() * (max - min));
    };
    next();
    return () => {
      window.clearTimeout(timer);
      delete root.dataset.glitch;
    };
  }, [level]);
}

/** The displacement filter the glitch uses: rows shift sideways only (green is held at the middle). */
export function TermWarpFilter() {
  return (
    <svg className="term-warp-defs" aria-hidden="true" width="0" height="0">
      <filter id="term-warp" x="-2%" y="0" width="104%" height="100%">
        <feTurbulence id="term-warp-noise" type="fractalNoise" baseFrequency="0.0008 0.09" numOctaves="1" seed="3" result="n" />
        <feColorMatrix in="n" type="matrix" values="1 0 0 0 0  0 0 0 0 0.5  0 0 0 0 0  0 0 0 0 1" result="m" />
        <feDisplacementMap in="SourceGraphic" in2="m" scale="22" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
