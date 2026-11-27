import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from "@focus/core";
import { recentTaskColors } from "../../ipc/tasks";

/**
 * The small circle before a task's name. Clicking it opens a picker with a colour wheel,
 * a brightness slider, a hex box and the last 5 colours used. `onChange` runs once, when a
 * colour is chosen (a recent swatch, Enter in the hex box, Done, or clicking away after a change).
 */
export function ColorDot(props: { color: string | null; label: string; onChange: (color: string | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="color-dot-wrap">
      <button
        type="button"
        className="color-dot"
        data-empty={props.color === null}
        style={props.color ? { background: props.color, borderColor: props.color } : undefined}
        aria-label={`Colour for ${props.label}: ${props.color ? colorName(props.color) : "none"}`}
        aria-expanded={open}
        title="Colour"
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <ColorPicker
          color={props.color}
          onClose={(chosen) => {
            setOpen(false);
            if (chosen !== undefined && chosen !== props.color) props.onChange(chosen);
          }}
        />
      )}
    </span>
  );
}

/** A rough spoken name for a colour, so screen readers don't read out hex codes. */
function colorName(hex: string): string {
  const { h, s, v } = hexToHsv(hex);
  if (v < 0.2) return "black";
  if (s < 0.15) return v > 0.85 ? "white" : "grey";
  const names = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "red"];
  return names[Math.round(((h % 360) / 360) * 8) % 9]!;
}

const WHEEL = 168;

/** `onClose(undefined)` = closed without a change. */
function ColorPicker(props: { color: string | null; onClose: (chosen?: string | null) => void }) {
  const [hsv, setHsv] = useState<Hsv>(props.color ? hexToHsv(props.color) : { h: 210, s: 0.7, v: 1 });
  const [hex, setHex] = useState(props.color ?? hsvToHex(hsv));
  const [touched, setTouched] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [above, setAbove] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = hsvToHex(hsv);
  // Latest values for the outside-click handler.
  const latest = useRef({ touched, current });
  latest.current = { touched, current };

  useEffect(() => {
    recentTaskColors().then(setRecent).catch(() => setRecent([]));
  }, []);

  // Open upwards when there is no room below.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box && box.bottom > window.innerHeight - 8) setAbove(true);
  }, []);

  useEffect(() => {
    const close = () => props.onClose(latest.current.touched ? latest.current.current : undefined);
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement!.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [props]);

  function pick(next: Hsv) {
    setHsv(next);
    setHex(hsvToHex(next));
    setTouched(true);
  }

  function fromWheel(e: ReactPointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left - box.width / 2;
    const y = e.clientY - box.top - box.height / 2;
    const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    const s = Math.min(1, Math.hypot(x, y) / (box.width / 2));
    pick({ ...hsv, h, s });
  }

  const angle = (hsv.h * Math.PI) / 180;
  const r = (WHEEL / 2) * hsv.s;
  return (
    <div ref={ref} className="color-picker" data-above={above} role="dialog" aria-label="Pick a colour">
      <div
        className="color-wheel"
        style={{ width: WHEEL, height: WHEEL }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromWheel(e);
        }}
        onPointerMove={(e) => e.buttons === 1 && fromWheel(e)}
      >
        <div className="color-wheel-dim" style={{ opacity: 1 - hsv.v }} />
        <span
          className="color-wheel-marker"
          style={{ left: WHEEL / 2 + r * Math.cos(angle), top: WHEEL / 2 + r * Math.sin(angle), background: current }}
        />
      </div>
      <label className="color-brightness">
        <span className="sr-only">Brightness</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(hsv.v * 100)}
          onChange={(e) => pick({ ...hsv, v: Number(e.target.value) / 100 })}
          style={{ background: `linear-gradient(to right, #000, ${hsvToHex({ ...hsv, v: 1 })})` }}
        />
      </label>
      <div className="color-hex-row">
        <span className="color-preview" style={{ background: current }} aria-hidden="true" />
        <label className="sr-only" htmlFor="color-hex">
          Hex colour
        </label>
        <input
          id="color-hex"
          className="color-hex"
          value={hex}
          spellCheck={false}
          maxLength={7}
          aria-invalid={normalizeHex(hex) === null}
          onChange={(e) => {
            setHex(e.target.value);
            const n = normalizeHex(e.target.value);
            if (n) {
              setHsv(hexToHsv(n));
              setTouched(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const n = normalizeHex(hex);
              if (n) props.onClose(n);
            }
          }}
        />
        <button type="button" className="button primary small-button" onClick={() => props.onClose(current)}>
          Done
        </button>
      </div>
      <div className="color-recent">
        <span className="muted small">Recent</span>
        {recent.length === 0 && <span className="muted small">none yet</span>}
        {recent.map((c) => (
          <button
            key={c}
            type="button"
            className="color-swatch"
            style={{ background: c }}
            aria-label={`Use ${c}`}
            title={c}
            onClick={() => props.onClose(c)}
          />
        ))}
        <button type="button" className="link-button small push-right" onClick={() => props.onClose(null)}>
          No colour
        </button>
      </div>
    </div>
  );
}
