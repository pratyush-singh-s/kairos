import { useState, type FormEvent } from "react";
import { EVERY_DAY, WEEKDAYS, WEEKENDS, WEEK_ORDER, addDays, minutesBetween, parseIsoDate, timeHint } from "@focus/core";
import { today, type Priority, type Task, type TaskInput } from "../../ipc/tasks";
import { ColorDot } from "./ColorDot";

type When = "none" | "today" | "tomorrow" | "date";
type Repeat = "none" | "daily" | "weekdays" | "weekends" | "custom";

const REPEAT_BITS: Record<Exclude<Repeat, "custom">, number> = { none: 0, daily: EVERY_DAY, weekdays: WEEKDAYS, weekends: WEEKENDS };

function repeatOf(bits: number): Repeat {
  const named = (Object.keys(REPEAT_BITS) as Exclude<Repeat, "custom">[]).find((k) => REPEAT_BITS[k] === bits);
  return named ?? "custom";
}

function whenOf(due: string | null): When {
  if (due === null) return "none";
  if (due === today()) return "today";
  if (due === addDays(today(), 1)) return "tomorrow";
  return "date";
}

/**
 * Add a task (title box with the options under it) or edit one in place.
 * After adding, the title clears and the due day stays, so several tasks for the same day go in quickly.
 */
export function TaskForm(props: {
  task?: Task;
  onSave: (input: TaskInput) => Promise<void>;
  onCancel?: () => void;
  /** Starting choice for a new task. */
  defaultWhen?: When;
  /** Starting date for a new task (with defaultWhen "date"). */
  defaultDate?: string;
  /** Extra buttons after Save/Cancel (e.g. Delete in the editor). */
  extra?: React.ReactNode;
  /** Show the description box (the board's editor); it gets the cursor when editing. */
  withDescription?: boolean;
  /** A step of a day-by-day plan: pick its day instead of a date or repeat. */
  plan?: { days: number; startDate: string | null; day: number | null };
}) {
  const t = props.task;
  const [title, setTitle] = useState(t?.title ?? "");
  const [when, setWhen] = useState<When>(t ? whenOf(t.dueDate) : (props.defaultWhen ?? "none"));
  const [date, setDate] = useState(t?.dueDate ?? props.defaultDate ?? addDays(today(), 2));
  const [repeat, setRepeat] = useState<Repeat>(repeatOf(t?.repeatDays ?? 0));
  const [days, setDays] = useState(t && t.repeatDays > 0 ? t.repeatDays : (1 << 1) | (1 << 3) | (1 << 5));
  const [priority, setPriority] = useState<Priority>(t?.priority ?? "normal");
  const [color, setColor] = useState<string | null>(t?.color ?? null);
  const [startTime, setStartTime] = useState(t?.startTime ?? "");
  const [endTime, setEndTime] = useState(t?.endTime ?? "");
  const [length, setLength] = useState(t?.durationMin ? lengthText(t.durationMin) : "");
  const [category, setCategory] = useState(t?.category ?? "");
  const [description, setDescription] = useState(t?.description ?? "");
  const [planDay, setPlanDay] = useState<number | null>(t ? t.planDay : (props.plan?.day ?? null));
  const plan = props.plan;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Times the user said are right ("Keep"), so their AM/PM hint stays hidden.
  const [keptTimes, setKeptTimes] = useState<string | null>(null);
  const hint = timeHint(startTime, endTime || null);
  const showHint = hint && keptTimes !== `${startTime}-${endTime}`;

  const repeatDays = plan ? 0 : repeat === "custom" ? days : REPEAT_BITS[repeat];
  const dueDate = plan ? null : repeatDays > 0 ? null : when === "today" ? today() : when === "tomorrow" ? addDays(today(), 1) : when === "date" ? date : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (repeat === "custom" && days === 0) {
      setError("Pick at least one day, or choose \"Doesn't repeat\".");
      return;
    }
    let durationMin = parseLength(length);
    if (durationMin === undefined) {
      setError("Write the length as minutes (45) or hours:minutes (1:30).");
      return;
    }
    if (durationMin === null && startTime && endTime) durationMin = minutesBetween(startTime, endTime) || null;
    setBusy(true);
    setError(null);
    try {
      await props.onSave({
        title,
        dueDate,
        priority,
        repeatDays,
        color,
        startTime: startTime || null,
        endTime: startTime && endTime ? endTime : null,
        durationMin,
        category: category.trim() || null,
        description,
        ...(plan ? { planDay } : {}),
      });
      if (!t) {
        // Ready for the next one: same due day, but repeat and priority back to plain.
        setTitle("");
        setRepeat("none");
        setPriority("normal");
        setColor(null);
        setStartTime("");
        setEndTime("");
        setLength("");
        setDescription("");
        setKeptTimes(null);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const id = t ? `edit-${t.id}` : "new-task";
  return (
    <form className="task-form" data-mode={t ? "edit" : "add"} onSubmit={submit} aria-label={t ? `Edit ${t.title}` : "Add a task"}>
      <div className="task-form-main">
        <ColorDot color={color} label={t ? t.title : "the new task"} onChange={setColor} />
        <label className="sr-only" htmlFor={`${id}-title`}>
          Task
        </label>
        <input
          id={`${id}-title`}
          className="task-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && props.onCancel?.()}
          placeholder={t ? undefined : "Add a task, e.g. gym"}
          maxLength={200}
          autoComplete="off"
        />
        <button type="submit" className="button primary" disabled={busy || !title.trim()}>
          {t ? "Save" : "Add"}
        </button>
        {props.onCancel && (
          <button type="button" className="button" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        {props.extra}
      </div>

      <div className="task-options">
        {plan && (
          <label className="task-option">
            <span>Day</span>
            <select value={planDay ?? ""} onChange={(e) => setPlanDay(e.target.value ? Number(e.target.value) : null)}>
              <option value="">No day yet</option>
              {Array.from({ length: plan.days }, (_, i) => (
                <option key={i} value={i + 1}>
                  {planDayLabel(i + 1, plan.startDate)}
                </option>
              ))}
            </select>
          </label>
        )}
        {!plan && (
        <label className="task-option">
          <span>Repeat</span>
          <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
            <option value="none">Doesn't repeat</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekends">Weekends</option>
            <option value="custom">Pick days…</option>
          </select>
        </label>
        )}
        {!plan && repeat === "none" && (
          <label className="task-option">
            <span>Due</span>
            <select value={when} onChange={(e) => setWhen(e.target.value as When)}>
              <option value="none">No date</option>
              <option value="today">Today</option>
              <option value="tomorrow">Tomorrow</option>
              <option value="date">Pick a date…</option>
            </select>
          </label>
        )}
        {!plan && repeat === "none" && when === "date" && (
          <label className="task-option">
            <span className="sr-only">Due date</span>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
        )}
        <label className="task-option">
          <span>Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label className="task-option">
          <span>Time</span>
          <input type="time" aria-label="Start time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </label>
        {startTime && (
          <label className="task-option">
            <span>to</span>
            <input type="time" aria-label="End time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </label>
        )}
        <label className="task-option">
          <span>Length</span>
          <input
            className="length-input"
            value={length}
            onChange={(e) => setLength(e.target.value)}
            placeholder={startTime && endTime ? lengthText(minutesBetween(startTime, endTime)) : "1:30"}
            aria-label="Length, minutes or hours:minutes"
          />
        </label>
        <label className="task-option">
          <span>Label</span>
          <input className="label-input" value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Website" />
        </label>
        {!plan && repeat === "custom" && (
          <fieldset className="day-picker">
            <legend className="sr-only">Repeat on</legend>
            {WEEK_ORDER.map(([bit, name]) => (
              <label key={bit} className="day-toggle">
                <input
                  type="checkbox"
                  checked={(days & (1 << bit)) !== 0}
                  onChange={(e) => setDays((d) => (e.target.checked ? d | (1 << bit) : d & ~(1 << bit)))}
                />
                <span>{name}</span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
      {showHint && (
        <p className="time-hint" role="status">
          <span>{hint.message}</span>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setStartTime(hint.fix.startTime);
              setEndTime(hint.fix.endTime ?? "");
            }}
          >
            Fix
          </button>
          <button type="button" className="button" onClick={() => setKeptTimes(`${startTime}-${endTime}`)}>
            Keep
          </button>
        </p>
      )}
      {props.withDescription && (
        <label className="task-desc">
          <span className="sr-only">Description</span>
          <textarea
            className="task-desc-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") props.onCancel?.();
              // Ctrl+Enter saves; plain Enter starts a new line.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit();
            }}
            placeholder="Add a description…"
            maxLength={5000}
            rows={5}
            autoFocus={!!t}
            // Start typing after what is already written.
            onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          />
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

const planDate = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "Day 3", or "Day 3 · Wed 29 Oct" when the plan has a start date. */
export function planDayLabel(day: number, startDate: string | null): string {
  return startDate ? `Day ${day} · ${planDate.format(parseIsoDate(addDays(startDate, day - 1)))}` : `Day ${day}`;
}

/** 90 → "1:30". */
function lengthText(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

/** "45" → 45, "1:30" → 90, "" → null, anything else → undefined. */
function parseLength(text: string): number | null | undefined {
  const v = text.trim().replace(/h$/i, "");
  if (!v) return null;
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(v);
  const n = hm ? Number(hm[1]) * 60 + Number(hm[2]) : /^\d{1,4}$/.test(v) ? Number(v) : NaN;
  return n >= 1 && n <= 1440 ? n : undefined;
}
