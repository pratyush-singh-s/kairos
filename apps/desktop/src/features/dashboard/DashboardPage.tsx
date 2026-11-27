import { useState } from "react";
import { computeDeadline, formatClock, formatDurationShort } from "@focus/core";
import type { Preset } from "../../ipc/database";
import { ENDLESS_FOCUS_S, PHASE_LABEL, isActive, isEndless, pauseTimer, resumeTimer, sessionCount, startTimer, stopTimer, type TimerSnapshot } from "../../ipc/timer";
import { useRemaining, useTimer } from "../timer/useTimer";
import { showTimerTab } from "../clock/ClockPage";
import { Card } from "../../components/Card";
import { listPresets } from "../../ipc/database";
import { loadDashboard } from "../../ipc/dashboard";
import { browserLinkStatus } from "../../ipc/browserLink";
import { useHistoryChanged } from "../../ipc/history";
import { OPEN_NOTE_KEY } from "../../ipc/notes";
import type { AppTime } from "../../ipc/tracking";
import { useCommand, type Loadable } from "../../useCommand";
import type { RouteId } from "../../app/routes";
import { useUi } from "../../theme/UiProvider";
import { byTimeOfDay, taskWhen, useTaskClock } from "./taskTiming";
import { createTask, setTaskColor, setTaskDone, today, type Task } from "../../ipc/tasks";
import { TaskRow } from "../tasks/TaskRow";
import type { Deadline } from "../../ipc/deadlines";
import { DeadlineRing } from "../deadlines/DeadlineRing";
import { STATE_ICON } from "../deadlines/DeadlineCard";
import { useNow } from "../deadlines/useNow";
import { TodayEvents } from "../calendar/TodayEvents";
import { GoalLine } from "../goal/GoalLine";
import { Glyph } from "../../components/Icon";
import { DayPlanCard } from "../plan/DayPlanCard";
import { NowDashboard } from "./NowDashboard";
import { UsageDonut } from "./UsageDonut";
import { openable } from "./openable";
import { Greeting } from "./Greeting";
import { useAscii } from "../../components/Ascii";
import { Num } from "../../components/Num";


export function DashboardPage(props: { onNavigate: (id: RouteId) => void }) {
  // Refresh every minute and when the window regains focus, so "today" rolls over at midnight.
  const [dash, reload] = useCommand(loadDashboard, 60_000);
  const [presets] = useCommand(listPresets);
  const [link, reloadLink] = useCommand(browserLinkStatus, 5_000);
  // "Today's focus" updates as soon as a session ends.
  useHistoryChanged(reload);
  useHistoryChanged(reload, "activity-changed");
  useHistoryChanged(reload, "tasks-changed");
  useHistoryChanged(reload, "deadlines-changed");
  useHistoryChanged(reload, "notes-changed");
  const { theme, newDashboard } = useUi();
  const ascii = useAscii();

  if (newDashboard) return <NowDashboard dash={dash} reload={reload} presets={presets} link={link} onNavigate={props.onNavigate} />;

  return (
    <section aria-labelledby="dash-title">
      <h1 id="dash-title" className="page-title">
        <Greeting />
      </h1>

      {dash.kind === "error" && (
        <div className="card notice error-notice" role="alert">
          <p>
            <strong>Could not load the dashboard.</strong> {dash.message}
          </p>
          <button type="button" className="button" onClick={reload}>
            Try again
          </button>
        </div>
      )}

      <div className="dashboard-grid">
        <Card title="Focus" className="span-2">
          <FocusNow presets={presets} onOpen={() => { showTimerTab("focus"); props.onNavigate("timer"); }} />
        </Card>

        <Card title="Today's focus">
          <Loaded state={dash} onRetry={reload}>
            {(d) =>
              theme === "terminal" ? (
                <dl className="kv">
                  <dt>focus_time</dt>
                  <dd className="num">{formatDurationShort(d.today.focusSeconds)}</dd>
                  <dt>completed</dt>
                  <dd className="num">{d.today.completedSessions}</dd>
                  <dt>interrupted</dt>
                  <dd className="num">{d.today.interruptedSessions}</dd>
                  <dt>pc_on</dt>
                  <dd className="num">{formatDurationShort(d.pcOnToday ?? 0)}</dd>
                </dl>
              ) : (
              <>
                <p className="big-number"><Num>{formatDurationShort(d.today.focusSeconds)}</Num></p>
                <p className="muted">
                  {d.today.completedSessions} completed · {d.today.interruptedSessions} interrupted
                </p>
                <p className="muted" {...openable(() => props.onNavigate("history"), "PC on today. Open History")}>PC on today: {formatDurationShort(d.pcOnToday ?? 0)}</p>
              </>
              )
            }
          </Loaded>
          <GoalLine />
        </Card>

        <Card title="Today's plan" className="span-2">
          <DayPlanCard onOpenTasks={() => props.onNavigate("tasks")} />
        </Card>

        <Card title="Browser blocking">
          <Loaded state={link} onRetry={reloadLink}>
            {(l) => (
              <>
                <p>
                  <span className={`pill ${l.linked ? "pill-ok" : "pill-neutral"}`}>
                    <span aria-hidden="true">{l.linked ? "● " : "○ "}</span>
                    {l.linked ? (l.blocking ? "Connected · blocking" : "Connected") : "Not connected"}
                  </span>
                </p>
                <p className="muted">
                  {!l.listening
                    ? "Another program is blocking the connection to your browser. Restart your PC, or close other focus or blocker apps, then open Focus again."
                    : l.linked
                      ? l.blocking
                        ? "Your browser is blocking your listed sites until this focus phase ends."
                        : "Blocking turns on in your browser when a focus phase starts."
                      : "Open Firefox or Zen with Kairos Blocker 0.10 or later to link it."}
                </p>
              </>
            )}
          </Loaded>
        </Card>

        <Card title="Upcoming deadlines">
          <Loaded state={dash} onRetry={reload}>
            {(d) =>
              d.upcomingDeadlines.length === 0 ? (
                <Empty text="No upcoming deadlines." more="Add one on the Deadlines page." />
              ) : (
                <UpcomingDeadlines deadlines={d.upcomingDeadlines} onOpen={() => props.onNavigate("deadlines")} />
              )
            }
          </Loaded>
        </Card>

        <Card title="Today's tasks">
          <Loaded state={dash} onRetry={reload}>
            {(d) => <TodayTasks tasks={d.todayTasks} onChanged={reload} onOpen={() => props.onNavigate("tasks")} />}
          </Loaded>
        </Card>

        <Card title="Today's calendar">
          <TodayEvents onOpen={() => props.onNavigate("calendar")} />
        </Card>

        <Card title="Today's activity">
          <Loaded state={dash} onRetry={reload}>
            {(d) =>
              d.todayApps.length === 0 ? (
                <Empty text="No app activity recorded today." more="Turn on App tracking in Settings to see where your time goes." />
              ) : ascii ? (
                <AppBars apps={d.todayApps.slice(0, 5)} />
              ) : (
                <UsageDonut apps={d.todayApps} onOpen={() => props.onNavigate("history")} />
              )
            }
          </Loaded>
        </Card>

        <Card title="Pinned notes">
          <Loaded state={dash} onRetry={reload}>
            {(d) =>
              d.pinnedNotes.length === 0 ? (
                <Empty text="No pinned notes." more="Pin a note on the Notes page to keep it here." />
              ) : (
                <ul className="list pinned-notes">
                  {d.pinnedNotes.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="link-button pinned-note"
                        onClick={() => {
                          try {
                            localStorage.setItem(OPEN_NOTE_KEY, n.id);
                          } catch {
                            // The Notes page then opens the last note instead.
                          }
                          props.onNavigate("notes");
                        }}
                      >
                        <strong>{n.title || "Untitled"}</strong>
                        {n.preview && <span className="muted small"> {n.preview.replace(/\s+/g, " ")}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </Loaded>
        </Card>
      </div>

    </section>
  );
}

/** "25 min", "45 s" or "Endless": how long a preset's focus lasts. */
function presetLength(p: Preset): string {
  if (p.focusS >= ENDLESS_FOCUS_S) return "Endless";
  return p.focusS < 60 ? `${p.focusS} s` : `${Math.round(p.focusS / 60)} min`;
}

function FocusNow(props: { presets: Loadable<Preset[]>; onOpen: () => void }) {
  const [timer] = useTimer();
  const [error, setError] = useState<string | null>(null);
  const snap = timer.kind === "ready" ? timer.value : null;
  const remaining = useRemainingOrZero(snap);
  const run = (action: () => Promise<unknown>) =>
    action()
      .then(() => setError(null))
      .catch((err: unknown) => setError(`Couldn't control the timer: ${String(err)}`));
  const errorLine = error && <p className="error small" role="alert">{error}</p>;

  if (snap && isActive(snap)) {
    return (
      <div className="focus-now">
        <p>
          <span className="big-number">
            {formatClock(isEndless(snap) ? (snap.durationMs - remaining) / 1000 : Math.ceil(remaining / 1000))}
          </span>{" "}
          <span className="muted">
            {PHASE_LABEL[snap.phase]}
            {snap.status === "paused" ? " · paused" : snap.status === "waiting" ? " · ready to start" : ""}
            {isEndless(snap) ? " · endless" : ` · session ${sessionCount(snap)}`} · {snap.presetName}
          </span>
        </p>
        <div className="form-actions">
          {snap.status === "running" && (
            <button type="button" className="button primary" onClick={() => void run(pauseTimer)}>
              Pause
            </button>
          )}
          {snap.status === "paused" && (
            <button type="button" className="button primary" onClick={() => void run(resumeTimer)}>
              Resume
            </button>
          )}
          <button type="button" className="button" onClick={() => void run(stopTimer)}>
            Stop
          </button>
          <button type="button" className="link-button" onClick={props.onOpen}>
            Open timer
          </button>
        </div>
        {errorLine}
      </div>
    );
  }
  return (
    <>
      <p className="muted">No session running. Start one:</p>
      {props.presets.kind === "ready" && (
        <ul className="chips" aria-label="Focus presets">
          {props.presets.value.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="chip chip-button"
                aria-label={`Start ${p.name}, ${presetLength(p)} focus`}
                onClick={() => void run(() => startTimer(p.id))}
              >
                <Glyph name="play" className="chip-play" />
                {p.name.toLowerCase() === presetLength(p).toLowerCase() ? p.name : `${p.name} · ${presetLength(p)}`}
              </button>
            </li>
          ))}
        </ul>
      )}
      {props.presets.kind === "error" && <p className="error" role="alert">Couldn't read your presets: {props.presets.message}</p>}
      {errorLine}
      <p className="dash-open-timer">
        <button type="button" className="link-button" onClick={props.onOpen}>
          Open timer
        </button>
      </p>
    </>
  );
}

/** Each open deadline as a small ring with its countdown. */
export function UpcomingDeadlines(props: { deadlines: Deadline[]; onOpen: () => void }) {
  const fastest = Math.min(60_000, ...props.deadlines.map((d) => computeDeadline(d, Date.now()).refreshMs));
  const now = useNow(fastest);
  return (
    <>
      <ul className="dash-deadlines">
        {props.deadlines.map((d) => {
          const v = computeDeadline(d, now);
          return (
            <li key={d.id} data-state={v.state}>
              <DeadlineRing view={v} size={38} color={d.color} />
              <span className="dash-deadline-text">
                <span className="dash-deadline-title">{d.title}</span>
                <span className="muted small">
                  <span aria-hidden="true">{STATE_ICON[v.state]} </span>
                  {v.state === "active" || v.state === "urgent" ? v.countdown : v.label}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="link-button small" onClick={props.onOpen}>
        All deadlines
      </button>
    </>
  );
}

/** Today's list with working tick boxes and a one-line "add for today" box. */
export function TodayTasks(props: { tasks: Task[]; onChanged: () => void; onOpen: () => void; emptyText?: string }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>) =>
    action()
      .then(() => setError(null))
      .catch((err: unknown) => setError(`Couldn't save that: ${String(err)}`))
      .finally(props.onChanged);
  // Ticked ones leave the list (after the strike animation); the rest go by time of day.
  const open = props.tasks.filter((t) => !t.done);
  const now = useTaskClock(open);
  const sorted = byTimeOfDay(open, now);

  return (
    <>
      {open.length === 0 ? (
        props.emptyText ? (
        <p className="muted small">{props.emptyText}</p>
      ) : (
        <Empty text="Nothing on your list for today." more="Add one below, or plan ahead on the To-do page." />
      )
      ) : (
        <ul className="task-list compact">
          {sorted.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              compact
              vanish
              when={taskWhen(t, now)}
              onToggle={(done) => run(() => setTaskDone(t.id, done))}
              onColor={(color) => run(() => setTaskColor(t.id, color))}
            />
          ))}
        </ul>
      )}
      <form
        className="quick-add"
        onSubmit={(e) => {
          e.preventDefault();
          const name = title.trim();
          if (!name) return;
          void run(async () => {
            await createTask({ title: name, dueDate: today(), priority: "normal", repeatDays: 0, color: null });
            setTitle("");
          });
        }}
      >
        <label className="sr-only" htmlFor="dash-add-task">
          Add a task for today
        </label>
        <input
          id="dash-add-task"
          className="task-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add for today…"
          maxLength={200}
          autoComplete="off"
        />
        <button type="button" className="link-button" onClick={props.onOpen}>
          All tasks
        </button>
      </form>
      {error && <p className="error small" role="alert">{error}</p>}
    </>
  );
}

function useRemainingOrZero(snap: TimerSnapshot | null): number {
  return useRemaining(snap ?? IDLE);
}

const IDLE: TimerSnapshot = {
  status: "idle", phase: "focus", session: 1, sessions: 0, durationMs: 0, remainingMs: 0,
  endsAtMs: null, presetId: null, presetName: null,
};

export function Loaded<T>(props: { state: Loadable<T>; onRetry?: () => void; children: (value: T) => React.ReactNode }) {
  if (props.state.kind === "loading") return <p className="muted">Loading…</p>;
  if (props.state.kind === "error") {
    return (
      <p className="error small" role="alert">
        Couldn't load this.{" "}
        {props.onRetry && (
          <button type="button" className="link-button" onClick={props.onRetry}>
            Try again
          </button>
        )}
      </p>
    );
  }
  return <>{props.children(props.state.value)}</>;
}

export function Empty(props: { text: string; more: string }) {
  return (
    <div className="empty">
      <p>{props.text}</p>
      <p className="muted small">{props.more}</p>
    </div>
  );
}

/** Programs with their time, as small horizontal bars. Shared with the History page. */
export function AppBars(props: { apps: AppTime[] }) {
  const max = Math.max(...props.apps.map((a) => a.seconds), 1);
  return (
    <ul className="app-bars">
      {props.apps.map((a) => (
        <li key={a.name}>
          <span className="app-name">{a.name}</span>
          <span className="app-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(2, Math.round((a.seconds / max) * 100))}%` }} />
          </span>
          <span className="num app-time">{formatDurationShort(a.seconds)}</span>
        </li>
      ))}
    </ul>
  );
}
