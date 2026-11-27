import type { TerminalShell } from "../../ipc/ui";
import { ROUTES, type RouteId } from "../routes";

/** The prompt drawn in front of a command, split so each part can have its own colour. */
export interface Prompt {
  user?: string;
  path: string;
  /** What ends the prompt: "> ", "$ " or ">". */
  end: string;
  /** Text before the path (PowerShell's "PS "). */
  lead?: string;
}

export function promptFor(shell: TerminalShell): Prompt {
  switch (shell) {
    case "bash":
      return { user: "you@focus", path: "~", end: "$ " };
    case "cmd":
      return { path: "C:\\Kairos", end: ">" };
    default:
      return { lead: "PS ", path: "C:\\Kairos", end: "> " };
  }
}

/** The word typed to open each page. */
export const PAGE_COMMANDS: Record<RouteId, string> = {
  dashboard: "dashboard",
  timer: "timer",
  history: "history",
  tasks: "todo",
  deadlines: "deadlines",
  notes: "notes",
  code: "nvim",
  calendar: "calendar",
  stats: "stats",
  blocking: "blocking",
  sync: "sync",
  settings: "settings",
};

/** Other words that open a page too. */
const ALIASES: Record<string, RouteId> = {
  home: "dashboard",
  countdown: "timer",
  stopwatch: "timer",
  clock: "timer",
  sw: "timer",
  alarm: "timer",
  dash: "dashboard",
  tasks: "tasks",
  "to-do": "tasks",
  todos: "tasks",
  deadline: "deadlines",
  note: "notes",
  cal: "calendar",
  statistics: "stats",
  block: "blocking",
  config: "settings",
  code: "code",
  vim: "code",
  vi: "code",
  nano: "code",
};

export type CommandResult =
  | { kind: "none" }
  | { kind: "open"; route: RouteId; word?: string }
  | { kind: "theme"; theme: "glass" }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "print"; lines: string[]; error?: boolean };

/** Understands what was typed at the prompt. "cd notes", "focus notes" and "notes" all open Notes. */
export function runCommand(input: string, shell: TerminalShell, now = new Date(), colon = false): CommandResult {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: "none" };
  // "cd", "focus", "open" and "./" in front of a page name are all fine.
  const prefixed = words.length > 1 && ["cd", "focus", "open", "start", "go"].includes(words[0]!);
  if (prefixed) words.shift();
  const word = words.join(" ").replace(/^\.\//, "").replace(/^~\//, "").replace(/[\\/]+$/, "");

  const route = (Object.keys(PAGE_COMMANDS) as RouteId[]).find((r) => PAGE_COMMANDS[r] === word) ?? ALIASES[word];
  if (route) return { kind: "open", route, word };

  switch (word) {
    case "help":
    case "?":
    case "man focus":
    case "get-help":
      return { kind: "print", lines: helpLines() };
    case "ls":
    case "dir":
    case "get-childitem":
      return { kind: "print", lines: [ROUTES.map((r) => PAGE_COMMANDS[r.id]).join("  ")] };
    case "clear":
    case "cls":
    case "clear-host":
      return { kind: "clear" };
    case "exit":
    case "quit":
      return { kind: "exit" };
    case "glass":
    case "theme glass":
      return { kind: "theme", theme: "glass" };
    case "date":
    case "time":
    case "get-date":
      return { kind: "print", lines: [now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })] };
    case "whoami":
      return { kind: "print", lines: ["you, getting things done"] };
    case "pwd":
    case "get-location":
      return { kind: "print", lines: [promptFor(shell).path] };
  }
  // A folder on the PC (cd D:\\Projects, cd ~/Documents): this prompt only moves between Focus's pages.
  if (/^[a-z]:|[\\/]/.test(word) || word === ".." || word === "~") {
    return {
      kind: "print",
      lines: ["This prompt moves between Kairos pages; it can't open folders on your PC.", "Try cd notes, cd timer or ls. Files you code live in Documents\\Focus Code (cd code)."],
      error: true,
    };
  }
  if (prefixed) return { kind: "print", lines: [`No page called '${word}'. Type ls to see them all.`], error: true };
  if (colon) return { kind: "print", lines: [`E492: Not a command: ${input.trim()}  (:help lists them)`], error: true };
  return { kind: "print", lines: [notFound(input.trim(), shell)], error: true };
}

function notFound(cmd: string, shell: TerminalShell): string {
  const name = cmd.split(/\s+/)[0] ?? cmd;
  switch (shell) {
    case "bash":
      return `bash: ${name}: command not found (type help)`;
    case "cmd":
      return `'${name}' is not recognized as an internal or external command. Type help.`;
    default:
      return `${name}: The term '${name}' is not recognized as a command. Type help.`;
  }
}

function helpLines(): string[] {
  return [
    "pages:   " + ROUTES.map((r) => PAGE_COMMANDS[r.id]).join(", ") + " (or code)",
    "also:    cd <page>, ls, date, clear, glass (switch theme), exit (close window)",
    "keys:    Alt+1…9 / Alt+0 open pages, arrows move between buttons, Ctrl+` jumps here, Tab finishes a name",
  ];
}

/** Tab completion: finishes a page name when only one fits ("cd no" → "cd notes"). */
export function complete(input: string): string {
  const m = /^(\s*(?:(?:cd|focus|open|go)\s+)?)(\S*)$/i.exec(input);
  if (!m || !m[2]) return input;
  const part = m[2].toLowerCase();
  const words = [...Object.values(PAGE_COMMANDS), "help", "clear", "glass", "exit", "date"];
  const hits = words.filter((w) => w.startsWith(part));
  return hits.length === 1 ? `${m[1]}${hits[0]}` : input;
}
