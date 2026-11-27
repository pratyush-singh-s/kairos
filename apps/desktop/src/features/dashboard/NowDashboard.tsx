import { useState } from "react";
import { formatClock, formatDurationShort } from "@focus/core";
import type { Preset } from "../../ipc/database";
import type { Dashboard } from "../../ipc/dashboard";
import { browserNames, type BrowserLink } from "../../ipc/browserLink";
import { getDayPlan } from "../../ipc/dayPlan";
import { goalStatus } from "../../ipc/goal";
import { useHistoryChanged } from "../../ipc/history";
import { OPEN_NOTE_KEY } from "../../ipc/notes";
import {
  ENDLESS_FOCUS_S,
  PHASE_LABEL,
  continueTimer,
  isActive,
  isEndless,
  pauseTimer,
  resumeTimer,
  sessionCount,
  startTimer,
  stopTimer,
  type TimerSnapshot,
} from "../../ipc/timer";
import type { RouteId } from "../../app/routes";
import { useCommand, type Loadable } from "../../useCommand";
import { useRemaining, useTimer } from "../timer/useTimer";
import { showTimerTab } from "../clock/ClockPage";
import { Card } from "../../components/Card";
import { DayPlanCard } from "../plan/DayPlanCard";
import { TodayEvents } from "../calendar/TodayEvents";
import { GoalDialog, GoalLine } from "../goal/GoalLine";
import { AsciiBar, useAscii } from "../../components/Ascii";
import { AppBars, Empty, Loaded, TodayTasks, UpcomingDeadlines } from "./DashboardPage";
import { UsageDonut } from "./UsageDonut";
import { openable } from "./openable";
import { Greeting } from "./Greeting";
import { Num } from "../../components/Num";

function hm(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}m`;
}

/** "25 min", or "no limit" for an endless preset. */
function presetLength(p: Preset): string {
  return p.focusS >= ENDLESS_FOCUS_S ? "no limit" : `${Math.round(p.focusS / 60)} min`;
}

/**
 * The newer dashboard (Settings → Appearance → New layout): what to do now along the top, today's
 * list on the left, what is coming on the right, and the rest folded into one line at the bottom.
 */
export function NowDashboard(props: {
  dash: Loadable<Dashboard>;
  reload: () => void;
  presets: Loadable<Preset[]>;
  link: Loadable<BrowserLink>;
  onNavigate: (id: RouteId) => void;
}) {
  const { dash, reload } = props;
  const openTimer = () => {
    showTimerTab("focus");
    props.onNavigate("timer");
  };

  return (
    <section aria-labelledby="dash-title" className="now-dash">
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

      <Card title="Now" className="now-band">
        <NowControls presets={props.presets} onOpenTimer={openTimer} />
        <TodayNumbers dash={dash} onHistory={() => props.onNavigate("history")} />
      </Card>

      <div className="now-cols">
        <Card title="Today" className="now-today">
          <h3 className="now-sub">Top three</h3>
          <DayPlanCard onOpenTasks={() => props.onNavigate("tasks")} />
          <h3 className="now-sub">Other tasks</h3>
          <Loaded state={dash}>
            {(d) => <OtherTasks tasks={d.todayTasks} onChanged={reload} onOpen={() => props.onNavigate("tasks")} />}
          </Loaded>
          <h3 className="now-sub">Calendar</h3>
          <TodayEvents onOpen={() => props.onNavigate("calendar")} />
        </Card>

        <div className="now-side-col">
        <Card title="Coming up" className="now-side">
          <h3 className="now-sub">Deadlines</h3>
          <Loaded state={dash}>
            {(d) =>
              d.upcomingDeadlines.length === 0 ? (
                <Empty text="No upcoming deadlines." more="Add one on the Deadlines page." />
              ) : (
                <UpcomingDeadlines deadlines={d.upcomingDeadlines} onOpen={() => props.onNavigate("deadlines")} />
              )
            }
          </Loaded>
          <h3 className="now-sub">Pinned notes</h3>
          <Loaded state={dash}>
            {(d) =>
              d.pinnedNotes.length === 0 ? (
                <p className="muted small">No pinned notes. Pin one on the Notes page to keep it here.</p>
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
        <ScreenTime dash={dash} onSettings={() => props.onNavigate("settings")} onHistory={() => props.onNavigate("history")} />
        </div>
      </div>

      <MoreLine dash={dash} link={props.link} />
    </section>
  );
}

/** Idle: one big Start for the first preset, the others beside it. Running: the clock with Pause and Stop. */
function NowControls(props: { presets: Loadable<Preset[]>; onOpenTimer: () => void }) {
  const [timer, setTimer] = useTimer();
  const snap = timer.kind === "ready" ? timer.value : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = (call: () => Promise<TimerSnapshot>) => {
    setBusy(true);
    call()
      .then((s) => {
        setTimer(s);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  if (snap && isActive(snap)) {
    return (
      <div className="now-controls" data-running="true">
        <RunningClock snap={snap} />
        <div className="now-actions">
          {snap.status === "running" && (
            <button type="button" className="button primary big" disabled={busy} onClick={() => act(pauseTimer)}>
              Pause
            </button>
          )}
          {snap.status === "paused" && (
            <button type="button" className="button primary big" disabled={busy} onClick={() => act(resumeTimer)}>
              Resume
            </button>
          )}
          {snap.status === "waiting" && (
            <button type="button" className="button primary big" disabled={busy} onClick={() => act(continueTimer)}>
              Start {PHASE_LABEL[snap.phase].toLowerCase()}
            </button>
          )}
          <button type="button" className="button big" disabled={busy} onClick={() => act(stopTimer)}>
            Stop
          </button>
          <button type="button" className="link-button small" onClick={props.onOpenTimer}>
            Open timer
          </button>
        </div>
        {error && <p className="error small" role="alert">Could not change the timer: {error}</p>}
      </div>
    );
  }

  if (props.presets.kind === "loading") return <div className="now-controls"><p className="muted">Loading…</p></div>;
  if (props.presets.kind === "error") {
    return (
      <div className="now-controls">
        <p className="error">Could not read presets: {props.presets.message}</p>
      </div>
    );
  }
  const [first, ...others] = props.presets.value;
  if (!first) {
    return (
      <div className="now-controls">
        <p className="muted">No presets yet.</p>
        <button type="button" className="button primary" onClick={props.onOpenTimer}>
          Make one on the timer page
        </button>
      </div>
    );
  }

  return (
    <div className="now-controls">
      <button type="button" className="button primary now-start" disabled={busy} onClick={() => act(() => startTimer(first.id))}>
        <span className="now-start-verb">Start</span>
        <span className="now-start-what">
          {first.name} · {presetLength(first)}
        </span>
      </button>
      {others.length > 0 && (
        <ul className="now-presets" aria-label="Other presets">
          {others.map((p) => (
            <li key={p.id}>
              <button type="button" className="button" disabled={busy} onClick={() => act(() => startTimer(p.id))} aria-label={`Start ${p.name} ${presetLength(p)}`}>
                {p.name} <span className="muted">{presetLength(p)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error small" role="alert">Could not start: {error}</p>}
    </div>
  );
}

function RunningClock(props: { snap: TimerSnapshot }) {
  const { snap } = props;
  const remaining = useRemaining(snap);
  const endless = isEndless(snap);
  return (
    <p className="now-clock">
      <span className="big-number" role="timer" aria-live="off">
        {formatClock(endless ? (snap.durationMs - remaining) / 1000 : Math.ceil(remaining / 1000))}
      </span>
      <span className="muted">
        {PHASE_LABEL[snap.phase]}
        {snap.status === "paused" ? " · paused" : snap.status === "waiting" ? " · ready to start" : ""}
        {endless ? " · endless" : ` · session ${sessionCount(snap)}`}
        {snap.presetName ? ` · ${snap.presetName}` : ""}
      </span>
    </p>
  );
}

/** Today's focus time, the goal and the streak, on the right of the Now band. */
function TodayNumbers(props: { dash: Loadable<Dashboard>; onHistory: () => void }) {
  const ascii = useAscii();
  const [goal, reloadGoal] = useCommand(goalStatus, 60_000);
  useHistoryChanged(reloadGoal);
  useHistoryChanged(reloadGoal, "sync-changed");
  const d = props.dash.kind === "ready" ? props.dash.value : null;
  const g = goal.kind === "ready" ? goal.value : null;
  const pct = g && g.goalMin > 0 ? Math.min(100, Math.round((g.todayMin / g.goalMin) * 100)) : 0;
  const [editing, setEditing] = useState(false);

  return (
    <>
    {editing && g && (
      <GoalDialog
        goal={g}
        onDone={() => {
          setEditing(false);
          reloadGoal();
        }}
      />
    )}
    <dl className="now-numbers">
      <div className="now-stat now-stat-main">
        <dt>Focused today</dt>
        <dd className="num"><Num>{d ? formatDurationShort(d.today.focusSeconds) : "–"}</Num></dd>
        {d && (
          <dd className="muted small">
            {d.today.completedSessions} done · {d.today.interruptedSessions} cut short
          </dd>
        )}
      </div>
      <div className="now-stat" {...openable(props.onHistory, `PC on today ${d ? formatDurationShort(d.pcOnToday ?? 0) : ""}. Open History`)}>
        <dt>PC on today</dt>
        <dd className="num"><Num>{d ? formatDurationShort(d.pcOnToday ?? 0) : "–"}</Num></dd>
      </div>
      {g && g.goalMin > 0 ? (
        <>
          <div className="now-stat now-stat-tap" {...openable(() => setEditing(true), `Goal ${hm(g.todayMin)} of ${hm(g.goalMin)}. Change goal`)}>
            <dt>Goal</dt>
            <dd className="num">
              <Num>{`${hm(g.todayMin)} / ${hm(g.goalMin)}`}</Num>
            </dd>
            <dd>
              {ascii ? (
                <span className="goal-bar-ascii" data-reached={g.todayMin >= g.goalMin} role="progressbar" aria-valuemin={0} aria-valuemax={g.goalMin} aria-valuenow={g.todayMin} aria-label="Today's focus goal">
                  <AsciiBar fraction={pct / 100} width={14} />
                </span>
              ) : (
              <span className="goal-bar now-goal-bar" data-reached={g.todayMin >= g.goalMin} role="progressbar" aria-valuemin={0} aria-valuemax={g.goalMin} aria-valuenow={g.todayMin} aria-label="Today's focus goal">
                <span style={{ width: `${pct}%` }} />
              </span>
              )}
            </dd>
          </div>
          <div className="now-stat">
            <dt>Streak</dt>
            <dd className="num">
              <Num>{`${g.streak} day${g.streak === 1 ? "" : "s"}`}</Num>
            </dd>
            <dd className="muted small">best {g.bestStreak}</dd>
          </div>
        </>
      ) : (
        // No goal yet (or it could not be read): the goal line offers to set one, or says what went wrong.
        <div className="now-stat now-stat-goal">
          <dt>Goal</dt>
          <dd>
            <GoalLine />
          </dd>
        </div>
      )}
    </dl>
    </>
  );
}

/** Today's tasks that are not already in the top three. */
function OtherTasks(props: { tasks: Dashboard["todayTasks"]; onChanged: () => void; onOpen: () => void }) {
  const [plan, reloadPlan] = useCommand(getDayPlan, 60_000);
  useHistoryChanged(reloadPlan, "plan-changed");
  useHistoryChanged(reloadPlan, "tasks-changed");
  const top = new Set(plan.kind === "ready" ? plan.value.plan.top : []);
  const rest = props.tasks.filter((t) => !top.has(t.id));
  return (
    <TodayTasks
      tasks={rest}
      onChanged={props.onChanged}
      onOpen={props.onOpen}
      emptyText={
        rest.some((t) => t.done)
          ? "All done for today."
          : props.tasks.length > 0
            ? "Everything for today is in your top three."
            : undefined
      }
    />
  );
}

/** Today's time per program as a ring (App tracking must be on). */
function ScreenTime(props: { dash: Loadable<Dashboard>; onSettings: () => void; onHistory: () => void }) {
  const ascii = useAscii();
  return (
    <Card title="Screen time" className="now-usage">
      <Loaded state={props.dash}>
        {(d) =>
          d.todayApps.length === 0 ? (
            <p className="muted small">
              Nothing yet.{" "}
              <button type="button" className="link-button" onClick={props.onSettings}>
                Turn on App tracking
              </button>
            </p>
          ) : ascii ? (
            <AppBars apps={d.todayApps.slice(0, 5)} />
          ) : (
            <UsageDonut apps={d.todayApps} onOpen={props.onHistory} />
          )
        }
      </Loaded>
    </Card>
  );
}

/** App activity and the browser link, folded into one line until opened. */
function MoreLine(props: { dash: Loadable<Dashboard>; link: Loadable<BrowserLink> }) {
  const apps = props.dash.kind === "ready" ? props.dash.value.todayApps : [];
  const l = props.link.kind === "ready" ? props.link.value : null;
  const top = apps[0];
  const browser = !l ? "browser link unknown" : !l.listening ? "browser link port busy" : l.linked ? (l.blocking ? `${browserNames(l)} blocking on` : `${browserNames(l)} linked`) : "browser not linked";

  return (
    <details className="now-more">
      <summary>
        <span>{top ? `Most used: ${top.name} ${formatDurationShort(top.seconds)}` : "No app activity recorded"}</span>
        <span aria-hidden="true"> · </span>
        <span data-ok={l?.linked || undefined}>{browser}</span>
      </summary>
      <div className="now-more-body">
        <div>
          <h3 className="now-sub">Today's activity</h3>
          {apps.length === 0 ? <p className="muted small">Turn on App tracking in Settings.</p> : <AppBars apps={apps.slice(0, 5)} />}
        </div>
        <div>
          <h3 className="now-sub">Browser blocking</h3>
          <p className="muted small">
            {!l
              ? "Checking the browser link…"
              : !l.listening
                ? "Another program is using the link's port (47811). Close it and restart Kairos."
                : l.linked
                  ? l.blocking
                    ? "Your browser is blocking your listed sites until this focus phase ends."
                    : "Blocking turns on in your browser when a focus phase starts."
                  : "Open Firefox or Zen with Kairos Blocker 0.10 or later to link it."}
          </p>
        </div>
      </div>
    </details>
  );
}
