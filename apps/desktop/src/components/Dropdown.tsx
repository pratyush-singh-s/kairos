import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A drop-down drawn in the app's own colours (Windows draws native <select> lists in its own,
 * which looked wrong on the dark themes). The list floats above everything, so a parent with
 * overflow: hidden does not cut it off.
 */
export function Dropdown<T extends string>(props: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = props.options.find((o) => o.value === props.value) ?? props.options[0];

  const show = () => {
    setActive(Math.max(0, props.options.findIndex((o) => o.value === props.value)));
    setOpen(true);
  };
  const pick = (v: T) => {
    setOpen(false);
    if (v !== props.value) props.onChange(v);
    button.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const h = props.options.length * 34 + 10;
    setPos({
      left: Math.min(r.left, window.innerWidth - Math.max(r.width, 160) - 8),
      minWidth: Math.max(r.width, 160),
      ...(below < h + 8 ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
    });
  }, [open, props.options.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`dropdown ${props.className ?? ""}`}
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              show();
            }
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % props.options.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + props.options.length) % props.options.length);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick(props.options[active]!.value);
          } else if (e.key === "Tab") setOpen(false);
        }}
      >
        <span className="dropdown-value">{current?.label}</span>
        <svg className="dropdown-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && createPortal(
        <ul ref={list} className="dropdown-list" role="listbox" aria-label={props.label} style={pos}>
          {props.options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === props.value}
              data-active={i === active || undefined}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
            >
              <span>{o.label}</span>
              {o.value === props.value && (
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path d="M2.5 6.2 5 8.6 9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  );
}
