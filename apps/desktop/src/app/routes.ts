export type RouteId =
  | "dashboard"
  | "timer"
  | "history"
  | "tasks"
  | "deadlines"
  | "notes"
  | "code"
  | "calendar"
  | "stats"
  | "blocking"
  | "sync"
  | "settings";

export interface Route {
  id: RouteId;
  label: string;
  /** Phase in which the page gets its real content; undefined = available now. */
  arrivesInPhase?: number;
  summary: string;
  /** Only in the Terminal theme (the Code page). */
  terminalOnly?: boolean;
}

export const ROUTES: Route[] = [
  { id: "dashboard", label: "Dashboard", summary: "Today at a glance." },
  { id: "timer", label: "Timer", summary: "Focus timer with presets and breaks, a stopwatch, and a countdown to a clock time." },
  { id: "tasks", label: "To-do", summary: "Checklist tasks like gym, shop and coding practice." },
  { id: "deadlines", label: "Deadlines", summary: "Finish-by dates with the 360° ring and the day grid." },
  { id: "notes", label: "Notes", summary: "Notes with bold, text size, lists and x² superscript." },
  { id: "code", label: "Code", summary: "Write and run C, C++, Java, Python and more, Neovim style.", terminalOnly: true },
  { id: "calendar", label: "Calendar", summary: "Your Google Calendar, holidays, tasks and deadlines in one place." },
  { id: "stats", label: "Statistics", summary: "Focus time, sessions, app usage and distractions, and the weekly review." },
  { id: "history", label: "History", summary: "Every focus session, day by day." },
  { id: "blocking", label: "Blocking", summary: "Sites, YouTube channels, tags and phrases, and Windows apps blocked during focus." },
  { id: "sync", label: "Sync", summary: "Pair your other PC and your phone; everything stays the same on all of them." },
  { id: "settings", label: "Settings", summary: "App behaviour, diagnostics and version." },
];

/** The pages in the menu for a theme, in order. Alt+1 … Alt+9, Alt+0 open the first ten. */
export function visibleRoutes(theme: string): Route[] {
  return ROUTES.filter((r) => !r.terminalOnly || theme === "terminal");
}

/** The Alt+key that opens the page at this place in the menu ("1"…"9", "0"), if any. */
export function altKeyAt(index: number): string | undefined {
  return index < 9 ? String(index + 1) : index === 9 ? "0" : undefined;
}
