/**
 * Everything the extension remembers, in browser.storage.local, plus small helpers.
 * Blocking follows, in this order: the Kairos app on this PC while it runs a focus phase (source
 * "app", see link.ts), the Kairos phone app (source "phone", see phone.ts), and the extension's
 * own focus timer (source "timer", see timer.ts). `session` is the one in charge right now.
 */
import { DEFAULT_WAIT_SECONDS, DEFAULT_YOUTUBE, cleanYoutubeRules, type BlockRule, type VideoInfo, type YoutubeRules } from "@focus/core";
import { DEFAULT_TIMER_PREFS, timerSession, type TimerPrefs, type TimerState } from "./timer";

export type Theme = "glass" | "terminal";

export type Source = "app" | "phone" | "timer";

export interface Session {
  /** When blocking stops (ms since epoch). */
  until: number;
  source: Source;
}

/** The Kairos phone app this browser follows, once linked with a code (see phone.ts). */
export interface PhoneLink {
  /** The phone's address on your Wi-Fi, e.g. "192.168.1.23:47814". */
  address: string;
  token: string;
  name: string;
}

export interface ExtState {
  rules: BlockRule[];
  /** Countdown used for newly added "wait" sites. */
  defaultWait: number;
  theme: Theme;
  /** The session in charge (worked out from the three below by `resolveSession`). */
  session: Session | null;
  /** What the Kairos app on this PC asks for. */
  appSession: Session | null;
  /** What the linked phone asks for. */
  phoneSession: Session | null;
  /** The extension's own focus timer, while it runs. */
  timer: TimerState | null;
  /** Lengths the timer starts with next time. */
  timerPrefs: TimerPrefs;
  phone: PhoneLink | null;
  /** Whether the phone answered last time. */
  phoneStatus: { connected: boolean; appVersion: string | null; paused: boolean };
  /** Shorts, channels and keywords to block on YouTube. */
  youtube: YoutubeRules;
  /**
   * What you chose to continue to after the countdown, until when (ms): a site's domain, or
   * "yt:" plus a YouTube video id or page address.
   */
  passes: Record<string, number>;
  /** Whether the Kairos app on this PC answered last time. */
  link: { connected: boolean; appVersion: string | null; paused: boolean };
  /** The lists come from the Kairos app's Blocking page (and are edited there, not here). */
  managed: boolean;
  /** Which one sent the lists last: the app on this PC or the phone (which has the laptop's lists). */
  managedBy: "app" | "phone" | null;
  /** The Kairos app's colours (its palette or your own), so these pages match it. Null = built-in. */
  colors: AppColors | null;
  /** Unload tabs you haven't used for this many minutes (see unload.ts). */
  unloadTabs: { on: boolean; minutes: number };
}

/** The app's colours for one theme, as CSS values. Mirrors `extColors` in the app's UiProvider.tsx. */
export interface AppColors {
  theme: Theme;
  bg: string;
  bgImage?: string;
  surface: string;
  raised: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  ok: string;
  failed: string;
  number: string;
}

const COLOR_VARS: [keyof AppColors, string][] = [
  ["bg", "--bg"], ["surface", "--surface"], ["raised", "--raised"], ["border", "--border"], ["text", "--text"],
  ["muted", "--muted"], ["accent", "--accent"], ["onAccent", "--on-accent"], ["ok", "--ok"], ["failed", "--failed"],
  ["number", "--number"],
];

/** A colour value safe to put in a style: colour words, #hex, rgb()/hsl()/color-mix() and gradients. */
const SAFE = /^[#a-z0-9 ,.%()/\-]{1,600}$/i;

/** Cleans colours from the app; null if they are not usable. */
export function cleanColors(v: unknown): AppColors | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.theme !== "glass" && o.theme !== "terminal") return null;
  const out: Record<string, string> = { theme: o.theme };
  for (const [k] of COLOR_VARS) {
    const c = o[k];
    if (typeof c !== "string" || !SAFE.test(c) || /url|expression/i.test(c)) return null;
    out[k] = c;
  }
  if (typeof o.bgImage === "string" && SAFE.test(o.bgImage) && !/url|expression/i.test(o.bgImage)) out.bgImage = o.bgImage;
  return out as unknown as AppColors;
}

export const DEFAULTS: ExtState = {
  rules: [],
  defaultWait: DEFAULT_WAIT_SECONDS,
  theme: "glass",
  colors: null,
  session: null,
  appSession: null,
  phoneSession: null,
  timer: null,
  timerPrefs: DEFAULT_TIMER_PREFS,
  phone: null,
  phoneStatus: { connected: false, appVersion: null, paused: false },
  youtube: DEFAULT_YOUTUBE,
  passes: {},
  link: { connected: false, appVersion: null, paused: false },
  managed: false,
  managedBy: null,
  unloadTabs: { on: true, minutes: 10 },
};

export async function load(): Promise<ExtState> {
  const raw = (await browser.storage.local.get(Object.keys(DEFAULTS))) as Partial<ExtState>;
  const s = { ...DEFAULTS, ...raw, youtube: cleanYoutubeRules(raw.youtube) };
  // Before 0.14 the app wrote `session` itself, and "test" sessions came from the popup.
  if (raw.appSession === undefined && s.session?.source === "app") s.appSession = s.session;
  if (s.session && (s.session.source as string) === "test") s.session = null;
  if (s.managed && !s.managedBy) s.managedBy = "app";
  return s;
}

export async function save(changes: Partial<ExtState>): Promise<void> {
  await browser.storage.local.set(changes);
}

export function isActive(s: ExtState, now = Date.now()): boolean {
  return s.session !== null && s.session.until > now;
}

const live = (x: Session | null, now: number): Session | null => (x && x.until > now ? x : null);

/** Who is in charge: the PC app, then the phone, then the extension's own timer. */
export function resolveSession(s: ExtState, now = Date.now()): Session | null {
  return live(s.appSession, now) ?? live(s.phoneSession, now) ?? live(timerSession(s.timer, now), now);
}

/**
 * The changes that put the right session in charge. A session that starts (or comes from a new
 * source) starts with no passes: what you continued to before doesn't carry over.
 */
export function sessionChanges(s: ExtState, now = Date.now()): Partial<ExtState> {
  const next = resolveSession(s, now);
  const cur = s.session;
  if (JSON.stringify(next) === JSON.stringify(cur)) return {};
  const changes: Partial<ExtState> = { session: next };
  if (!next || !cur || cur.source !== next.source) changes.passes = {};
  return changes;
}

/** Whether you already chose to continue to this site (or YouTube page) in the current session. */
export function hasPass(s: ExtState, key: string, now = Date.now()): boolean {
  return (s.passes[key] ?? 0) > now;
}

/** The pass key for a YouTube page: the video (watch pages and Shorts) or else the address. */
export function youtubePassKey(url: string): string {
  try {
    const u = new URL(url);
    const id = u.searchParams.get("v") ?? /^\/shorts\/([^/?#]+)/.exec(u.pathname)?.[1];
    return `yt:${id ?? u.pathname.toLowerCase()}`;
  } catch {
    return `yt:${url}`;
  }
}

/** Messages the pages send to the background script. */
export type Message =
  | { kind: "timerStart"; prefs: TimerPrefs }
  | { kind: "timerPause" }
  | { kind: "timerResume" }
  | { kind: "timerSkip" }
  | { kind: "timerStop" }
  /** From the options page: link to a phone with the code it shows. */
  | { kind: "phonePair"; address: string; code: string }
  | { kind: "phoneUnlink" }
  | { kind: "pass"; domain: string; reason?: string }
  | { kind: "ytPass"; key: string; reason?: string }
  /** From the blocked page: back to the last allowed page, or the previous tab. */
  | { kind: "goBack"; url: string }
  /** From the YouTube page: the video now playing, to check against channels and keywords. */
  | { kind: "video"; url: string; info: VideoInfo };

/** Applies the saved theme to a page. */
export async function applyTheme(): Promise<ExtState> {
  const s = await load();
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  // The app's palette (or your own colours) for this theme, so the pages match the app.
  const c = s.colors && s.colors.theme === s.theme ? s.colors : null;
  for (const [k, name] of COLOR_VARS) {
    if (c) root.style.setProperty(name, String(c[k]));
    else root.style.removeProperty(name);
  }
  if (c) {
    root.dataset.appColors = "on";
    root.style.setProperty("--app-bg-image", c.bgImage && c.bgImage !== "none" ? c.bgImage : "none");
  } else {
    delete root.dataset.appColors;
    root.style.removeProperty("--app-bg-image");
  }
  return s;
}

export function formatLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
