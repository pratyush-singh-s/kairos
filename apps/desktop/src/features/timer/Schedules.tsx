import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { timeOfDay } from "@focus/core";
import { WEEKDAYS, WEEK_ORDER } from "@focus/core";
import { Card } from "../../components/Card";
import { getSchedules, saveSchedules, type Schedule, type ScheduleKind } from "../../ipc/schedule";
import { useCommand } from "../../useCommand";

const CLOCK = { format: timeOfDay };

function daysText(days: number): string {
  if ((days & 127) === 127) return "Every day";
  if (days === WEEKDAYS) return "Weekdays";
  if (days === 65) return "Weekends";
  return WEEK_ORDER.filter(([bit]) => days & (1 << bit)).map(([, name]) => name).join(", ");
}

function newId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Scheduled focus: focus starts on its own at set times on every device (laptop timer, phone,
 * launcher and browsers). Stopping a scheduled session skips just that one window.
 */
export function Schedules(props: { title?: string; askKind?: boolean } = {}) {
  const [view, reload] = useCommand(getSchedules, 30_000);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [newKind, setNewKind] = useState<ScheduleKind>("focus");
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = view.kind === "ready" ? view.value.schedules : [];
  const current = view.kind === "ready" ? view.value.current : null;

  async function save(next: Schedule[]) {
    setError(null);
    try {
      await saveSchedules(next);
      setEditing(null);
      reload();
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }

  return (
    <Card title={props.title ?? "Scheduled focus"} className="schedules-card">
      {view.kind === "error" && <p className="error">Could not read schedules: {view.message}</p>}
      {current && (
        <p className="pill pill-ok schedule-now">
          <span aria-hidden="true">● </span>
          {current.kind === "block" ? "Blocking: " : ""}
          {current.name} until {CLOCK.format(new Date(current.endsAtMs))}
        </p>
      )}
      {list.length === 0 && editing === null && (
        <p className="muted small">Start focus automatically at set times.</p>
      )}
      <ul className="schedule-list">
        {list.map((s) => (
          <li key={s.id} className="schedule-row" data-off={!s.enabled}>
            <label className="check" title={s.enabled ? "On" : "Off"}>
              <input
                type="checkbox"
                checked={s.enabled}
                aria-label={`${s.name} on`}
                onChange={(e) => void save(list.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x))).catch(() => {})}
              />
            </label>
            <span className="schedule-text">
              <strong>{s.name}</strong>
              <span className="muted small">
                {props.askKind && (s.kind === "block" ? "Blocking only · " : "Focus · ")}
                {daysText(s.days)} · {s.start}–{s.end}
              </span>
            </span>
            <button type="button" className="button small" onClick={() => setEditing(s)}>
              Edit
            </button>
          </li>
        ))}
      </ul>
      {error && editing === null && <p className="error" role="alert">{error}</p>}
      {editing === null ? (
        <div className="form-actions">
          <button type="button" className="button" disabled={list.length >= 20} onClick={() => (props.askKind ? setChoosing(true) : (setNewKind("focus"), setEditing("new")))}>
            Add schedule
          </button>
        </div>
      ) : (
        <ScheduleForm
          key={editing === "new" ? "new" : editing.id}
          schedule={editing === "new" ? null : editing}
          kind={editing === "new" ? newKind : (editing.kind ?? "focus")}
          error={error}
          onCancel={() => {
            setEditing(null);
            setError(null);
          }}
          onSave={(s) => save(editing === "new" ? [...list, s] : list.map((x) => (x.id === s.id ? s : x)))}
          onDelete={editing === "new" ? undefined : () => save(list.filter((x) => x.id !== (editing as Schedule).id))}
        />
      )}
      {choosing && (
        <KindChoice
          onClose={() => setChoosing(false)}
          onPick={(k) => {
            setChoosing(false);
            setNewKind(k);
            setEditing("new");
          }}
        />
      )}
    </Card>
  );
}

const KINDS: [ScheduleKind, string, string][] = [
  ["focus", "Focus", "A focus session runs. Blocking is on."],
  ["block", "Blocking only", "Just blocks, no timer. For habits."],
];

/** "Which kind of schedule?": asked when one is added. */
function KindChoice(props: { onPick: (k: ScheduleKind) => void; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps
  // A portal: a card's blur would otherwise clip the dialog to the card.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal card note-kind-modal" role="dialog" aria-modal="true" aria-label="Which kind of schedule?">
        <h2 className="card-title">
          <span className="card-title-text">Which kind of schedule?</span>
        </h2>
        <div className="note-kind-choices">
          {KINDS.map(([kind, name, note], i) => (
            <button key={kind} type="button" className="space-family note-kind" autoFocus={i === 0} onClick={() => props.onPick(kind)}>
              <strong>{name}</strong>
              <span className="hint">{note}</span>
            </button>
          ))}
        </div>
        <div className="note-kind-foot">
          <button type="button" className="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ScheduleForm(props: {
  schedule: Schedule | null;
  kind: ScheduleKind;
  error: string | null;
  onSave: (s: Schedule) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel: () => void;
}) {
  const s = props.schedule;
  const [kind, setKind] = useState<ScheduleKind>(props.kind);
  const [name, setName] = useState(s?.name ?? (props.kind === "block" ? "No distractions" : "Focus time"));
  const [days, setDays] = useState(s?.days ?? WEEKDAYS);
  const [start, setStart] = useState(s?.start ?? "09:00");
  const [end, setEnd] = useState(s?.end ?? "12:00");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(() => props.onSave({ id: s?.id ?? newId(), name, days, start, end, enabled: s?.enabled ?? true, kind }));
  }

  return (
    <form className="preset-form" onSubmit={submit} aria-label={s ? `Edit ${s.name}` : "New schedule"}>
      <label className="field wide">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
      </label>
      {s && (
        <label className="field wide">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind)}>
            <option value="focus">Focus</option>
            <option value="block">Blocking only</option>
          </select>
        </label>
      )}
      <fieldset className="day-picker wide">
        <legend className="sr-only">Days</legend>
        {WEEK_ORDER.map(([bit, label]) => (
          <label key={bit} className="day-toggle">
            <input type="checkbox" checked={(days & (1 << bit)) !== 0} onChange={(e) => setDays((d) => (e.target.checked ? d | (1 << bit) : d & ~(1 << bit)))} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>Starts</span>
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
      </label>
      <label className="field">
        <span>Ends</span>
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
        {end <= start && <span className="hint">ends the next day</span>}
      </label>
      {props.error && (
        <p className="error wide" role="alert">
          {props.error}
        </p>
      )}
      <div className="form-actions wide">
        <button type="submit" className="button primary" disabled={busy || days === 0}>
          {s ? "Save changes" : "Add schedule"}
        </button>
        <button type="button" className="button" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        {props.onDelete &&
          (confirmDelete ? (
            <span className="confirm">
              Delete "{s?.name}"?{" "}
              <button type="button" className="button danger" onClick={() => void run(props.onDelete!)} disabled={busy}>
                Yes, delete
              </button>
            </span>
          ) : (
            <button type="button" className="button danger push-right" onClick={() => setConfirmDelete(true)} disabled={busy}>
              Delete
            </button>
          ))}
      </div>
    </form>
  );
}
