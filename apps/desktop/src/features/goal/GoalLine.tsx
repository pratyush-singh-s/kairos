import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Glyph } from "../../components/Icon";
import { AsciiBar, asciiColumn, useAscii } from "../../components/Ascii";
import { goalStatus, setDailyGoal, type GoalStatus } from "../../ipc/goal";
import { useHistoryChanged } from "../../ipc/history";
import { useUi } from "../../theme/UiProvider";
import { useCommand } from "../../useCommand";

const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "narrow" });

function hm(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}m`;
}

/** Today's progress towards the daily focus goal, the streak, and the last 7 days. */
export function GoalLine() {
  const [goal, reload] = useCommand(goalStatus, 60_000);
  useHistoryChanged(reload);
  useHistoryChanged(reload, "sync-changed");
  const [editing, setEditing] = useState(false);
  const { theme } = useUi();
  const ascii = useAscii();

  if (goal.kind === "error") return <p className="error small" role="alert">Could not read your goal: {goal.message}</p>;
  if (goal.kind !== "ready") return <p className="muted small">Loading…</p>;
  const g = goal.value;

  if (editing) return <GoalForm goal={g} onDone={() => { setEditing(false); reload(); }} />;
  if (g.goalMin === 0) {
    return (
      <p className="muted small goal-line">
        No daily goal.{" "}
        <button type="button" className="link-button" onClick={() => setEditing(true)}>
          Set one
        </button>
      </p>
    );
  }

  const pct = Math.min(100, Math.round((g.todayMin / g.goalMin) * 100));
  const reached = g.todayMin >= g.goalMin;
  const max = Math.max(g.goalMin, ...g.week);
  const days = g.week.map((_, i) => DAY.format(new Date(Date.now() - (6 - i) * 86_400_000)));

  return (
    <div className="goal-line" data-reached={reached}>
      {theme === "terminal" ? (
        <dl className="kv">
          <dt>goal</dt>
          <dd className="num">
            {hm(g.todayMin)} / {hm(g.goalMin)} ({pct}%)
          </dd>
          <dt>streak</dt>
          <dd className="num">
            {g.streak}d (best {g.bestStreak}d)
          </dd>
        </dl>
      ) : (
        <p className="goal-text">
          <span>
            {hm(g.todayMin)} of {hm(g.goalMin)} goal{reached ? " ✓" : ""}
          </span>
          <span className="goal-streak" title={`Best: ${g.bestStreak} days`}>
            <Glyph name="flame" className="goal-flame" /> {g.streak} day{g.streak === 1 ? "" : "s"}
          </span>
        </p>
      )}
      {ascii ? (
        <div className="goal-bar-ascii" role="progressbar" aria-valuemin={0} aria-valuemax={g.goalMin} aria-valuenow={g.todayMin} aria-label="Today's focus goal">
          <AsciiBar fraction={pct / 100} width={24} />
        </div>
      ) : (
      <div className="goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={g.goalMin} aria-valuenow={g.todayMin} aria-label="Today's focus goal">
        <span style={{ width: `${pct}%` }} />
      </div>
      )}
      <div className="goal-week" role="img" aria-label={`Focus on the last 7 days: ${g.week.map((m, i) => `${days[i]} ${hm(m)}`).join(", ")}`}>
        {g.week.map((m, i) => (
          <span key={i} className="goal-day" data-met={m >= g.goalMin} title={`${hm(m)}`}>
            {ascii ? (
              <span className="goal-day-ascii" aria-hidden="true">{asciiColumn(Math.max(0.04, m / max), 3).join("\n")}</span>
            ) : (
              <span className="goal-day-bar" style={{ height: `${Math.max(4, Math.round((m / max) * 100))}%` }} />
            )}
            <span className="goal-day-name">{days[i]}</span>
          </span>
        ))}
      </div>
      <button type="button" className="link-button small" onClick={() => setEditing(true)}>
        Change goal
      </button>
    </div>
  );
}

function GoalForm(props: { goal: GoalStatus; onDone: () => void }) {
  const [hours, setHours] = useState(String(Math.floor(props.goal.goalMin / 60)));
  const [mins, setMins] = useState(String(props.goal.goalMin % 60));
  const [error, setError] = useState<string | null>(null);

  async function save(minutes: number) {
    try {
      await setDailyGoal(minutes);
      props.onDone();
    } catch (err) {
      setError(String(err));
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const total = Math.round(Number(hours || 0) * 60 + Number(mins || 0));
    if (Number.isNaN(total) || total < 0 || total > 1440) {
      setError("Enter up to 24 hours.");
      return;
    }
    void save(total);
  }

  return (
    <form className="goal-form" onSubmit={submit} aria-label="Daily focus goal">
      <label className="field">
        <span>Hours</span>
        <input type="number" min={0} max={24} value={hours} onChange={(e) => setHours(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Minutes</span>
        <input type="number" min={0} max={59} step={5} value={mins} onChange={(e) => setMins(e.target.value)} />
      </label>
      {error && <p className="error wide" role="alert">{error}</p>}
      <div className="form-actions wide">
        <button type="submit" className="button primary">Save goal</button>
        <button type="button" className="button" onClick={props.onDone}>Cancel</button>
        {props.goal.goalMin > 0 && (
          <button type="button" className="button push-right" onClick={() => void save(0)}>
            No goal
          </button>
        )}
      </div>
    </form>
  );
}

/** The goal form in a small dialog: the main dashboard's Goal box opens it when tapped. */
export function GoalDialog(props: { goal: GoalStatus; onDone: () => void }) {
  // On document.body: a blurred card would otherwise trap the backdrop inside itself.
  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={props.onDone}>
      <div className="modal card goal-dialog" role="dialog" aria-label="Daily focus goal" onClick={(e) => e.stopPropagation()}>
        <h2 className="card-title">Daily goal</h2>
        <GoalForm goal={props.goal} onDone={props.onDone} />
      </div>
    </div>,
    document.body,
  );
}
