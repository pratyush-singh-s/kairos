import { useState } from "react";
import { timeOfDay } from "@focus/core";
import { computeDeadline } from "@focus/core";
import type { Deadline } from "../../ipc/deadlines";
import { createTask, deleteTasks, setTaskColor, setTaskDone } from "../../ipc/tasks";
import { useUi } from "../../theme/UiProvider";
import { TaskRow } from "../tasks/TaskRow";
import { ColorDot } from "../tasks/ColorDot";
import { DayGrid } from "./DayGrid";
import { DeadlineRing } from "./DeadlineRing";

const dueFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeFormat = { format: timeOfDay };

/** Icon + word for each state, so it never relies on colour alone. */
export const STATE_ICON: Record<string, string> = {
  completed: "✓",
  overdue: "⚠",
  today: "◷",
  urgent: "»",
  active: "●",
  upcoming: "○",
};

export function dueText(d: Deadline): string {
  const due = new Date(d.dueAt);
  return `Due ${dueFormat.format(due)}${d.allDay ? "" : ` at ${timeFormat.format(due)}`}`;
}

export function DeadlineCard(props: {
  deadline: Deadline;
  now: number;
  onEdit: () => void;
  onDelete: () => void;
  onComplete: (done: boolean) => void;
  onColor: (color: string | null) => void;
  /** Runs a checklist change and reloads. */
  act: (action: () => Promise<unknown>) => void;
}) {
  const d = props.deadline;
  const v = computeDeadline(d, props.now);
  const { theme } = useUi();
  const [item, setItem] = useState("");
  const done = d.tasks.filter((t) => t.done).length;
  const showRing = d.viz !== "grid";
  const showGrid = d.viz !== "ring";

  return (
    <article className="card deadline-card" data-state={v.state} aria-labelledby={`dl-${d.id}`}>
      <header className="deadline-head">
        <ColorDot color={d.color} label={d.title} onChange={props.onColor} />
        <h2 id={`dl-${d.id}`} className="deadline-title">
          {d.title}
        </h2>
        <span className="dl-state" data-state={v.state}>
          <span aria-hidden="true">{STATE_ICON[v.state]} </span>
          {v.label}
        </span>
      </header>

      <div className="deadline-body" data-viz={d.viz}>
        {showRing && (
          <DeadlineRing view={v} color={d.color}>
            {theme === "terminal" ? (
              <span className="ring-short">{v.state === "completed" ? "done" : v.short}</span>
            ) : (
              <>
                <span className="ring-short">{v.state === "completed" ? "✓" : v.short.replace(/^-/, "")}</span>
                <span className="ring-caption">{v.state === "overdue" ? "overdue" : v.state === "upcoming" ? "to start" : v.state === "completed" ? "done" : "left"}</span>
              </>
            )}
          </DeadlineRing>
        )}
        <div className="deadline-facts">
          {theme === "terminal" ? (
            <dl className="kv">
              <dt>remaining</dt>
              <dd className="num">"{v.state === "completed" ? "done" : v.short}"</dd>
              <dt>progress</dt>
              <dd className="num">{Math.round((1 - v.fraction) * 100)}%</dd>
              <dt>due</dt>
              <dd>{dueText(d).replace(/^Due /, "")}</dd>
            </dl>
          ) : (
            <>
              <p className="deadline-countdown">{v.countdown}</p>
              <p className="muted small">{dueText(d)}</p>
            </>
          )}
          {d.description && <p className="deadline-notes">{d.description}</p>}
        </div>
      </div>

      {showGrid && (
        <DayGrid
          cells={v.cells}
          byWeek={v.byWeek}
          style={d.progressStyle}
          shape={d.cellShape}
          columns={d.gridCols}
          color={d.color}
        />
      )}

      <section className="deadline-checklist" aria-label={`Checklist for ${d.title}`}>
        {d.tasks.length > 0 && (
          <>
            <p className="muted small">
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
              props.act(() => createTask({ title, dueDate: null, priority: "normal", repeatDays: 0, color: null, deadlineId: d.id }));
            }}
          >
            <label className="sr-only" htmlFor={`dl-add-${d.id}`}>
              Add a step to {d.title}
            </label>
            <input
              id={`dl-add-${d.id}`}
              className="task-title-input"
              value={item}
              onChange={(e) => setItem(e.target.value)}
              placeholder="Add a step…"
              maxLength={200}
              autoComplete="off"
            />
          </form>
        )}
      </section>

      <footer className="form-actions deadline-actions">
        <button type="button" className={d.completedAt === null ? "button primary small-button" : "button small-button"} onClick={() => props.onComplete(d.completedAt === null)}>
          {d.completedAt === null ? "Mark finished" : "Reopen"}
        </button>
        <button type="button" className="icon-button push-right" onClick={props.onEdit} aria-label={`Edit ${d.title}`} title="Edit">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M13.5 3.5l3 3L7 16H4v-3z M11.5 5.5l3 3" />
          </svg>
        </button>
        <button type="button" className="icon-button" onClick={props.onDelete} aria-label={`Delete ${d.title}`} title="Delete">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </footer>
    </article>
  );
}
