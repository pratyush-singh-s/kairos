import { useState, type FormEvent } from "react";
import { holdsTasks, type Space, type SpaceInput, type SpaceKind } from "../../ipc/spaces";
import { today } from "../../ipc/tasks";
import { ColorDot } from "./ColorDot";

/** The first choice when making a space. */
type Family = "calendar" | "free" | "case";

const FAMILIES: [Family, string, string][] = [
  ["calendar", "Calendar", "Tasks on days: a week board or a day-by-day plan."],
  ["free", "Free space", "Lists of cards you move around as you like, with no dates needed."],
  ["case", "Detective board", "Pin cards, notes and sticky notes anywhere and tie them together with string."],
];

const CALENDAR_KINDS: [SpaceKind, string, string][] = [
  ["board", "Week board", "Days of the week with tasks, like Everyday. For another part of your life, e.g. College."],
  ["plan", "Day-by-day plan", "Day 1, Day 2, Day 3 … with steps on each, e.g. Day 1 write the code, Day 2 debugging."],
];

const familyOf = (kind: SpaceKind): Family => (kind === "free" || kind === "case" ? kind : "calendar");

const PLACEHOLDERS: Record<SpaceKind, string> = {
  board: "Name, e.g. College",
  plan: "Name, e.g. Focus app v2",
  free: "Name, e.g. App ideas",
  case: "Name, e.g. Why is sync slow?",
};

/** A small drawing of each kind, so the choice reads at a glance. */
function FamilyPicture(props: { family: Family }) {
  if (props.family === "calendar")
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <rect x="1" y="1" width="46" height="30" rx="3" fill="none" stroke="currentColor" strokeOpacity=".5" />
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={1 + i * 9.2} y1="1" x2={1 + i * 9.2} y2="31" stroke="currentColor" strokeOpacity=".25" />
            <rect x={3 + i * 9.2} y={6 + (i % 3) * 5} width="6" height="4" rx="1" fill="currentColor" fillOpacity=".7" />
          </g>
        ))}
      </svg>
    );
  if (props.family === "free")
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <rect x={2 + i * 15.5} y="2" width="13" height="28" rx="2.5" fill="currentColor" fillOpacity=".14" />
            {Array.from({ length: 3 - (i % 2) }, (_, j) => (
              <rect key={j} x={4 + i * 15.5} y={5 + j * 7} width="9" height="5" rx="1.2" fill="currentColor" fillOpacity=".7" />
            ))}
          </g>
        ))}
      </svg>
    );
  return (
    <svg viewBox="0 0 48 32" aria-hidden="true">
      <path d="M10 8 L25 6 L38 14 M25 6 L20 24" stroke="#d64545" strokeWidth="1.2" fill="none" />
      {(
        [
          [6, 6],
          [21, 4],
          [34, 12],
          [16, 22],
        ] as const
      ).map(([x, y], i) => (
        <g key={i}>
          <rect x={x} y={y} width="8" height="9" rx="0.8" fill="currentColor" fillOpacity=".8" />
          <circle cx={x + 4} cy={y + 0.6} r="1.6" fill="#d64545" />
        </g>
      ))}
      <rect x="36" y="22" width="9" height="8" fill="#f2d16b" transform="rotate(-6 40 26)" />
    </svg>
  );
}

/** Make a space, or rename, recolour, resize or delete one. */
export function SpaceForm(props: {
  space: Space | null;
  onSave: (input: SpaceInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
  /** Tasks in the space (for the delete warning). */
  stepCount: number;
}) {
  const s = props.space;
  const [name, setName] = useState(s?.name ?? "");
  const [kind, setKind] = useState<SpaceKind>(s?.kind ?? "plan");
  const [color, setColor] = useState<string | null>(s?.color ?? null);
  const [days, setDays] = useState(String(s?.days ?? 7));
  const [dated, setDated] = useState(s ? s.startDate !== null : true);
  const [startDate, setStartDate] = useState(s?.startDate ?? today());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(days);
    if (kind === "plan" && !(Number.isInteger(n) && n >= 1 && n <= 365)) {
      setError("A plan has between 1 and 365 days.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ name, kind, color, startDate: kind === "plan" && dated ? startDate : null, days: kind === "plan" ? n : 7 });
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  return (
    <form className="deadline-form space-form" onSubmit={submit} aria-label={s ? `Edit ${s.name}` : "New space"}>
      {!s && (
        <div className="space-family-choices wide" role="radiogroup" aria-label="What kind of space">
          {FAMILIES.map(([id, label, note]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={familyOf(kind) === id}
              className="space-family"
              data-family={id}
              onClick={() => setKind(id === "calendar" ? (familyOf(kind) === "calendar" ? kind : "plan") : id)}
            >
              <FamilyPicture family={id} />
              <strong>{label}</strong>
              <span className="hint">{note}</span>
            </button>
          ))}
        </div>
      )}

      <div className="task-form-main wide">
        <ColorDot color={color} label={s ? s.name : "the new space"} onChange={setColor} />
        <label className="sr-only" htmlFor="space-name">
          Name
        </label>
        <input
          id="space-name"
          className="task-title-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={PLACEHOLDERS[kind]}
          maxLength={60}
          required
          autoFocus
          autoComplete="off"
        />
      </div>

      {!s && familyOf(kind) === "calendar" && (
        <fieldset className="radio-group theme-choices wide">
          <legend>Calendar</legend>
          {CALENDAR_KINDS.map(([id, label, note]) => (
            <label key={id} className="theme-choice">
              <input type="radio" name="space-kind" checked={kind === id} onChange={() => setKind(id)} />
              <span>
                <strong>{label}</strong>
                <span className="hint">{note}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {kind === "plan" && (
        <>
          <label className="dl-cols">
            <span>Days</span>
            <input
              className="length-input"
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
              aria-label="Number of days"
            />
            <span className="muted small">You can add more later.</span>
          </label>
          <fieldset className="dl-when">
            <legend>Day 1 is</legend>
            {dated ? (
              <>
                <input type="date" aria-label="Date of Day 1" value={startDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} />
                <button type="button" className="link-button small" onClick={() => setDated(false)}>
                  No dates
                </button>
              </>
            ) : (
              <>
                <span className="muted">Not dated</span>
                <button type="button" className="link-button small" onClick={() => setDated(true)}>
                  Pick a date
                </button>
              </>
            )}
          </fieldset>
          <p className="muted small wide">
            With a date, each day's steps show on the dashboard.
          </p>
        </>
      )}

      {error && (
        <p className="error wide" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions wide">
        <button type="submit" className="button primary" disabled={busy || !name.trim()}>
          {s ? "Save changes" : "Make space"}
        </button>
        <button type="button" className="button" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        {props.onDelete &&
          (confirmDelete ? (
            <button type="button" className="button danger push-right" onClick={props.onDelete}>
              {holdsTasks(s!.kind)
                ? `Delete space and its ${props.stepCount} ${props.stepCount === 1 ? "task" : "tasks"}`
                : "Delete space and everything on it"}
            </button>
          ) : (
            <button type="button" className="button danger push-right" onClick={() => setConfirmDelete(true)}>
              Delete space
            </button>
          ))}
      </div>
    </form>
  );
}
