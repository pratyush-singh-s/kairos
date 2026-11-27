import { useCallback, useEffect, useState } from "react";
import { formatDurationShort } from "@focus/core";
import { useHistoryChanged, type SessionRow } from "../../ipc/history";
import { getAppTotals, type AppTime } from "../../ipc/tracking";
import { usageSlices } from "../dashboard/UsageDonut";

const SIZE = 168;
const STROKE = 18;
/** Room around the ring for a slice to move out into. */
const POP = 8;
const R = (SIZE - STROKE) / 2 - POP;
/** Each slice runs this far under the next one, in degrees, so the ring is one solid band. */
const OVERLAP = 0.6;

function point(deg: number, r: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [SIZE / 2 + r * Math.cos(a), SIZE / 2 + r * Math.sin(a)];
}

function arc(from: number, to: number): string {
  const [x1, y1] = point(from, R);
  const [x2, y2] = point(to, R);
  return `M ${x1} ${y1} A ${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

/**
 * The whole day's screen time per program (App tracking) as one solid ring. Hovering a slice
 * moves it out and shows its name and time in the middle; otherwise the middle shows the day's
 * focus time (the screen time total is in the card's top right, DayScreenTime).
 */
/** The whole day's time per program (App tracking); [] when none was saved for that day. */
export function useDayApps(day: string): AppTime[] {
  const [apps, setApps] = useState<AppTime[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useHistoryChanged(refresh, "activity-changed");
  useEffect(() => {
    const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
    const from = new Date(y, m - 1, d).getTime();
    const to = new Date(y, m - 1, d + 1).getTime();
    let alive = true;
    getAppTotals(from, to).then(
      (a) => alive && setApps(a),
      () => alive && setApps([]),
    );
    return () => {
      alive = false;
    };
  }, [day, tick]);
  return apps;
}

/** The day's screen time (App tracking); the focus time when no screen time was saved and no ring shows. */
export function DayScreenTime(props: { day: string; focusSeconds: number; hasRing: boolean }) {
  const apps = useDayApps(props.day);
  const total = apps.reduce((s, a) => s + a.seconds, 0);
  // No screen time saved for that day: the ring (built from the sessions' apps) already shows the
  // focus time in its middle, so say nothing here. Without a ring, show the focus time instead.
  if (total === 0 && props.hasRing) return null;
  if (total === 0)
    return (
      <span className="num history-day-screen" title="Focus this day">
        <span className="muted small">Focus</span> {formatDurationShort(props.focusSeconds)}
      </span>
    );
  return (
    <span className="num history-day-screen" title="Screen time this day">
      <span className="muted small">Screen time</span> {formatDurationShort(total)}
    </span>
  );
}

export function HistoryPie(props: { day: string; rows: SessionRow[]; focusSeconds: number }) {
  const apps = useDayApps(props.day);
  // Older days can have no screen time saved for the whole day: then use the apps listed under
  // that day's focus sessions.
  const sessionApps = new Map<string, number>();
  for (const r of props.rows) for (const a of r.apps) sessionApps.set(a.name, (sessionApps.get(a.name) ?? 0) + a.seconds);
  const fromSessions = apps.length === 0;
  const slices = usageSlices(fromSessions ? [...sessionApps].map(([name, seconds]) => ({ name, seconds })) : apps);
  const total = slices.reduce((s, a) => s + a.seconds, 0);
  const [hover, setHover] = useState<number | null>(null);
  if (slices.length === 0 || total === 0) return null;
  const shown = hover === null ? null : slices[hover];

  return (
    <figure className="history-pie" aria-label={slices.map((s) => `${s.name} ${formatDurationShort(s.seconds)}`).join(", ")}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} onMouseLeave={() => setHover(null)} aria-hidden="true">
        {slices.map((s, i) => {
          const mid = (((s.from + s.to) / 2 - 90) * Math.PI) / 180;
          const out = hover === i ? POP : 0;
                    const common = {
            className: "history-pie-slice",
            "data-i": i,
            "data-other": s.name === "Other" || undefined,
            "data-on": hover === i || undefined,
            style: { transform: `translate(${Math.cos(mid) * out}px, ${Math.sin(mid) * out}px)` },
            onMouseEnter: () => setHover(i),
          };
          return slices.length === 1 ? (
            <circle key={s.name} cx={SIZE / 2} cy={SIZE / 2} r={R} {...common} />
          ) : (
            <path key={s.name} d={arc(s.from, Math.min(s.to + OVERLAP, s.from + 359.9))} {...common} />
          );
        })}
      </svg>
      <figcaption className="history-pie-info" aria-live="polite">
        <span className="history-pie-name">{shown ? shown.name : "Focus"}</span>
        <span className="history-pie-time num">{formatDurationShort(shown ? shown.seconds : props.focusSeconds)}</span>
      </figcaption>
    </figure>
  );
}
