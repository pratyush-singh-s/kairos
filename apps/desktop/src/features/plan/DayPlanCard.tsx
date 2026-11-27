import { useMemo, useState } from "react";
import { addDays, formatTimeRange } from "@focus/core";
import { useStrike } from "../tasks/useStrike";
import { getDayPlan, saveDayPlan, type DayPlan } from "../../ipc/dayPlan";
import { useHistoryChanged } from "../../ipc/history";
import { deleteTasks, inputOf, listTasks, setTaskDone, today, updateTask, type Task } from "../../ipc/tasks";
import { useCommand } from "../../useCommand";

/** Today's tasks and undated ones: what the morning pick offers (not ones left from earlier days, Ps asked). */
function candidates(tasks: Task[], day: string): Task[] {
  const bit = 1 << new Date().getDay();
  const open = tasks.filter(
    (t) => !t.done && t.planDay === null && (t.repeatDays ? (t.repeatDays & bit) !== 0 : t.dueDate === null || t.dueDate === day),
  );
  const rank = (t: Task) => (t.dueDate === day || t.repeatDays ? 0 : t.dueDate ? 1 : 2);
  return open.sort((a, b) => rank(a) - rank(b) || (a.startTime ?? "99").localeCompare(b.startTime ?? "99") || a.createdAt - b.createdAt).slice(0, 30);
}

/** One-off to-dos due today or before that aren't done: what the evening review asks about. */
function leftovers(tasks: Task[], day: string): Task[] {
  return tasks.filter((t) => !t.done && !t.repeatDays && t.planDay === null && t.dueDate === day);
}

/**
 * Morning: pick today's top three. Evening (from the review hour): move what's left to tomorrow,
 * take its date off, or delete it. On the laptop and phone dashboards; the launcher shows the top three.
 */
export function DayPlanCard(props: { onOpenTasks: () => void }) {
  const [planState, reloadPlan] = useCommand(getDayPlan, 60_000);
  const [taskState, reloadTasks] = useCommand(listTasks, 60_000);
  const reload = () => {
    reloadPlan();
    reloadTasks();
  };
  useHistoryChanged(reload, "tasks-changed");
  useHistoryChanged(reload, "plan-changed");
  useHistoryChanged(reload, "sync-changed");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const day = today();
  const tasks = taskState.kind === "ready" ? taskState.value : [];
  const view = planState.kind === "ready" ? planState.value : null;
  const plan: DayPlan = view?.plan ?? { date: day, top: [], reviewed: false };
  const evening = view !== null && new Date().getHours() >= view.reviewHour && !plan.reviewed;
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const top = plan.top.map((id) => byId.get(id)).filter((t): t is Task => !!t);

  const run = (action: () => Promise<unknown>) =>
    action()
      .then(() => setError(null))
      .catch((err: unknown) => setError(String(err)))
      .finally(reload);
  const save = (next: Partial<DayPlan>) => run(() => saveDayPlan({ ...plan, date: day, ...next }));

  if (planState.kind === "error" || taskState.kind === "error") {
    return <p className="error" role="alert">Could not load today's plan: {planState.kind === "error" ? planState.message : (taskState as { message: string }).message}</p>;
  }
  if (!view || taskState.kind !== "ready") return <p className="muted">Loading…</p>;

  if (evening) return <Review tasks={leftovers(tasks, day)} doneToday={tasks.filter((t) => t.done && t.doneDate === day).length} onRun={run} onDone={() => void save({ reviewed: true })} error={error} />;

  if (picking || top.length === 0) {
    return (
      <Picker
        options={candidates(tasks, day)}
        chosen={plan.top}
        firstTime={top.length === 0 && !picking}
        onSave={(ids) => {
          setPicking(false);
          void save({ top: ids });
        }}
        onCancel={top.length > 0 ? () => setPicking(false) : undefined}
        onOpenTasks={props.onOpenTasks}
      />
    );
  }

  return (
    <div className="day-plan">
      <ol className="day-top">
        {top.map((t) => (
          <TopRow key={t.id} task={t} onToggle={(done) => void run(() => setTaskDone(t.id, done))} />
        ))}
      </ol>
      {top.every((t) => t.done) && <p className="all-done">Top {top.length === 1 ? "task" : top.length} done. Nice work.</p>}
      <div className="form-actions">
        <button type="button" className="link-button" onClick={() => setPicking(true)}>
          Change
        </button>
        <span className="muted small push-right">Review from {String(view.reviewHour).padStart(2, "0")}:00</span>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}

/** One of the top three. Ticking plays the strike animation; it stays crossed out (so "Top 3 done" still shows). */
function TopRow(props: { task: Task; onToggle: (done: boolean) => void }) {
  const t = props.task;
  const strike = useStrike(props.onToggle);
  return (
    <li data-done={t.done} data-striking={strike.striking && !t.done ? "stay" : undefined}>
      <label className="check">
        <input type="checkbox" checked={t.done || strike.striking} onChange={(e) => strike.toggle(e.target.checked, e)} />
        <span className="day-top-title">{t.title}</span>
      </label>
      {t.startTime && <span className="muted small">{formatTimeRange(t.startTime, null)}</span>}
    </li>
  );
}

function Picker(props: {
  options: Task[];
  chosen: string[];
  firstTime: boolean;
  onSave: (ids: string[]) => void;
  onCancel?: () => void;
  onOpenTasks: () => void;
}) {
  const [ids, setIds] = useState(props.chosen.filter((id) => props.options.some((t) => t.id === id)));
  const toggle = (id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 3 ? cur : [...cur, id]));

  if (props.options.length === 0) {
    return (
      <div className="day-plan">
        <p className="muted">Nothing on your list to pick from yet.</p>
        <button type="button" className="link-button" onClick={props.onOpenTasks}>
          Add to-dos
        </button>
      </div>
    );
  }
  return (
    <div className="day-plan">
      <p className="muted small">{props.firstTime ? "Good start: pick up to three things that would make today a win." : "Pick up to three, most important first."}</p>
      <ul className="day-pick">
        {props.options.map((t) => {
          const n = ids.indexOf(t.id);
          return (
            <li key={t.id}>
              <button type="button" className="day-pick-item" data-chosen={n >= 0} aria-pressed={n >= 0} aria-label={n >= 0 ? `${t.title}, pick ${n + 1} of 3` : t.title} onClick={() => toggle(t.id)} disabled={n < 0 && ids.length >= 3}>
                <span className="day-pick-num" aria-hidden="true">
                  {n >= 0 ? n + 1 : ""}
                </span>
                <span className="day-pick-title">{t.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="form-actions">
        <button type="button" className="button primary" disabled={ids.length === 0} onClick={() => props.onSave(ids)}>
          {ids.length ? `Set today's top ${ids.length}` : "Pick at least one"}
        </button>
        {props.onCancel && (
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function Review(props: { tasks: Task[]; doneToday: number; onRun: (a: () => Promise<unknown>) => void; onDone: () => void; error: string | null }) {
  const tomorrow = addDays(today(), 1);
  const move = (t: Task, due: string | null) => props.onRun(() => updateTask(t.id, { ...inputOf(t), dueDate: due }));
  return (
    <div className="day-plan day-review">
      <p>
        <strong>Evening review.</strong>{" "}
        <span className="muted">
          {props.doneToday > 0 ? `You finished ${props.doneToday} today. ` : ""}
          {props.tasks.length === 0 ? "Nothing left over." : `${props.tasks.length} left. What should happen to ${props.tasks.length === 1 ? "it" : "them"}?`}
        </span>
      </p>
      {props.tasks.length > 0 && (
        <ul className="day-review-list">
          {props.tasks.map((t) => (
            <li key={t.id}>
              <span className="day-top-title">
                {t.title}
              </span>
              <span className="day-review-actions">
                <button type="button" className="button small" onClick={() => move(t, tomorrow)}>
                  Tomorrow
                </button>
                <button type="button" className="button small" onClick={() => move(t, null)} title="Keep it, with no date">
                  No date
                </button>
                <button type="button" className="button small danger" onClick={() => props.onRun(() => deleteTasks([t.id]))}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        {props.tasks.length > 1 && (
          <button type="button" className="button" onClick={() => props.onRun(() => Promise.all(props.tasks.map((t) => updateTask(t.id, { ...inputOf(t), dueDate: tomorrow }))))}>
            Move all to tomorrow
          </button>
        )}
        <button type="button" className="button primary" onClick={props.onDone}>
          Done for today
        </button>
      </div>
      {props.error && <p className="error small" role="alert">{props.error}</p>}
    </div>
  );
}
