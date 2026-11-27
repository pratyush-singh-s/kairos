import { useEffect, useMemo, useState } from "react";
import { addDays, doneOn, formatTotal, parseIsoDate, tasksForDay, undatedTasks, weekOf } from "@focus/core";
import type { Space } from "../../ipc/spaces";
import { clearDoneTasks, createTask, inputOf, restoreTasks, setTaskDone, updateTask, type Task } from "../../ipc/tasks";
import { TaskCard } from "./TaskCard";
import type { Undo } from "./UndoToast";
import { useCardDrag } from "./useCardDrag";

const monthYear = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });
const shortMonth = new Intl.DateTimeFormat("en-GB", { month: "short" });
const shortMonthYear = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });
const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short" });

/** Phone or narrow window: the days fold to one line each; today starts open. */
function useNarrow(): boolean {
  const query = "(max-width: 700px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** A week of day columns with coloured cards, and the undated tasks below. Everyday, or a board space. */
export function WeekBoard(props: {
  /** null = Everyday. */
  space: Space | null;
  tasks: Task[];
  today: string;
  act: (action: () => Promise<unknown>) => Promise<void>;
  undo: Undo;
  onOpen: (t: Task) => void;
  onNew: (day: string | null) => void;
  onEditSpace?: () => void;
}) {
  const { tasks, today, act } = props;
  const spaceId = props.space?.id ?? null;
  const [anchor, setAnchor] = useState(today);
  const days = useMemo(() => weekOf(anchor), [anchor]);
  const narrow = useNarrow();
  // Days opened on a narrow screen (today is open until folded).
  const [opened, setOpened] = useState<Set<string>>(() => new Set([today]));
  const toggle = (day: string) =>
    setOpened((o) => {
      const n = new Set(o);
      if (n.has(day)) n.delete(day);
      else n.add(day);
      return n;
    });
  const go = (delta: number) => setAnchor(addDays(anchor, delta));
  // Ticked tasks leave the board after the strike animation (Ps asked); Undo brings one back.
  const undated = useMemo(() => undatedTasks(tasks).filter((t) => !t.done), [tasks]);

  const clearDone = () =>
    act(async () => {
      const ids = await clearDoneTasks(spaceId);
      if (ids.length) props.undo.offer(`Cleared ${ids.length} done ${ids.length === 1 ? "task" : "tasks"}.`, () => void act(() => restoreTasks(ids)));
    });

  // Drag a one-off card onto a day (or onto "No date") to move it.
  const drag = useCardDrag((id, day) => {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.dueDate === day) return;
    void act(() => updateTask(t.id, { ...inputOf(t), dueDate: day }));
  });
  const dropProps = drag.targetProps;
  const add = (title: string, dueDate: string | null) =>
    act(() => createTask({ title, dueDate, priority: "normal", repeatDays: 0, color: null, spaceId }));

  const card = (t: Task, day: string | null) => (
    <TaskCard
      key={`${t.id}-${day}`}
      task={t}
      day={day}
      today={today}
      vanish
      onToggle={(done) =>
        act(async () => {
          await setTaskDone(t.id, done);
          if (done) props.undo.offer(`Done: ${t.title}`, () => void act(() => setTaskDone(t.id, false)));
        })
      }
      onOpen={() => props.onOpen(t)}
      drag={drag.cardProps(t.id, t.repeatDays === 0)}
      wasDrag={drag.wasDrag}
    />
  );

  const first = parseIsoDate(days[0]!);
  const last = parseIsoDate(days[6]!);
  const range =
    first.getMonth() === last.getMonth()
      ? monthYear.format(first)
      : first.getFullYear() === last.getFullYear()
        ? `${shortMonth.format(first)} – ${shortMonthYear.format(last)}`
        : `${shortMonthYear.format(first)} – ${shortMonthYear.format(last)}`;

  return (
    <>
      <div className="board-toolbar">
        {/* Always takes its space, so the arrows never move when it appears. */}
        <button
          type="button"
          className="button small-button board-this-week"
          onClick={() => setAnchor(today)}
          data-hidden={days.includes(today)}
          tabIndex={days.includes(today) ? -1 : undefined}
          aria-hidden={days.includes(today)}
        >
          This week
        </button>
        <button type="button" className="icon-button" onClick={() => go(-7)} aria-label="Previous week" title="Previous week">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </button>
        <span className="board-range">{range}</span>
        <button type="button" className="icon-button" onClick={() => go(7)} aria-label="Next week" title="Next week">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M8 4l6 6-6 6" />
          </svg>
        </button>
        <span className="push-right" />
        {props.onEditSpace && (
          <button type="button" className="button small-button" onClick={props.onEditSpace}>
            Edit space
          </button>
        )}
        <button type="button" className="button small-button" onClick={() => void clearDone()} title="Delete every ticked one-off task here">
          Clear done
        </button>
        <button type="button" className="button primary" onClick={() => props.onNew(today)}>
          New task
        </button>
      </div>

      <div className="board" data-fold={narrow || undefined}>
        {days.map((day) => {
          const list = tasksForDay(tasks, day, today);
          const total = list.reduce((n, t) => n + (t.durationMin ?? 0), 0);
          const open = list.filter((t) => !doneOn(t, day));
          const date = parseIsoDate(day);
          return (
            <section key={day} className="board-col" data-today={day === today} data-past={day < today} aria-label={day} {...dropProps(day)}>
              {narrow ? (
                <button
                  type="button"
                  className="board-col-head board-fold-head"
                  aria-expanded={opened.has(day)}
                  onClick={() => toggle(day)}
                >
                  <span className="board-day">
                    <span className="num">{date.getDate()}</span> {weekday.format(date)}
                  </span>
                  <span className="muted small num">
                    {open.length === 0 ? "No tasks" : `${open.length} ${open.length === 1 ? "task" : "tasks"}`}
                    {total > 0 && ` · ${formatTotal(total)}`}
                  </span>
                  <svg className="board-fold-chev" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M6 8l4 4 4-4" />
                  </svg>
                </button>
              ) : (
                <header className="board-col-head">
                  <span className="board-day">
                    <span className="num">{date.getDate()}</span> {weekday.format(date)}
                  </span>
                  <span className="muted small num">{formatTotal(total)}</span>
                </header>
              )}
              {(!narrow || opened.has(day)) && (
                <>
                  <ul className="board-cards">{open.map((t) => card(t, day))}</ul>
                  <QuickAdd label={`Add a task on ${day}`} onAdd={(title) => add(title, day)} />
                </>
              )}
            </section>
          );
        })}
      </div>

      <section className="board-undated card" aria-labelledby="undated-title" {...dropProps(null)}>
        <h2 id="undated-title" className="history-day-title">
          <span>No date</span>
          <span className="muted">{undated.length}</span>
        </h2>
        {undated.length === 0 ? (
          <p className="muted small">Drag onto a day to plan it.</p>
        ) : (
          <ul className="board-cards board-cards-wrap">{undated.map((t) => card(t, null))}</ul>
        )}
        <QuickAdd label="Add a task with no date" onAdd={(title) => add(title, null)} />
      </section>
    </>
  );
}

/** "+ Add task" at the foot of a column: opens a one-line box; Enter adds, Esc closes. */
export function QuickAdd(props: { label: string; onAdd: (title: string) => void; button?: string; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  if (!open) {
    return (
      <button type="button" className="board-add" onClick={() => setOpen(true)}>
        {props.button ?? "+ Add task"}
      </button>
    );
  }
  return (
    <form
      className="board-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        const name = title.trim();
        if (name) props.onAdd(name);
        setTitle("");
      }}
    >
      <input
        className="task-title-input"
        value={title}
        autoFocus
        maxLength={200}
        placeholder={props.placeholder ?? "Task name, Enter to add"}
        aria-label={props.label}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        onBlur={() => !title.trim() && setOpen(false)}
      />
    </form>
  );
}
