import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bucketBounds,
  focusByBucket,
  focusByHour,
  formatDurationShort,
  heatLevel,
  periodFor,
  shiftPeriod,
  streaks,
  summarize,
  type Period,
  type PeriodKind,
} from "@focus/core";
import type { RouteId } from "../../app/routes";
import { Card } from "../../components/Card";
import { useHistoryChanged } from "../../ipc/history";
import { loadStats, type AppStat, type StatsData } from "../../ipc/stats";
import { useUi } from "../../theme/UiProvider";
import { YearGrid, shadeRun } from "./YearGrid";
import { WeeklyReview } from "./WeeklyReview";
import { Num } from "../../components/Num";

/** Weeks start on Monday, like the To-do board. */
const WEEK_START = 1;
/** How far back streaks look. */
const STREAK_DAYS = 400;

const KINDS: { kind: PeriodKind; label: string; current: string }[] = [
  { kind: "week", label: "Week", current: "This week" },
  { kind: "month", label: "Month", current: "This month" },
  { kind: "year", label: "Year", current: "This year" },
];

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const longDay = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const dayMonthYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const shortMonth = new Intl.DateTimeFormat(undefined, { month: "short" });
const longMonth = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

type Load = { kind: "loading" } | { kind: "ready"; data: StatsData } | { kind: "error"; message: string };

/** "19–25 Oct 2026", "October 2026" or "2026". */
function rangeLabel(p: Period): string {
  const first = new Date(p.startMs);
  if (p.kind === "year") return String(first.getFullYear());
  if (p.kind === "month") return monthYear.format(first);
  // The locale decides the order, e.g. "19–25 Oct 2026" or "Oct 19 – 25, 2026".
  return dayMonthYear.formatRange(first, new Date(p.endMs - 1));
}

function bucketLabel(p: Period, i: number): string {
  const d = new Date(p.buckets[i]!.startMs);
  if (p.kind === "week") return weekday.format(d);
  if (p.kind === "year") return shortMonth.format(d);
  return String(d.getDate());
}

function bucketTitle(p: Period, key: string): string {
  const b = p.buckets.find((x) => x.key === key);
  if (!b) return key;
  return p.kind === "year" ? longMonth.format(new Date(b.startMs)) : longDay.format(new Date(b.startMs));
}

/** "1.5h" over a bar, "40m" under an hour. */
function shortHours(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  const h = seconds / 3600;
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10}h`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Focus time, sessions, PC on and active computer time, apps and distractions for a week, month or year. */
/** `phone`: the phone app's copy, without this-PC parts (computer time, apps, PC on). */
export function StatsPage(props: { onNavigate: (r: RouteId) => void; phone?: boolean }) {
  const phone = props.phone === true;
  const { theme } = useUi();
  const [kind, setKind] = useState<PeriodKind>("week");
  const [period, setPeriod] = useState(() => periodFor("week", new Date(), WEEK_START));
  const [state, setState] = useState<Load>({ kind: "loading" });

  const reload = useCallback(() => {
    const streakFrom = new Date();
    streakFrom.setDate(streakFrom.getDate() - STREAK_DAYS);
    loadStats(bucketBounds(period), streakFrom.getTime())
      .then((data) => setState({ kind: "ready", data }))
      .catch((err: unknown) => setState({ kind: "error", message: String(err) }));
  }, [period]);
  useEffect(reload, [reload]);
  useHistoryChanged(reload);
  useHistoryChanged(reload, "activity-changed");
  useHistoryChanged(reload, "stats-changed");
  // PC on time grows while you look, so refresh each minute. When a new day (or week) starts
  // while the current period is shown, move on to the new current period.
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = Date.now();
      if (t >= period.endMs && t - period.endMs < 2 * 86_400_000) setPeriod(periodFor(period.kind, new Date(), WEEK_START));
      else if (t >= period.startMs && t < period.endMs) reload();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [period, reload]);

  function choose(k: PeriodKind) {
    setKind(k);
    setPeriod(periodFor(k, new Date(), WEEK_START));
  }

  const now = Date.now();
  const isCurrent = now >= period.startMs && now < period.endMs;
  const data = state.kind === "ready" ? state.data : null;
  const sessions = useMemo(() => data?.sessions ?? [], [data]);
  // Days before your first session (within the last 400 days) don't count towards the average.
  const firstEver = useMemo(() => {
    const all = [...(data?.focusStarts ?? []), ...sessions.map((x) => x.startedAt)];
    return all.length ? Math.min(...all) : undefined;
  }, [data, sessions]);
  const summary = useMemo(() => summarize(sessions, period, now, firstEver), [sessions, period, now, firstEver]);
  const perBucket = useMemo(() => focusByBucket(sessions, period.buckets), [sessions, period]);
  const hours = useMemo(() => focusByHour(sessions, WEEK_START), [sessions]);
  const streak = useMemo(() => streaks(data?.focusStarts ?? [], now), [data, now]);
  const active = data?.active ?? period.buckets.map(() => 0);
  const activeTotal = active.reduce((n, s) => n + s, 0);
  const pcOn = data?.pcOn ?? period.buckets.map(() => 0);
  const focusHere = data?.focusHere ?? period.buckets.map(() => 0);
  const hereTotal = sessions.filter((x) => x.here).reduce((n, x) => n + x.actualS, 0);
  const elsewhere = Math.max(0, summary.focusSeconds - hereTotal);
  const tracking = data?.trackedSince != null;
  const current = KINDS.find((k) => k.kind === kind)!;

  return (
    <section aria-labelledby="stats-title" className="stats-page">
      <div className="space-tabs">
        <h1 id="stats-title" className="page-title space-tabs-title">
          Statistics
        </h1>
        <div className="space-tab-list" role="tablist" aria-label="Period">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="tab"
              className="space-tab"
              aria-selected={kind === k.kind}
              data-active={kind === k.kind}
              onClick={() => choose(k.kind)}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <div className="board-toolbar stats-toolbar">
        <button
          type="button"
          className="button small-button board-this-week"
          onClick={() => setPeriod(periodFor(kind, new Date(), WEEK_START))}
          data-hidden={isCurrent}
          tabIndex={isCurrent ? -1 : undefined}
          aria-hidden={isCurrent}
        >
          {current.current}
        </button>
        <button type="button" className="icon-button" onClick={() => setPeriod(shiftPeriod(period, -1, WEEK_START))} aria-label={`Previous ${kind}`} title={`Previous ${kind}`}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </button>
        <span className="board-range stats-range">{rangeLabel(period)}</span>
        <button type="button" className="icon-button" onClick={() => setPeriod(shiftPeriod(period, 1, WEEK_START))} aria-label={`Next ${kind}`} title={`Next ${kind}`}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M8 4l6 6-6 6" />
          </svg>
        </button>
      </div>

      {state.kind === "error" && (
        <div className="card notice error-notice" role="alert">
          <p>
            <strong>Could not load your statistics.</strong> {state.message}
          </p>
          <button type="button" className="button" onClick={reload}>
            Try again
          </button>
        </div>
      )}

      {period.kind === "week" && (
        <Card title="Weekly review" className="review-card" hoverInfo>
          <WeeklyReview period={period} />
        </Card>
      )}

      <div className="dashboard-grid stats-tiles">
        <Card title="Focus time">
          <p className="big-number"><Num>{formatDurationShort(summary.focusSeconds)}</Num></p>
          <p className="muted">{formatDurationShort(Math.round(summary.dailyAverage / 60) * 60)} a day on average</p>
          {elsewhere >= 60 && <p className="muted small">{formatDurationShort(elsewhere)} of it on {phone ? "your PCs" : "your phone or another PC"}</p>}
          {summary.best && period.kind !== "week" && (
            <p className="muted small">
              Best: {bucketTitle(period, summary.best.key)}, {formatDurationShort(summary.best.seconds)}
            </p>
          )}
        </Card>
        <Card title="Sessions">
          <p className="big-number">{summary.completed}</p>
          <p className="muted">
            completed{summary.stopped > 0 ? `, ${summary.stopped} stopped early` : ""}
            {summary.completionRate !== null ? ` · ${Math.round(summary.completionRate * 100)}% finished` : ""}
          </p>
          {summary.averageSession > 0 && <p className="muted small">{formatDurationShort(summary.averageSession)} per session on average</p>}
        </Card>
        {!phone && (
        <Card title="Active computer time">
          {tracking ? (
            <>
              <p className="big-number"><Num>{formatDurationShort(activeTotal)}</Num></p>
              <p className="muted">
                {activeTotal > 0
                  ? `${Math.min(100, Math.round((hereTotal / activeTotal) * 100))}% of it in focus`
                  : "nothing tracked in this period"}
              </p>
            </>
          ) : (
            <>
              <p className="big-number muted-number">–</p>
              <p className="muted">
                Turn on App tracking in{" "}
                <button type="button" className="link-button" onClick={() => props.onNavigate("settings")}>
                  Settings
                </button>{" "}
                to see this.
              </p>
            </>
          )}
        </Card>
        )}
        <Card title="Streak">
          <p className="big-number"><Num>{plural(streak.current, "day")}</Num></p>
          <p className="muted">in a row with a finished session · best {plural(streak.best, "day")}</p>
        </Card>
      </div>

      <Card title={period.kind === "year" ? "Focus by month" : "Focus by day"} className="stats-chart-card" hoverInfo>
        <Chart period={period} focus={phone ? perBucket.map((b) => b.seconds) : focusHere} all={perBucket.map((b) => b.seconds)} pcOn={phone ? period.buckets.map(() => 0) : pcOn} terminal={theme === "terminal"} now={now} phone={phone} />
      </Card>

      <Card title="When you focus" hoverInfo>
        {/* Month and Year: a GitHub-style day calendar. Week: weekday by hour. */}
        {period.kind !== "week" ? (
          <YearGrid period={period} sessions={data ? sessions : null} weekStart={WEEK_START} terminal={theme === "terminal"} now={now} />
        ) : summary.focusSeconds > 0 ? (
          <HourGrid grid={hours} terminal={theme === "terminal"} />
        ) : (
          <p className="muted">No focus sessions in this period yet.</p>
        )}
      </Card>

      <div className="dashboard-grid stats-lower">
        {!phone && (
        <Card title="Top apps">
          {!tracking ? (
            <p className="muted">App tracking is off, so Kairos doesn't know which programs you used.</p>
          ) : (data?.apps.length ?? 0) === 0 ? (
            <p className="muted">No programs recorded in this period.</p>
          ) : (
            <AppList apps={data!.apps} />
          )}
        </Card>
        )}
        <Card title="Distractions">
          <Distractions data={data} />
        </Card>
        <Card title="Why you left focus">
          <Reasons data={data} />
        </Card>
      </div>
    </section>
  );
}

/**
 * This PC's focus next to how long this PC was on. Focus timed on the phone or another PC syncs
 * here too, but it isn't drawn: it didn't use this PC's time, so it is only named in the tooltip.
 */
function Chart(props: { period: Period; focus: number[]; all: number[]; pcOn: number[]; terminal: boolean; now: number; phone?: boolean }) {
  const { period, focus, all, pcOn } = props;
  const max = Math.max(...focus, ...pcOn, 1);
  const dense = period.buckets.length > 12;
  return (
    <>
      <p className="stats-legend muted small" aria-hidden="true">
        {props.phone ? (
          <>
            <span className="legend-swatch" data-series="focus" /> Focus on all your devices
          </>
        ) : (
          <>
            <span className="legend-swatch" data-series="focus" /> Focus on this PC <span className="legend-swatch" data-series="active" /> PC on
          </>
        )}
      </p>
      <ol className="stats-bars" data-info-zone data-dense={dense} style={{ gridTemplateColumns: `repeat(${period.buckets.length}, minmax(0, 1fr))` }}>
        {period.buckets.map((b, i) => {
          const isNow = props.now >= b.startMs && props.now < b.endMs;
          const label = bucketLabel(period, i);
          const f = focus[i] ?? 0;
          const a = pcOn[i] ?? 0;
          const other = Math.max(0, (all[i] ?? 0) - f);
          const desc = props.phone
            ? `${bucketTitle(period, b.key)}: ${formatDurationShort(f)} focus`
            : `${bucketTitle(period, b.key)}: ${formatDurationShort(f)} focus on this PC, PC on ${formatDurationShort(a)}${other >= 60 ? `; ${formatDurationShort(other)} focus on other devices` : ""}`;
          const infoFocus = `${formatDurationShort(f)} focus`;
          // On a month, label every day only when there is room; always the 1st and every 5th.
          const showLabel = !dense || i === 0 || (i + 1) % 5 === 0;
          return (
            <li key={b.key} aria-label={desc} data-info={bucketTitle(period, b.key)} data-info-more={!props.phone && other >= 60 ? `+${formatDurationShort(other)} on other devices` : undefined} data-info-focus={infoFocus} data-info-pc={props.phone ? undefined : `PC on ${formatDurationShort(a)}`} data-now={isNow} data-future={b.startMs > props.now}>
              <span className="bar-value num">{f > 0 && !dense ? shortHours(f) : ""}</span>
              <span className="stats-bar-pair">
                <span className="bar" data-series="focus" style={{ height: `${(f / max) * 100}%` }} />
                {!props.phone && <span className="bar" data-series="active" style={{ height: `${(a / max) * 100}%` }} />}
              </span>
              <span className="bar-label">{showLabel ? (props.terminal ? label.toLowerCase() : label) : ""}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function HourGrid(props: { grid: number[][]; terminal: boolean }) {
  const max = Math.max(...props.grid.flat(), 1);
  // 1 January 2024 was a Monday.
  const rows = props.grid.map((r, i) => ({
    name: weekday.format(new Date(2024, 0, 1 + ((i + WEEK_START - 1 + 7) % 7))),
    cells: r,
  }));
  return (
    <div className="hour-grid" data-info-zone role="table" aria-label="Focus time by weekday and hour">
      {rows.map((row) => (
        <div key={row.name} className="hour-row" role="row">
          <span className="hour-day" role="rowheader">
            {props.terminal ? row.name.toLowerCase() : row.name}
          </span>
          {row.cells.map((v, h) => {
            const level = heatLevel(v, max);
            return (
              <span
                key={h}
                className="hour-cell"
                role="cell"
                data-level={level}
                data-info={`${row.name} ${String(h).padStart(2, "0")}:00`}
                data-info-focus={`${v > 0 ? formatDurationShort(v) : "no"} focus`}
                aria-label={`${row.name} ${h}:00, ${formatDurationShort(v)}`}
              >
                {props.terminal ? shadeRun(level) : ""}
              </span>
            );
          })}
        </div>
      ))}
      <div className="hour-row hour-axis" aria-hidden="true">
        <span className="hour-day" />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="hour-tick">
            {h % 6 === 0 ? String(h).padStart(2, "0") : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function AppList(props: { apps: AppStat[] }) {
  const max = Math.max(...props.apps.map((a) => a.seconds), 1);
  return (
    <ul className="app-bars stats-apps">
      {props.apps.map((a) => (
        <li key={a.name} title={`${a.name}: ${formatDurationShort(a.seconds)} in all, ${formatDurationShort(a.focusSeconds)} during focus`}>
          <span className="app-name">{a.name}</span>
          <span className="app-bar stats-app-bar" aria-hidden="true">
            <span className="stats-app-all" style={{ width: `${Math.max(2, Math.round((a.seconds / max) * 100))}%` }}>
              <span style={{ width: `${a.seconds > 0 ? Math.round((a.focusSeconds / a.seconds) * 100) : 0}%` }} />
            </span>
          </span>
          <span className="num app-time">{formatDurationShort(a.seconds)}</span>
        </li>
      ))}
      <li className="stats-apps-key muted small" aria-hidden="true">
        <span className="legend-swatch" data-series="focus" /> during focus <span className="legend-swatch" data-series="active" /> other time
      </li>
    </ul>
  );
}

function Reasons(props: { data: StatsData | null }) {
  const r = props.data?.reasons ?? [];
  if (r.length === 0) {
    return <p className="muted">Nothing yet. When a blocked site asks "Why are you here?", your answers show up here.</p>;
  }
  return (
    <ul className="list stats-domains stats-reasons">
      {r.map((x) => (
        <li key={x.text}>
          <span>
            {x.text}
            {x.what.length > 0 && <span className="muted small"> · {x.what.join(", ")}</span>}
          </span>
          <span className="num muted">{x.count}×</span>
        </li>
      ))}
    </ul>
  );
}

function Distractions(props: { data: StatsData | null }) {
  const d = props.data?.distractions;
  if (!d || (d.blocked === 0 && d.continued === 0)) {
    return (
      <>
        <p className="big-number">0</p>
        <p className="muted">Nothing blocked in this period.</p>
        <p className="muted small">Counted by Kairos Blocker 0.11 or newer in your browser.</p>
      </>
    );
  }
  return (
    <>
      <p className="big-number">{d.blocked}</p>
      <p className="muted">
        blocked {d.blocked === 1 ? "page" : "pages"} opened
        {d.continued > 0 ? ` · continued anyway ${d.continued === 1 ? "once" : `${d.continued} times`}` : ""}
      </p>
      {d.topDomains.length > 0 && (
        <ul className="list stats-domains">
          {d.topDomains.map((x) => (
            <li key={x.domain}>
              <span>{x.domain}</span>
              <span className="num muted">{x.count}×</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
