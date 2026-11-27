import { useEffect } from "react";
import type { NoteKind } from "../../ipc/notes";

const KINDS: [NoteKind, string, string][] = [
  ["text", "Typed note", "Type with the keyboard."],
  ["ink", "Handwritten", "Write and draw with a pen or mouse."],
];

/** A small drawing of each kind, so the choice reads at a glance. */
function KindPicture(props: { kind: NoteKind }) {
  if (props.kind === "text")
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <rect x="1" y="1" width="46" height="30" rx="3" fill="none" stroke="currentColor" strokeOpacity=".5" />
        <rect x="6" y="6" width="20" height="3.5" rx="1" fill="currentColor" fillOpacity=".85" />
        {[13, 18.5, 24].map((y, i) => (
          <rect key={y} x="6" y={y} width={i === 2 ? 22 : 36} height="2.2" rx="1" fill="currentColor" fillOpacity=".45" />
        ))}
      </svg>
    );
  return (
    <svg viewBox="0 0 48 32" aria-hidden="true">
      <rect x="1" y="1" width="46" height="30" rx="3" fill="none" stroke="currentColor" strokeOpacity=".5" />
      {[7, 15, 23, 31, 39].map((x) => [7, 15, 23].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y + 1} r=".7" fill="currentColor" fillOpacity=".35" />))}
      <path d="M6 13c2-4 4-4 4 0s2 4 4 0 2-4 4 0 2 3 4 0M7 22c3-2 6-2 9 0s6 1 8-1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M38 8l4 4-10 10h-4v-4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/** "Which kind of note?": asked each time a note is made. */
export function NewNoteChoice(props: { onPick: (kind: NoteKind) => void; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal card note-kind-modal" role="dialog" aria-modal="true" aria-label="Which kind of note?">
        <h2 className="card-title">
          <span className="card-title-text">Which kind of note?</span>
        </h2>
        <div className="note-kind-choices">
          {KINDS.map(([kind, name, note], i) => (
            <button key={kind} type="button" className="space-family note-kind" data-kind={kind} autoFocus={i === 0} onClick={() => props.onPick(kind)}>
              <KindPicture kind={kind} />
              <strong>{name}</strong>
              <span className="hint">{note}</span>
            </button>
          ))}
        </div>
        <div className="note-kind-foot">
          <button type="button" className="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
