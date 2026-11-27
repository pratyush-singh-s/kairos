import { useState, type FormEvent } from "react";
import { isoDate } from "@focus/core";
import type { CellShape, Deadline, DeadlineInput, ProgressStyle, Viz } from "../../ipc/deadlines";
import { ColorDot } from "../tasks/ColorDot";

const pad = (n: number) => String(n).padStart(2, "0");
const timeOf = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** Local date + "HH:MM" to UTC milliseconds. */
const toMs = (date: string, time: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y!, m! - 1, d!, h!, mi!).getTime();
};

const VIZ: [Viz, string][] = [["both", "Ring + days"], ["ring", "Ring"], ["grid", "Days"]];
const STYLES: [ProgressStyle, string][] = [["grid", "Grid"], ["bars", "Bars"]];
const SHAPES: [CellShape, string][] = [["rounded", "Rounded square"], ["circle", "Circle"], ["square", "Square"]];

/** 17:00 today, or the next whole hour once 17:00 has passed (so a new deadline due today is still in the future). */
function defaultDueTime(): string {
  const now = new Date();
  if (now.getHours() < 17) return "17:00";
  return now.getHours() >= 23 ? "23:59" : `${String(now.getHours() + 1).padStart(2, "0")}:00`;
}

/** New or edit. "All day" means due at 23:59 on the due date. Start left as "now" unless changed. */
export function DeadlineForm(props: { deadline?: Deadline; onSave: (input: DeadlineInput) => Promise<void>; onCancel: () => void }) {
  const d = props.deadline;
  const today = isoDate(new Date());
  const [title, setTitle] = useState(d?.title ?? "");
  const [description, setDescription] = useState(d?.description ?? "");
  const [dueDate, setDueDate] = useState(d ? isoDate(new Date(d.dueAt)) : today);
  const [allDay, setAllDay] = useState(d?.allDay ?? true);
  const [dueTime, setDueTime] = useState(d && !d.allDay ? timeOf(d.dueAt) : defaultDueTime());
  const [customStart, setCustomStart] = useState(!!d);
  const [startDate, setStartDate] = useState(d ? isoDate(new Date(d.startAt)) : today);
  const [startTime, setStartTime] = useState(d ? timeOf(d.startAt) : timeOf(Date.now()));
  const [viz, setViz] = useState<Viz>(d?.viz ?? "both");
  const [color, setColor] = useState<string | null>(d?.color ?? null);
  const [progressStyle, setProgressStyle] = useState<ProgressStyle>(d?.progressStyle ?? "grid");
  const [cellShape, setCellShape] = useState<CellShape>(d?.cellShape ?? "rounded");
  /** "" = automatic. */
  const [cols, setCols] = useState(d?.gridCols ? String(d.gridCols) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const dueAt = toMs(dueDate, allDay ? "23:59" : dueTime);
    const startAt = customStart ? toMs(startDate, startTime) : null;
    if (dueAt <= (startAt ?? Date.now())) {
      setError(customStart ? "The due time must be after the start time." : "The due time must be in the future.");
      return;
    }
    const gridCols = cols.trim() ? Number(cols) : null;
    if (gridCols !== null && !(Number.isInteger(gridCols) && gridCols >= 1 && gridCols <= 60)) {
      setError("Columns must be a whole number from 1 to 60, or empty for automatic.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ title, description, startAt, dueAt, allDay, viz, color, progressStyle, cellShape, gridCols });
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  return (
    <form className="deadline-form" onSubmit={submit} aria-label={d ? `Edit ${d.title}` : "New deadline"}>
      <div className="task-form-main wide">
        <ColorDot color={color} label={d ? d.title : "the new deadline"} onChange={setColor} />
        <label className="sr-only" htmlFor="dl-title">
          Name
        </label>
        <input
          id="dl-title"
          className="task-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What must be finished? e.g. Physics project"
          maxLength={200}
          required
          autoFocus
          autoComplete="off"
        />
      </div>

      <fieldset className="dl-when">
        <legend>Due</legend>
        <input type="date" aria-label="Due date" value={dueDate} onChange={(e) => e.target.value && setDueDate(e.target.value)} required />
        {!allDay && <input type="time" aria-label="Due time" value={dueTime} onChange={(e) => e.target.value && setDueTime(e.target.value)} />}
        <label className="check">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          End of the day
        </label>
      </fieldset>

      <fieldset className="dl-when">
        <legend>Starts</legend>
        {customStart ? (
          <>
            <input type="date" aria-label="Start date" value={startDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} />
            <input type="time" aria-label="Start time" value={startTime} onChange={(e) => e.target.value && setStartTime(e.target.value)} />
            {!d && (
              <button type="button" className="link-button small" onClick={() => setCustomStart(false)}>
                Start now instead
              </button>
            )}
          </>
        ) : (
          <>
            <span className="muted">Now</span>
            <button type="button" className="link-button small" onClick={() => setCustomStart(true)}>
              Pick a start
            </button>
          </>
        )}
      </fieldset>

      <fieldset className="dl-viz wide">
        <legend>Show</legend>
        {VIZ.map(([value, label]) => (
          <label key={value} className="day-toggle">
            <input type="radio" name="dl-viz" checked={viz === value} onChange={() => setViz(value)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      {viz !== "ring" && (
        <div className="dl-look wide">
          <fieldset className="dl-viz">
            <legend>Days as</legend>
            {STYLES.map(([value, label]) => (
              <label key={value} className="day-toggle">
                <input type="radio" name="dl-style" checked={progressStyle === value} onChange={() => setProgressStyle(value)} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="dl-viz">
            <legend>Shape</legend>
            {SHAPES.map(([value, label]) => (
              <label key={value} className="day-toggle">
                <input type="radio" name="dl-shape" checked={cellShape === value} onChange={() => setCellShape(value)} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label className="dl-cols">
            <span>Per row</span>
            <input
              className="length-input"
              inputMode="numeric"
              value={cols}
              onChange={(e) => setCols(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
              placeholder="Auto"
              aria-label="Days per row, empty for automatic"
            />
            <span className="muted small">The colour marks this deadline.</span>
          </label>
        </div>
      )}

      <label className="field wide">
        <span>Notes (optional)</span>
        <textarea rows={2} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
      </label>

      {error && (
        <p className="error wide" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions wide">
        <button type="submit" className="button primary" disabled={busy || !title.trim()}>
          {d ? "Save changes" : "Add deadline"}
        </button>
        <button type="button" className="button" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
