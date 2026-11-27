/**
 * The link to the Kairos app on this PC (Phase 13): while the app's timer is in a focus phase,
 * blocking is on; on a break, when the timer stops or when the app closes, it goes off again.
 * The app comes first: while it runs a focus phase, the phone and the extension's own timer wait.
 *
 * The app answers on http://127.0.0.1:47811 (see src-tauri/src/bridge.rs). Each request waits
 * up to 25 s for a change, so a new phase arrives at once.
 */
import { cleanRules, cleanYoutubeRules, clampWait, hostOf, youtubeEntries, type TagGroup } from "@focus/core";
import { cleanColors, load, save, type ExtState, type Session } from "./state";

const URL_BASE = "http://127.0.0.1:47811/v1/focus";
const DISTRACTION_URL = "http://127.0.0.1:47811/v1/distraction";
const IMPORT_URL = "http://127.0.0.1:47811/v1/blocking/import";
const GROUPS_URL = "http://127.0.0.1:47811/v1/blocking/groups";
/** One page load can fire several navigation events; the same report this soon counts once. */
const SAME_REPORT_MS = 5_000;
/** A bit longer than the app's 25 s wait. */
const REQUEST_TIMEOUT_MS = 35_000;
/** How soon to ask again when the app isn't running. */
const RETRY_MS = 5_000;
/** A paused focus phase has no end time; keep blocking and let the link refresh it. */
const PAUSED_HOLD_MS = 24 * 60 * 60_000;

/** The lists from the app's Blocking page. Mirrors `publish_blocking` in bridge.rs. */
export interface AppBlocking {
  rules: unknown;
  youtube: unknown;
  defaultWait: number;
  theme?: string;
  /** The app's palette colours for its theme (app 0.21.77.B and later). */
  colors?: unknown;
}

/** Mirrors `Reply` in apps/desktop/src-tauri/src/bridge.rs. */
export interface AppFocus {
  version: number;
  appVersion: string;
  active: boolean;
  paused: boolean;
  endsAtMs: number | null;
  presetName: string | null;
  /** Missing from apps older than 0.20; false until the app has lists of its own. */
  blockingConfigured?: boolean;
  blocking?: AppBlocking;
}

/** Whether the app answered last time, shown in the popup. */
export interface LinkStatus {
  connected: boolean;
  appVersion: string | null;
  /** The app's focus phase is paused (blocking stays on). */
  paused: boolean;
}

/** The session a focus state (from the app or the phone) asks for, or null for none. */
export function sessionFor(focus: AppFocus, source: Session["source"] = "app", now = Date.now()): Session | null {
  if (!focus.active) return null;
  return { until: focus.paused || !focus.endsAtMs ? now + PAUSED_HOLD_MS : focus.endsAtMs, source };
}

/**
 * The new session for one source, or undefined when the saved one still fits. While paused the
 * hold is "a day from now"; it isn't rewritten on every answer.
 */
export function nextSession(cur: Session | null, focus: AppFocus | null, source: Session["source"], now = Date.now()): Session | null | undefined {
  const next = focus ? sessionFor(focus, source, now) : null;
  const holding = !!focus?.paused && !!cur && cur.until - now > 60 * 60_000;
  if (next && !holding) return !cur || cur.until !== next.until ? next : undefined;
  if (!next && cur) return null;
  return undefined;
}

/** The changes to save for a new state of the app on this PC (null = it isn't running). */
export function changesFor(s: ExtState, focus: AppFocus | null, now = Date.now()): Partial<ExtState> {
  const changes: Partial<ExtState> = {};
  const session = nextSession(s.appSession, focus, "app", now);
  if (session !== undefined) changes.appSession = session;
  const link: LinkStatus = { connected: focus !== null, appVersion: focus?.appVersion ?? null, paused: !!focus?.paused };
  if (JSON.stringify(link) !== JSON.stringify(s.link)) changes.link = link;
  if (focus?.blocking) Object.assign(changes, listChanges(s, focus.blocking, "app"));
  return changes;
}

/** The app's lists (and theme) as changes to save; only what differs, so nothing is rewritten needlessly. */
export function listChanges(s: ExtState, b: AppBlocking, from: "app" | "phone" = "app"): Partial<ExtState> {
  const changes: Partial<ExtState> = {};
  const rules = cleanRules(b.rules);
  const youtube = cleanYoutubeRules(b.youtube ?? undefined);
  const defaultWait = clampWait(b.defaultWait);
  if (JSON.stringify(rules) !== JSON.stringify(s.rules)) changes.rules = rules;
  if (JSON.stringify(youtube) !== JSON.stringify(s.youtube)) changes.youtube = youtube;
  if (defaultWait !== s.defaultWait) changes.defaultWait = defaultWait;
  if ((b.theme === "glass" || b.theme === "terminal") && b.theme !== s.theme) changes.theme = b.theme;
  if (b.colors !== undefined) {
    const colors = cleanColors(b.colors);
    if (JSON.stringify(colors) !== JSON.stringify(s.colors)) changes.colors = colors;
  }
  if (!s.managed) changes.managed = true;
  if (s.managedBy !== from) changes.managedBy = from;
  return changes;
}

/** Whether this browser has lists worth handing to an app that has none yet. */
export function hasOwnLists(s: ExtState): boolean {
  return s.rules.length > 0 || youtubeEntries(s.youtube).length > 0;
}

/** Hands this browser's lists to the app (it takes them only while it has none). */
async function offerLists(): Promise<void> {
  const s = await load();
  if (!hasOwnLists(s)) return;
  const body = JSON.stringify({ rules: s.rules, youtube: s.youtube, defaultWait: s.defaultWait });
  await fetch(IMPORT_URL, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body });
}

/** What happened to tag groups sent to the app. */
export type GroupsSent = "saved" | "closed" | "old-app";

/**
 * Hands new YouTube tag groups to the app, which owns the lists while it manages them; it saves
 * them and sends them back to every browser. Apps older than 0.21.4 don't know this request.
 */
export async function sendTagGroups(groups: TagGroup[]): Promise<GroupsSent> {
  try {
    const res = await fetch(GROUPS_URL, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404 || res.status === 400) return "old-app";
    if (!res.ok) return "closed";
    const { saved } = (await res.json()) as { saved?: boolean };
    return saved ? "saved" : "closed";
  } catch {
    return "closed";
  }
}

async function apply(focus: AppFocus | null): Promise<void> {
  const changes = changesFor(await load(), focus);
  if (Object.keys(changes).length) await save(changes);
}

async function ask(since: number | null): Promise<AppFocus> {
  const q = since === null ? "" : `?since=${since}`;
  const res = await fetch(URL_BASE + q, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Kairos app answered ${res.status}`);
  return (await res.json()) as AppFocus;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs for as long as the background page lives (it is persistent). */
export async function runLink(): Promise<void> {
  let since: number | null = null;
  let offered = false;
  for (;;) {
    try {
      const focus = await ask(since);
      since = focus.version;
      await apply(focus);
      // An app without lists of its own takes this browser's (once per start).
      if (focus.blockingConfigured === false && !offered) {
        offered = true;
        await offerLists().catch(() => {});
      }
    } catch {
      // The app is closed (or restarting): stop any blocking it started, then try again soon.
      since = null;
      await apply(null).catch(() => {});
      await sleep(RETRY_MS);
    }
  }
}

const lastReport = new Map<string, number>();

/**
 * Tells the app that a blocked page opened ("blocked_hit") or that you pressed "Continue anyway"
 * ("continued", with the reason you gave), for Statistics. Only the site's name is sent, never the address. The app counts
 * it only during a focus phase; when the app is closed it is simply lost.
 */
export function reportDistraction(kind: "blocked_hit" | "continued", url: string, now = Date.now(), reason?: string): boolean {
  const host = hostOf(url)?.replace(/^www\./, "");
  if (!host) return false;
  const key = `${kind} ${host}`;
  // A reason is always worth sending (you typed it); repeats without one are not.
  if (!reason && now - (lastReport.get(key) ?? 0) < SAME_REPORT_MS) return false;
  lastReport.set(key, now);
  const q = new URLSearchParams({ kind, domain: host });
  if (reason) q.set("reason", reason.slice(0, 120));
  void fetch(`${DISTRACTION_URL}?${q.toString()}`, { method: "POST", cache: "no-store" }).catch(() => {});
  return true;
}
