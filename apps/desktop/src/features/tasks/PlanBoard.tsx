import { formatTotal, planDayKind, planDayTasks } from "@focus/core";
import { spaceInputOf, updateSpace, type Space } from "../../ipc/spaces";
import { createTask, inputOf, setTaskDone, updateTask, type Task } from "../../ipc/tasks";
import { TaskCard } from "./TaskCard";
import { planDayLabel } from "./TaskForm";
import { useCardDrag } from "./useCardDrag";
import { QuickAdd } from "./WeekBoard";

/**
 * A day-by-day plan: Day 1, Day 2 ... each with its steps (e.g. Day 1 write the code, Day 2
 * debugging, Day 3 new version). With a start date the days get real dates, today's day is
 * marked, and its steps also show on the dashboard. Drag a step to another day.
 */
export function PlanBoard(props: {
  plan: Space;
  tasks: Task[];
  today: string;
  act: (action: () => Promise<unknown>) => Promise<void>;
  onOpen: (t: Task) => void;
  onNew: (day: number | null) => void;
  onEditSpace: () => void;
}) {
  const { plan, tasks, today, act } = props;
  const done = tasks.filter((t) => t.done).length;
  const unplanned = planDayTasks(tasks, null);

  const drag = useCardDrag((id, key) => {
    const t = tasks.find((x) => x.id === id);
    const day = key === null ? null : Number(key);
    if (!t || t.planDay === day) return;
    void act(() => updateTask(t.id, { ...inputOf(t), planDay: day }));
  });
  const dropProps = (day: number | null) => drag.targetProps(day === null ? null : String(day));
  const add = (title: string, planDay: number | null) =>
    act(() => createTask({ title, dueDate: null, priority: "normal", repeatDays: 0, color: null, spaceId: plan.id, planDay }));
  const setPlan = (change: Partial<Space>) => act(() => updateSpace(plan.id, { ...spaceInputOf(plan), ...change }));

  const card = (t: Task) => (
    <TaskCard
      key={t.id}
      task={t}
      day={null}
      today={today}
      onToggle={(on) => act(() => setTaskDone(t.id, on))}
      onOpen={() => props.onOpen(t)}
      drag={drag.cardProps(t.id, true)}
      wasDrag={drag.wasDrag}
    />
  );

  return (
    <>
      <div className="board-toolbar plan-toolbar">
        <span className="plan-progress">
          <span className="num">{done}</span> of <span className="num">{tasks.length}</span> {tasks.length === 1 ? "step" : "steps"} done
        </span>
        <label className="plan-start">
          <span>Day 1 is</span>
          <input
            type="date"
            value={plan.startDate ?? ""}
            onChange={(e) => void setPlan({ startDate: e.target.value || null })}
            aria-label="Date of Day 1"
          />
        </label>
        {plan.startDate === null ? (
          <button type="button" className="button small-button" onClick={() => void setPlan({ startDate: today })}>
            Start today
          </button>
        ) : (
          <button type="button" className="button small-button" onClick={() => void setPlan({ startDate: null })} title="Days stay numbered, without dates">
            Remove dates
          </button>
        )}
        <span className="push-right" />
        <button type="button" className="button small-button" onClick={props.onEditSpace}>
          Edit space
        </button>
        <button type="button" className="button primary" onClick={() => props.onNew(1)}>
          New step
        </button>
      </div>

      <div className="plan-board" style={plan.color ? { ["--space-color" as string]: plan.color } : undefined}>
        {Array.from({ length: plan.days }, (_, i) => {
          const day = i + 1;
          const list = planDayTasks(tasks, day);
          const kind = planDayKind(plan.startDate, day, today);
          const total = list.reduce((n, t) => n + (t.durationMin ?? 0), 0);
          const [name, date] = planDayLabel(day, plan.startDate).split(" · ");
          const ticked = list.filter((t) => t.done).length;
          return (
            <section key={day} className="plan-day" data-kind={kind ?? "undated"} aria-label={`Day ${day}`} {...dropProps(day)}>
              <header className="board-col-head">
                <span className="board-day">
                  {name}
                  {date && <span className="plan-date muted"> {date}</span>}
                </span>
                <span className="muted small num">
                  {list.length > 0 && `${ticked}/${list.length}`}
                  {total > 0 && ` · ${formatTotal(total)}`}
                </span>
              </header>
              <ul className="board-cards">{list.map(card)}</ul>
              <QuickAdd label={`Add a step on Day ${day}`} button="+ Add step" placeholder="Step, Enter to add" onAdd={(title) => add(title, day)} />
            </section>
          );
        })}
        <button type="button" className="plan-add-day" onClick={() => void setPlan({ days: plan.days + 1 })} disabled={plan.days >= 365}>
          + Add day
        </button>
      </div>

      <section className="board-undated card" aria-labelledby="unplanned-title" {...dropProps(null)}>
        <h2 id="unplanned-title" className="history-day-title">
          <span>No day yet</span>
          <span className="muted">{unplanned.length}</span>
        </h2>
        {unplanned.length === 0 ? (
          <p className="muted small">Drag onto a day to plan it.</p>
        ) : (
          <ul className="board-cards board-cards-wrap">{unplanned.map(card)}</ul>
        )}
        <QuickAdd label="Add a step with no day" button="+ Add idea" placeholder="Idea, Enter to add" onAdd={(title) => add(title, null)} />
      </section>
    </>
  );
}
