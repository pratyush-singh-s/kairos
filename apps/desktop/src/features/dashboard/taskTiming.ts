import { useEffect, useState } from "react";
import { formatTimeRange } from "@focus/core";
import type { Task } from "../../ipc/tasks";
import type { TaskWhen } from "../tasks/TaskRow";

/** A task starting within this many minutes shows a live countdown. */
const SOON_MIN = 15;

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Today's start and end of a timed task, in ms since midnight; null when it has no time. */
function span(t: Task): { start: number; end: number } | null {
  if (!t.startTime) return null;
  const start = toMin(t.startTime);
  let end = t.endTime ? toMin(t.endTime) : start + (t.durationMin ?? 30);
  if (end <= start) end += 1440; // 11 PM – 12 AM ends after midnight
  return { start: start * 60_000, end: end * 60_000 };
}

function sinceMidnight(now: number): number {
  const d = new Date(now);
  return now - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function taskWhen(t: Task, now: number): TaskWhen | undefined {
  const s = span(t);
  if (!s) return undefined;
  const at = sinceMidnight(now);
  if (at >= s.end) return { state: "past", text: formatTimeRange(t.startTime!, null) };
  if (at >= s.start) return { state: "now", text: "Now" };
  if (s.start - at <= SOON_MIN * 60_000) return { state: "soon", text: countdown(s.start - at) };
  return { state: "later", text: formatTimeRange(t.startTime!, null) };
}

/** Open tasks by time of day: coming up first, then ones with no time, then ones whose time has gone. */
export function byTimeOfDay(tasks: Task[], now: number): Task[] {
  const rank = (t: Task) => {
    const w = taskWhen(t, now);
    return !w ? 1 : w.state === "past" ? 2 : 0;
  };
  return tasks
    .map((t, i) => ({ t, i, r: rank(t), s: t.startTime ?? "" }))
    .sort((a, b) => a.r - b.r || a.s.localeCompare(b.s) || a.i - b.i)
    .map((x) => x.t);
}

/** The clock for the list: every second while a countdown or "Now" is close, else every 15 s. */
export function useTaskClock(tasks: Task[]): number {
  const [now, setNow] = useState(() => Date.now());
  const fast = tasks.some((t) => {
    const w = taskWhen(t, now);
    if (!w) return false;
    if (w.state === "soon") return true;
    const s = span(t)!;
    const at = sinceMidnight(now);
    return (w.state === "later" && s.start - at <= (SOON_MIN + 1) * 60_000) || (w.state === "now" && s.end - at <= 60_000);
  });
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), fast ? 1000 : 15_000);
    return () => window.clearInterval(id);
  }, [fast]);
  return now;
}
