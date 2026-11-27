/** Paper grain for handwritten notes: fine grey specks that belong to the page, so they move and
 * zoom with what you write (like the grain of real paper), not with the screen. Our own noise:
 * random specks, softened a little so they read as grain rather than single pixels. */

const SIZE = 256;
let tile: HTMLCanvasElement | null = null;

/** One square of grain, white specks on transparent, made once and reused. Tiles seamlessly. */
function grainTile(): HTMLCanvasElement {
  if (tile) return tile;
  const raw = new Float32Array(SIZE * SIZE);
  // A fixed seed, so the paper looks the same every time the note opens.
  let seed = 0x2f6b9d1;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < raw.length; i++) raw[i] = rand();
  // Soften with a small wrap-around blur: specks about one to two page units across.
  const soft = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let sum = 0;
      let wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
          sum += w * (raw[((y + dy + SIZE) % SIZE) * SIZE + ((x + dx + SIZE) % SIZE)] ?? 0);
          wsum += w;
        }
      }
      soft[y * SIZE + x] = sum / wsum;
    }
  }
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext("2d")!;
  const img = g.createImageData(SIZE, SIZE);
  for (let i = 0; i < soft.length; i++) {
    // Mostly faint, a few brighter flecks: about 2 brightness levels of spread on black.
    const a = Math.max(0, Math.min(1, ((soft[i] ?? 0) - 0.38) * 0.09));
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  tile = c;
  return c;
}

/** Whether the paper grain is on (Settings → Look → Notes background). */
export const grainOn = () => document.documentElement.dataset.notesGrain !== "off";

/**
 * Fills the paper with grain. The view (x, y = top-left page point, z = zoom) maps page units to
 * screen pixels, so one grain tile covers SIZE page units and follows panning and zoom.
 * area: the paper in page units (null = the whole board, an endless page).
 */
export function paintGrain(
  ctx: CanvasRenderingContext2D,
  view: { x: number; y: number; z: number },
  dpr: number,
  area: { x0: number; y0: number; x1: number; y1: number } | null,
) {
  const pattern = ctx.createPattern(grainTile(), "repeat");
  if (!pattern) return;
  const { x, y, z } = view;
  const k = z * dpr;
  pattern.setTransform(new DOMMatrix([k, 0, 0, k, -x * k, -y * k]));
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  let sx0 = 0, sy0 = 0, sx1 = W, sy1 = H;
  if (area) {
    sx0 = Math.max(0, (area.x0 - x) * k);
    sy0 = Math.max(0, (area.y0 - y) * k);
    sx1 = Math.min(W, (area.x1 - x) * k);
    sy1 = Math.min(H, (area.y1 - y) * k);
  }
  if (sx1 <= sx0 || sy1 <= sy0) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = pattern;
  ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  ctx.restore();
}

