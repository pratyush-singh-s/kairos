import type { PointerEvent } from "react";
import { doneOn, formatLength, formatTimeRange, repeatLabel } from "@focus/core";
import type { Task } from "../../ipc/tasks";
import { useStrike } from "./useStrike";

/**
 * A card on the week board, tinted with the task's colour: time, name, label, description, length.
 * A click anywhere opens the editor; the box ticks it. One-off tasks can be dragged to another day.
 */
export function TaskCard(props: {
  task: Task;
  /** The column's day (null in the No date list). */
  day: string | null;
  today: string;
  onToggle: (done: boolean) => void;
  onOpen: () => void;
  /** Drag handlers from useCardDrag. */
  drag: { "data-dragging": boolean; onPointerDown: (e: PointerEvent<HTMLElement>) => void };
  /** True right after a drag ended, so the click that follows is not an open. */
  wasDrag: () => boolean;
  /** The card folds away after the tick animation (the week board hides done tasks). */
  vanish?: boolean;
}) {
  const t = props.task;
  const done = props.day ? doneOn(t, props.day) : t.done;
  // No "Overdue" tag on tasks: unfinished ones just carry on (Ps asked). Deadlines still show it.
  const overdue = false;
  // A repeating task only knows its latest tick, so it can only be ticked on today's column.
  const canTick = t.repeatDays === 0 || props.day === props.today;
  const repeat = repeatLabel(t.repeatDays);
  const strike = useStrike(props.onToggle);

  return (
    <li
      className="task-card"
      data-done={done}
      data-striking={strike.striking ? (props.vanish ? "out" : "stay") : undefined}
      data-priority={t.priority}
      data-colored={t.color !== null}
      data-movable={t.repeatDays === 0}
      style={t.color ? { ["--card-color" as string]: t.color } : undefined}
      title={t.repeatDays === 0 ? "Click to open, drag to move" : "Click to open"}
      {...props.drag}
      onClick={(e) => {
        if (props.wasDrag() || (e.target as HTMLElement).closest("input, button")) return;
        props.onOpen();
      }}
    >
      <div className="task-card-top">
        {t.startTime ? (
          <span className="task-card-time">
            <span aria-hidden="true">◷ </span>
            {formatTimeRange(t.startTime, t.endTime)}
          </span>
        ) : (
          <span />
        )}
        <input
          type="checkbox"
          className="task-card-check"
          checked={done || strike.striking}
          disabled={!canTick}
          title={canTick ? (done ? "Not done" : "Done") : "Repeating tasks are ticked on the day"}
          aria-label={`${t.title} done`}
          onChange={(e) => strike.toggle(e.target.checked, e)}
        />
      </div>
      <button
        type="button"
        className="task-card-open"
        onClick={() => !props.wasDrag() && props.onOpen()}
        aria-label={`Open ${t.title}`}
      >
        <span className="task-card-title">{t.title}</span>
        {t.category && <span className="task-card-label">{t.category}</span>}
      </button>
      {t.description && <p className="task-card-desc">{t.description}</p>}
      {(t.durationMin || repeat || overdue || t.priority !== "normal") && (
        <div className="task-card-foot">
          {t.durationMin ? <span className="num">{formatLength(t.durationMin)}</span> : null}
          {repeat && (
            <span className="task-card-tag">
              <span aria-hidden="true">↻ </span>
              {repeat}
            </span>
          )}
          {t.priority === "high" && <span className="task-card-tag tag-high">High</span>}
          {t.priority === "low" && <span className="task-card-tag">Low</span>}
          {overdue && <span className="task-card-tag tag-overdue">Overdue</span>}
        </div>
      )}
    </li>
  );
}
