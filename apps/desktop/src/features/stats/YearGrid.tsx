import { useMemo } from "react";
import { formatDurationShort, heatLevel, type Period, type StatSession } from "@focus/core";

/** Terminal theme shades, empty to most. Empty days are a faint ░ so the grid reads as one block. */
export const TERMINAL_LEVELS = ["░", "░", "▒", "▓", "█"];

/** A run of the shade wide enough to fill its cell edge to edge (the cell clips the rest). */
export function shadeRun(level: number): string {
  return TERMINAL_LEVELS[level]!.repeat(12);
}
const shortMonth = new Intl.DateTimeFormat(undefined, { month: "short" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const fullDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** The days shown: the period's first to last day (a month or a calendar year). */
function rangeFor(period: Period): { first: Date; last: Date } {
  const start = new Date(period.startMs);
  const end = new Date(period.endMs - 1);
  return {
    first: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
    last: new Date(end.getFullYear(), end.getMonth(), end.getDate()),
  };
}

/**
 * A GitHub-style calendar of focus time for a month or a year: one column per week, weekdays
 * down the left, months along the top, each day shaded by how long you focused.
 */
export function YearGrid(props: { period: Period; sessions: StatSession[] | null; weekStart: number; terminal: boolean; now: number }) {
  const { first, last } = useMemo(() => rangeFor(props.period), [props.period]);
  const sessions = props.sessions;

  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions ?? []) {
      const k = dayKey(new Date(s.startedAt));
      m.set(k, (m.get(k) ?? 0) + s.actualS);
    }
    return m;
  }, [sessions]);

  // Columns start on the week's first day, so the first column may begin before `first`.
  const weeks = useMemo(() => {
    const start = addDays(first, -((first.getDay() - props.weekStart + 7) % 7));
    const out: Date[][] = [];
    for (let d = start; d <= last; d = addDays(d, 7)) out.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
    return out;
  }, [first, last, props.weekStart]);

  // A month's name sits over the first week that holds its 1st (and over the first column).
  const labels = useMemo(() => {
    let lastAt = -10;
    return weeks.map((days, i) => {
      const firstOfMonth = days.find((d) => d.getDate() === 1 && d >= first && d <= last);
      const day = i === 0 ? (firstOfMonth ?? (days.find((d) => d >= first) as Date)) : firstOfMonth;
      if (!day || i - lastAt < 3) return "";
      lastAt = i;
      return shortMonth.format(day);
    });
  }, [weeks, first, last]);

  const max = Math.max(...perDay.values(), 1);
  const total = [...perDay.values()].reduce((n, s) => n + s, 0);
  const days = [...perDay.values()].filter((s) => s > 0).length;
  const t = props.terminal;
  // A year fills the card; a month's five or six weeks keep GitHub-sized squares.
  const cols = { gridTemplateColumns: `36px repeat(${weeks.length}, ${props.period.kind === "year" ? "minmax(0, 1fr)" : "28px"})` };
  const span = props.period.kind === "year" ? String(first.getFullYear()) : monthYear.format(first);

  return (
    <div className="year-grid-wrap">
      <p className="muted small year-grid-sum">
        {sessions === null
          ? "Loading…"
          : total > 0
            ? `${formatDurationShort(total)} of focus on ${days} ${days === 1 ? "day" : "days"} in ${span}`
            : `No focus sessions in ${span} yet.`}
      </p>
      <div className="year-grid" data-info-zone role="table" aria-label="Focus time per day">
        <div className="year-row year-months" style={cols} aria-hidden="true">
          <span />
          {labels.map((l, i) => (
            <span key={i} className="year-month">
              {t ? l.toLowerCase() : l}
            </span>
          ))}
        </div>
        {Array.from({ length: 7 }, (_, r) => {
          const name = weekday.format(weeks[0]![r]!);
          return (
            <div key={r} className="year-row" style={cols} role="row">
              <span className="year-day" role="rowheader">
                {t ? name.toLowerCase() : name}
              </span>
              {weeks.map((w) => {
                const d = w[r]!;
                const out = d < first || d > last || d.getTime() > props.now;
                const v = perDay.get(dayKey(d)) ?? 0;
                const level = out ? 0 : heatLevel(v, max);
                const label = `${fullDay.format(d)}: ${v > 0 ? formatDurationShort(v) : "no"} focus`;
                return (
                  <span
                    key={d.getTime()}
                    className="year-cell"
                    role="cell"
                    data-level={level}
                    data-out={out || undefined}
                    data-today={dayKey(d) === dayKey(new Date(props.now)) || undefined}
                    data-info={out ? undefined : fullDay.format(d)}
                    data-info-focus={out ? undefined : `${v > 0 ? formatDurationShort(v) : "no"} focus`}
                    aria-label={out ? undefined : label}
                  >
                    {t && !out ? shadeRun(level) : ""}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="year-legend muted small" aria-hidden="true">
        {t ? "less" : "Less"}
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="year-cell" data-level={l}>
            {t ? TERMINAL_LEVELS[l]!.repeat(2) : ""}
          </span>
        ))}
        {t ? "more" : "More"}
      </p>
    </div>
  );
}
