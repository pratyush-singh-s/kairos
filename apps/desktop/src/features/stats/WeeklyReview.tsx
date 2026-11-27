import { useCallback, useEffect, useState } from "react";
import { bucketBounds, formatDurationShort, type Period } from "@focus/core";
import { useHistoryChanged } from "../../ipc/history";
import { loadWeekReview, type ReviewDeadline, type WeekReview } from "../../ipc/review";
import { Num } from "../../components/Num";

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dueDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

const OUTCOME: Record<ReviewDeadline["outcome"], { mark: string; word: string }> = {
  hit: { mark: "✓", word: "Hit" },
  missed: { mark: "✕", word: "Missed" },
  open: { mark: "○", word: "Still open" },
};

/** "+1h 20m on last week", "40m less than last week", or "same as last week". */
function compare(now: number, before: number): string {
  const diff = now - before;
  if (Math.abs(diff) < 60) return before === 0 ? "" : "about the same as last week";
  if (before === 0) return "nothing the week before";
  return diff > 0 ? `${formatDurationShort(diff)} more than last week` : `${formatDurationShort(-diff)} less than last week`;
}

/**
 * The weekly review for one week: focus time logged, the deadlines due that week (hit, missed
 * or still open, with the focus started from each), and what blocking stopped most.
 */
export function WeeklyReview(props: { period: Period }) {
  const { period } = props;
  const [review, setReview] = useState<WeekReview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    loadWeekReview(bucketBounds(period))
      .then((r) => {
        setReview(r);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [period]);
  useEffect(reload, [reload]);
  useHistoryChanged(reload);
  useHistoryChanged(reload, "stats-changed");
  useHistoryChanged(reload, "deadlines-changed");

  if (error) return <p className="muted">Could not load the review. {error}</p>;
  if (!review) return <p className="muted">Loading…</p>;

  const max = Math.max(...review.focusByDay, 1);
  const counts = { hit: 0, missed: 0, open: 0 };
  for (const d of review.deadlines) counts[d.outcome] += 1;
  const vs = compare(review.focusSeconds, review.prevFocusSeconds);
  const now = Date.now();

  return (
    <div className="review">
      <div className="review-col">
        <h3 className="review-head">Focus</h3>
        <p className="big-number"><Num>{formatDurationShort(review.focusSeconds)}</Num></p>
        <p className="muted">
          {review.sessions} {review.sessions === 1 ? "session" : "sessions"}
          {vs ? ` · ${vs}` : ""}
        </p>
        {review.deadlineFocusSeconds > 0 && <p className="muted small">{formatDurationShort(review.deadlineFocusSeconds)} of it started from a deadline</p>}
        <ol className="review-days" data-info-zone aria-label="Focus by day">
          {period.buckets.map((b, i) => {
            const s = review.focusByDay[i] ?? 0;
            const label = weekday.format(new Date(b.startMs));
            return (
              <li key={b.key} aria-label={`${label}: ${formatDurationShort(s)}`} data-info={label} data-info-focus={`${formatDurationShort(s)} focus`} data-now={now >= b.startMs && now < b.endMs} data-future={b.startMs > now}>
                <span className="review-day-bar">
                  <span style={{ height: `${(s / max) * 100}%` }} />
                </span>
                <span className="review-day-label">{label.slice(0, 2)}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="review-col">
        <h3 className="review-head">Deadlines</h3>
        {review.deadlines.length === 0 ? (
          <p className="muted">No deadlines were due this week.</p>
        ) : (
          <>
            <p className="review-counts">
              <span data-outcome="hit">{counts.hit} hit</span>
              <span data-outcome="missed">{counts.missed} missed</span>
              {counts.open > 0 && <span data-outcome="open">{counts.open} still open</span>}
            </p>
            <ul className="list review-deadlines">
              {review.deadlines.map((d) => (
                <li key={d.id} data-outcome={d.outcome}>
                  <span className="review-mark" aria-label={OUTCOME[d.outcome].word} title={OUTCOME[d.outcome].word} style={d.color ? { ["--pic" as string]: d.color } : undefined}>
                    {OUTCOME[d.outcome].mark}
                  </span>
                  <span className="review-title">
                    {d.title}
                    <span className="muted small">
                      {" "}
                      · due {dueDay.format(new Date(d.dueAt))}
                    </span>
                  </span>
                  <span className="num muted small">{d.focusSeconds > 0 ? formatDurationShort(d.focusSeconds) : ""}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="review-col">
        <h3 className="review-head">Blocked most</h3>
        {review.topBlocked.length === 0 ? (
          <p className="muted">Nothing was blocked during focus this week.</p>
        ) : (
          <>
            <p className="muted">
              {review.blockedTotal} {review.blockedTotal === 1 ? "time" : "times"} in all
            </p>
            <ul className="list review-blocked">
              {review.topBlocked.map((b) => (
                <li key={`${b.kind}:${b.name}`}>
                  <span>
                    {b.name} <span className="review-kind">{b.kind === "app" ? "app" : "site"}</span>
                  </span>
                  <span className="num muted">{b.count}×</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
