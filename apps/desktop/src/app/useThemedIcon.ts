import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LOGO_MARK } from "../components/Logo";

const SIZE = 64;

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error("logo did not load"));
    img.src = src;
  });
}

/** Colours of the themed logo, read from a hidden .app-logo so they match the CSS exactly. */
function logoColours(): { tile: string; ink: string } {
  const probe = document.createElement("span");
  probe.className = "app-logo";
  probe.style.cssText = "position:absolute;left:-9999px;width:10px;height:10px";
  const inner = document.createElement("span");
  probe.appendChild(inner);
  document.body.appendChild(probe);
  let tile = getComputedStyle(probe).backgroundColor;
  const ink = getComputedStyle(inner).backgroundColor;
  probe.remove();
  if (!tile || tile === "transparent" || /rgba?\(0, 0, 0, 0\)/.test(tile)) tile = getComputedStyle(document.body).backgroundColor || "#111";
  return { tile, ink };
}

async function draw(): Promise<Uint8Array> {
  const { tile, ink } = logoColours();
  const mark = await load(LOGO_MARK);
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const g = c.getContext("2d")!;
  // A solid dark base first: theme surfaces are often see-through, and the taskbar is not.
  g.beginPath();
  g.roundRect(0.5, 0.5, SIZE - 1, SIZE - 1, SIZE * 0.22);
  g.fillStyle = "#101318";
  g.fill();
  g.fillStyle = tile;
  g.fill();
  g.globalAlpha = 0.45;
  g.strokeStyle = ink;
  g.lineWidth = 1.5;
  g.stroke();
  g.globalAlpha = 1;
  // The line art, recoloured: draw it, then keep only its shape filled with the ink colour.
  const m = document.createElement("canvas");
  m.width = m.height = SIZE;
  const mg = m.getContext("2d")!;
  const inset = SIZE * 0.06;
  mg.drawImage(mark, inset, inset, SIZE - inset * 2, SIZE - inset * 2);
  mg.globalCompositeOperation = "source-in";
  mg.fillStyle = ink;
  mg.fillRect(0, 0, SIZE, SIZE);
  g.drawImage(m, 0, 0);
  const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
  if (!blob) throw new Error("could not draw the icon");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Keeps the taskbar icon in the theme's colours. `key` changes whenever the colours may have. */
export function useThemedIcon(key: string) {
  useEffect(() => {
    let cancelled = false;
    // Let the new theme's CSS apply first.
    const t = window.setTimeout(() => {
      draw()
        .then((bytes) => (cancelled ? undefined : invoke("set_app_icon", bytes)))
        .catch(() => {
          // Browser preview or an older build: the normal icon stays.
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [key]);
}
