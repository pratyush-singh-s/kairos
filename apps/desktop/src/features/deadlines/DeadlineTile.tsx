import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { computeDeadline, countdownWords, type DeadlineView } from "@focus/core";
import type { Deadline } from "../../ipc/deadlines";
import { createTask, deleteTasks, setTaskColor, setTaskDone } from "../../ipc/tasks";
import { useUi } from "../../theme/UiProvider";
import { TaskRow } from "../tasks/TaskRow";
import { dueText, STATE_ICON } from "./DeadlineCard";
import { DeadlineRing } from "./DeadlineRing";

/** "In 64 days", "Due today 17:00", "Overdue by 2d", "Starts 3 Nov", "Done". */
export function tileWhen(v: DeadlineView): string {
  if (v.state === "completed" || v.state === "overdue" || v.state === "upcoming" || v.state === "today") return v.label;
  const days = Math.floor(v.remainingMs / 86_400_000);
  return days >= 2 ? `In ${days} days` : `In ${countdownWords(v.remainingMs).long}`;
}

/** Terminal blocks, as in the full day grid. */
const BLOCK = { past: "█", today: "▓", due: "▒", future: "░" };

/** The day progress drawn small: a dot (or bar) per day that wraps to the tile's width. */
function MiniDays(props: { view: DeadlineView; deadline: Deadline }) {
  const { theme } = useUi();
  const v = props.view;
  const d = props.deadline;
  const gone = v.cells.filter((c) => c.kind === "past").length;
  return (
    <div
      className="mini-days"
      data-style={d.progressStyle}
      data-shape={d.cellShape}
      style={d.color ? ({ "--dl-color": d.color } as CSSProperties) : undefined}
      role="img"
      aria-label={`${gone} of ${v.cells.length} ${v.byWeek ? "weeks" : "days"} gone`}
    >
      {v.cells.map((c) => (
        <span key={c.dayIndex} className="mini-cell" data-kind={c.kind} data-due={c.isDueDay}>
          {theme === "terminal" &&
            d.progressStyle !== "bars" &&
            (c.kind === "past" ? BLOCK.past : c.kind === "today" ? BLOCK.today : c.isDueDay ? BLOCK.due : BLOCK.future)}
        </span>
      ))}
    </div>
  );
}

/** Touch screens (the phone) have no hover: tapping a tile opens its details as a bottom sheet. */
const TOUCH = typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches === true;

/**
 * A deadline as a small widget tile: name, "In 64 days" and a small ring or dot grid. Hovering
 * (or clicking, or tapping on the phone) shows the details: due date, note and checklist, which
 * can be ticked there. The pencil at the top opens the editor.
 */
export function DeadlineTile(props: {
  deadline: Deadline;
  now: number;
  onEdit: () => void;
  onDelete: () => void;
  onComplete: (done: boolean) => void;
  act: (action: () => Promise<unknown>) => void;
}) {
  const d = props.deadline;
  const v = computeDeadline(d, props.now);
  const { theme } = useUi();
  const [pinned, setPinned] = useState(false);
  const [item, setItem] = useState("");
  const [flip, setFlip] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const done = d.tasks.filter((t) => t.done).length;
  const showRing = d.viz !== "grid";
  const showDays = d.viz !== "ring";

  // A pinned tile closes on a click outside it or on Escape.
  useEffect(() => {
    if (!pinned) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !sheetRef.current?.contains(t)) setPinned(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPinned(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [pinned]);

  // Open the details towards the left near the window's right edge, and upwards near its bottom.
  const place = () => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setFlip(box.left + 320 > window.innerWidth - 8);
    setUp(box.bottom + 320 > window.innerHeight && box.top > 340);
  };
  useLayoutEffect(place, [pinned]);

  const details: ReactNode = (
    <div
      ref={sheetRef}
      className={TOUCH ? "dl-pop dl-sheet" : "dl-pop"}
      role="dialog"
      aria-label={`${d.title} details`}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="dl-pop-countdown">{v.state === "completed" ? "Done" : v.countdown}</p>
      <p className="muted small">{dueText(d)}</p>
      {d.description && <p className="deadline-notes">{d.description}</p>}
      {d.tasks.length > 0 && (
        <>
          <p className="muted small dl-pop-label">
            Checklist · {done} of {d.tasks.length} done
          </p>
          <ul className="task-list compact">
            {d.tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                compact
                onToggle={(on) => props.act(() => setTaskDone(t.id, on))}
                onColor={(c) => props.act(() => setTaskColor(t.id, c))}
                onDelete={() => props.act(() => deleteTasks([t.id]))}
              />
            ))}
          </ul>
        </>
      )}
      {d.completedAt === null && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault();
            const title = item.trim();
            if (!title) return;
            setItem("");
            props.act(() =>
              createTask({
                title,
                dueDate: null,
                priority: "normal",
                repeatDays: 0,
                color: null,
                deadlineId: d.id,
              }),
            );
          }}
        >
          <label className="sr-only" htmlFor={`dlt-add-${d.id}`}>
            Add a step to {d.title}
          </label>
          <input
            id={`dlt-add-${d.id}`}
            className="task-title-input"
            value={item}
            onChange={(e) => setItem(e.target.value)}
            onFocus={() => setPinned(true)}
            placeholder="Add a step…"
            maxLength={200}
            autoComplete="off"
          />
        </form>
      )}
      <footer className="form-actions deadline-actions">
        <button
          type="button"
          className={d.completedAt === null ? "button primary small-button" : "button small-button"}
          onClick={() => props.onComplete(d.completedAt === null)}
        >
          {d.completedAt === null ? "Mark finished" : "Reopen"}
        </button>
        <button type="button" className="icon-button push-right" onClick={props.onDelete} aria-label={`Delete ${d.title}`} title="Delete">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </footer>
    </div>
  );

  return (
    <article
      ref={ref}
      className="dl-tile"
      data-state={v.state}
      data-open={pinned}
      data-flip={flip}
      data-up={up}
      aria-labelledby={`dlt-${d.id}`}
      style={d.color ? ({ "--dl-color": d.color } as CSSProperties) : undefined}
      onPointerEnter={place}
      onClick={() => setPinned((p) => !p)}
    >
      <header className="dl-tile-head">
        <span className="dl-tile-dot" aria-hidden="true" />
        <h2 id={`dlt-${d.id}`} className="dl-tile-title" title={d.title}>
          {d.title}
        </h2>
        <button
          type="button"
          className="icon-button dl-tile-edit"
          aria-label={`Edit ${d.title}`}
          title="Edit"
          onClick={(e) => {
            e.stopPropagation();
            props.onEdit();
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M13.5 3.5l3 3L7 16H4v-3z M11.5 5.5l3 3" />
          </svg>
        </button>
      </header>

      <div className="dl-tile-body" data-ring={showRing}>
        <p className="dl-tile-when" data-state={v.state}>
          {theme === "terminal" && <span aria-hidden="true">{STATE_ICON[v.state]} </span>}
          {tileWhen(v)}
        </p>
        {showRing && <DeadlineRing view={v} size={48} color={d.color} />}
      </div>
      {showDays && <MiniDays view={v} deadline={d} />}

      {TOUCH
        ? pinned &&
          createPortal(
            <div
              className="dl-sheet-backdrop"
              onClick={(e) => {
                e.stopPropagation();
                setPinned(false);
              }}
            >
              {details}
            </div>,
            document.body,
          )
        : details}
    </article>
  );
}
