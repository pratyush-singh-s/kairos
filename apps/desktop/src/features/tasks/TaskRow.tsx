import { dueLabel, repeatLabel } from "@focus/core";
import { today, type Task } from "../../ipc/tasks";
import { ColorDot } from "./ColorDot";
import { useStrike } from "./useStrike";

/** Where a timed task stands right now, shown on the right of a dashboard row. */
export interface TaskWhen {
  state: "past" | "now" | "soon" | "later";
  text: string;
}

/**
 * One line of the list: the tick box, the name, and when it is due or repeats.
 * `onEdit`/`onDelete` are left out on the dashboard, where only ticking is offered.
 */
export function TaskRow(props: {
  task: Task;
  onToggle: (done: boolean) => void;
  onColor: (color: string | null) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Hide "Today" on the dashboard, where every task is today's. */
  compact?: boolean;
  /** The row folds away after the tick animation (lists that hide done tasks). */
  vanish?: boolean;
  when?: TaskWhen;
}) {
  const t = props.task;
  const due = t.dueDate ? dueLabel(t.dueDate, today()) : null;
  const repeat = repeatLabel(t.repeatDays);
  const showDue = due && !(props.compact && due.text === "Today");
  const strike = useStrike(props.onToggle);
  return (
    <li
      className="task-row"
      data-done={t.done}
      data-priority={t.priority}
      data-striking={strike.striking ? (props.vanish ? "out" : "stay") : undefined}
      data-when={props.when?.state}
    >
      <span className="task-check">
        <input id={`task-${t.id}`} type="checkbox" checked={t.done || strike.striking} onChange={(e) => strike.toggle(e.target.checked, e)} />
        <ColorDot color={t.color} label={t.title} onChange={props.onColor} />
        <label htmlFor={`task-${t.id}`} className="task-title">
          {t.title}
        </label>
        {props.when && (
          <span className="task-when num" data-when={props.when.state} aria-live={props.when.state === "soon" ? "off" : undefined}>
            {props.when.text}
          </span>
        )}
      </span>
      <span className="task-meta">
        {t.priority === "high" && <span className="task-tag tag-high">High</span>}
        {t.priority === "low" && <span className="task-tag tag-low">Low</span>}
        {repeat && (
          <span className="task-tag tag-repeat" title="Repeats">
            <span aria-hidden="true">↻ </span>
            {repeat}
          </span>
        )}
        {/* An unfinished task from an earlier day just carries on: no "Overdue" chip (Ps asked). */}
        {showDue && !(due.overdue && !t.done) && <span className="task-tag tag-due">{due.text}</span>}
      </span>
      {(props.onEdit || props.onDelete) && (
        <span className="task-actions">
          {props.onEdit && (
            <button type="button" className="icon-button" onClick={props.onEdit} aria-label={`Edit ${t.title}`} title="Edit">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M13.5 3.5l3 3L7 16H4v-3z M11.5 5.5l3 3" />
              </svg>
            </button>
          )}
          {props.onDelete && (
            <button type="button" className="icon-button" onClick={props.onDelete} aria-label={`Delete ${t.title}`} title="Delete">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
          )}
        </span>
      )}
    </li>
  );
}
