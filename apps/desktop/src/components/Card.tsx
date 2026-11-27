import { useState, type ReactNode, type PointerEvent } from "react";

type Info = { text: string; focus: string; pc: string; more: string };
const NONE: Info = { text: "", focus: "", pc: "", more: "" };

/**
 * `hoverInfo`: pointing at anything inside with a `data-info` text shows it in the card's top right
 * corner, then `data-info-focus` in the focus colour, `data-info-pc` in the PC on colour and
 * `data-info-more` plain.
 * Pointing outside every `data-info-zone` clears it.
 */
export function Card(props: { title: string; children: ReactNode; className?: string; hoverInfo?: boolean }) {
  const id = `card-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const [info, setInfo] = useState<Info>(NONE);
  const over = (e: PointerEvent<HTMLElement>) => {
    const t = e.target as Element;
    const hit = t.closest?.("[data-info]");
    if (hit) setInfo({ text: hit.getAttribute("data-info") ?? "", focus: hit.getAttribute("data-info-focus") ?? "", pc: hit.getAttribute("data-info-pc") ?? "", more: hit.getAttribute("data-info-more") ?? "" });
    else if (!t.closest?.("[data-info-zone]")) setInfo(NONE);
  };
  return (
    <section
      className={`card ${props.className ?? ""}`}
      aria-labelledby={id}
      onPointerOver={props.hoverInfo ? over : undefined}
      // A tap on a phone shows it too, and it stays after the finger lifts.
      onPointerDown={props.hoverInfo ? over : undefined}
      onPointerLeave={props.hoverInfo ? (e) => e.pointerType !== "touch" && setInfo(NONE) : undefined}
    >
      <h2 id={id} className="card-title" data-has-info={props.hoverInfo || undefined}>
        <span className="card-title-text">{props.title}</span>
        {props.hoverInfo && (
          <span className="card-hover-info num" aria-hidden="true" data-empty={!info.text || undefined}>
            {info.text}
            {info.focus && <> · <span data-series="focus">{info.focus}</span></>}
            {info.pc && <> · <span data-series="active">{info.pc}</span></>}
            {info.more && <> · <span className="muted">{info.more}</span></>}
          </span>
        )}
      </h2>
      {props.children}
    </section>
  );
}
