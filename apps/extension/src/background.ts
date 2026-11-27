/**
 * Background script: sends a tab to the "blocked" page when it opens a listed site during a
 * focus session, keeps the toolbar badge honest (ON / OFF), runs the extension's own focus timer,
 * and ends sessions on time.
 */
import { ruleFor, youtubeUrlBlock, youtubeVideoBlock, type YoutubeBlock } from "@focus/core";
import { reportDistraction, runLink } from "./link";
import { pair, runPhoneLink, unlink } from "./phone";
import { hasPass, isActive, load, save, sessionChanges, youtubePassKey, type ExtState, type Message } from "./state";
import { UNLOAD_ALARM, forget, markUsed, unloadIdleTabs } from "./unload";
import { catchUp, cleanPrefs, nextPhase, pauseTimer, resumeTimer, startTimer, timeLeft, type TimerState } from "./timer";

const END_ALARM = "session-end";
const TIMER_ALARM = "timer-phase";

function blockedPageFor(url: string, yt?: YoutubeBlock): string {
  const q = new URLSearchParams({ u: url });
  if (yt) {
    q.set("yt", yt.reason);
    if (yt.reason === "channel") q.set("why", yt.channel);
    if (yt.reason === "tag") q.set("why", yt.tag);
    if (yt.reason === "keyword") q.set("why", yt.keyword);
  }
  return browser.runtime.getURL(`blocked.html?${q.toString()}`);
}

/** A YouTube block, unless you already chose to continue to this page. */
function youtubeRedirect(s: ExtState, url: string, block: YoutubeBlock | null): string | null {
  if (!block) return null;
  if (s.youtube.mode === "wait" && hasPass(s, youtubePassKey(url))) return null;
  return blockedPageFor(url, block);
}

/** The blocked-page address for this tab's URL, or null if it may load. */
function redirectFor(s: ExtState, url: string): string | null {
  if (!isActive(s)) return null;
  const rule = ruleFor(url, s.rules);
  if (rule) return rule.mode === "wait" && hasPass(s, rule.domain) ? null : blockedPageFor(url);
  // Shorts and channel pages can be told from the address; videos are checked by the page.
  return youtubeRedirect(s, url, youtubeUrlBlock(url, s.youtube));
}

async function check(tabId: number, frameId: number, url: string): Promise<void> {
  if (frameId !== 0) return;
  const target = redirectFor(await load(), url);
  if (target) {
    reportDistraction("blocked_hit", url);
    await browser.tabs.update(tabId, { url: target });
  } else await remember(tabId, url);
}

/*
 * "Go back" on the blocked page returns to the last page in that tab that was allowed. The
 * pages each tab visited (last few) and which tab was active before each tab are kept in session
 * storage, which Firefox clears when it closes.
 */
type Trail = Record<string, string[]>;

// Session storage (cleared when Firefox closes); kept in memory if this Firefox lacks it.
const memory: Record<string, unknown> = {};
const sessionArea = {
  get: async (keys: string | string[]): Promise<Record<string, unknown>> =>
    browser.storage.session
      ? browser.storage.session.get(keys)
      : Object.fromEntries([keys].flat().map((k) => [k, memory[k]]).filter(([, v]) => v !== undefined)),
  set: async (items: Record<string, unknown>): Promise<void> =>
    browser.storage.session ? browser.storage.session.set(items) : void Object.assign(memory, items),
};

async function remember(tabId: number, url: string): Promise<void> {
  if (!/^https?:/.test(url)) return;
  const { trail = {} } = (await sessionArea.get("trail")) as { trail?: Trail };
  const list = (trail[tabId] ?? []).filter((u) => u !== url);
  list.push(url);
  trail[tabId] = list.slice(-8);
  await sessionArea.set({ trail });
}

/** The last page in this tab that may load now and isn't the one just blocked. */
async function lastAllowed(s: ExtState, tabId: number, blockedUrl: string): Promise<string | null> {
  const { trail = {} } = (await sessionArea.get("trail")) as { trail?: Trail };
  const blockedKey = youtubePassKey(blockedUrl);
  const list = trail[tabId] ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const url = list[i]!;
    if (url === blockedUrl || youtubePassKey(url) === blockedKey) continue;
    if (!redirectFor(s, url)) return url;
  }
  return null;
}

browser.tabs.onActivated.addListener(async ({ tabId, previousTabId }) => {
  markUsed(tabId);
  if (previousTabId !== undefined) markUsed(previousTabId);
  if (previousTabId === undefined) return;
  const { previous = {} } = (await sessionArea.get("previous")) as { previous?: Record<string, number> };
  previous[tabId] = previousTabId;
  await sessionArea.set({ previous });
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  forget(tabId);
  const { trail = {}, previous = {} } = (await sessionArea.get(["trail", "previous"])) as {
    trail?: Trail;
    previous?: Record<string, number>;
  };
  delete trail[tabId];
  delete previous[tabId];
  await sessionArea.set({ trail, previous });
});

/** Back to the last allowed page in this tab; if there is none, close it and return to the tab you came from. */
async function goBack(s: ExtState, tab: browser.tabs.Tab, blockedUrl: string): Promise<void> {
  if (tab.id === undefined) return;
  const url = await lastAllowed(s, tab.id, blockedUrl);
  if (url) {
    await browser.tabs.update(tab.id, { url });
    return;
  }
  const { previous = {} } = (await sessionArea.get("previous")) as { previous?: Record<string, number> };
  const backTo = previous[tab.id] ?? tab.openerTabId;
  if (backTo !== undefined) await browser.tabs.update(backTo, { active: true }).catch(() => {});
  await browser.tabs.remove(tab.id);
}

browser.webNavigation.onBeforeNavigate.addListener((d) => void check(d.tabId, d.frameId, d.url));
// YouTube changes pages without loading a new one (opening a Short from the home page, say).
browser.webNavigation.onHistoryStateUpdated.addListener((d) => void check(d.tabId, d.frameId, d.url));

/** When a session starts or the list changes, catch tabs that are already open on a listed site. */
async function sweepTabs(): Promise<void> {
  const s = await load();
  if (!isActive(s)) return;
  for (const tab of await browser.tabs.query({})) {
    const target = tab.id !== undefined && tab.url ? redirectFor(s, tab.url) : null;
    if (target && tab.id !== undefined) {
      reportDistraction("blocked_hit", tab.url!);
      await browser.tabs.update(tab.id, { url: target });
    }
  }
}

async function updateBadge(): Promise<void> {
  const s = await load();
  const on = isActive(s);
  // A break of the extension's own timer shows as a quiet "BRK".
  const onBreak = !on && s.timer?.phase === "break";
  await browser.browserAction.setBadgeText({ text: on ? "ON" : onBreak ? "BRK" : "" });
  await browser.browserAction.setBadgeBackgroundColor({ color: on ? "#2f9e6e" : "#4b5563" });
  await browser.browserAction.setTitle({
    title: on ? "Kairos Blocker: blocking is on" : onBreak ? "Kairos Blocker: break" : "Kairos Blocker: blocking is off",
  });
}

/** Puts the right session in charge (app, then phone, then the timer) and wakes up when it ends. */
async function resolve(): Promise<void> {
  const s = await load();
  const changes = sessionChanges(s);
  if (Object.keys(changes).length) await save(changes);
  const session = "session" in changes ? changes.session : s.session;
  if (session) await browser.alarms.create(END_ALARM, { when: session.until + 50 });
  else await browser.alarms.clear(END_ALARM);
}

/* The extension's own timer. */

async function notify(message: string): Promise<void> {
  await browser.notifications
    .create("focus-timer", { type: "basic", iconUrl: browser.runtime.getURL("icons/icon-96.png"), title: "Kairos Blocker", message })
    .catch(() => {});
}

function phaseMessage(prev: TimerState, next: TimerState | null): string {
  if (!next) return prev.rounds > 1 ? `All ${prev.rounds} focus rounds done. Well done!` : "Focus done. Well done!";
  if (next.phase === "break") return `Focus done. Take a ${next.breakMin}-minute break; sites are open until it ends.`;
  return prev.phase === "break" ? `Break's over. Focus ${next.round} of ${next.rounds} has started.` : `Focus ${next.round} of ${next.rounds} has started.`;
}

async function saveTimer(timer: TimerState | null): Promise<void> {
  await save({ timer });
  if (timer && timer.pausedAt === null) await browser.alarms.create(TIMER_ALARM, { when: timer.endsAt });
  else await browser.alarms.clear(TIMER_ALARM);
}

/** Moves the timer on when a phase has ended (also after Firefox was closed through it). */
async function tickTimer(): Promise<void> {
  const s = await load();
  if (!s.timer) return;
  const prev = s.timer;
  const { timer, changed } = catchUp(prev);
  if (!changed) return;
  await saveTimer(timer);
  // Only say so when it just happened, not for phases that ended while the browser was closed.
  if (Date.now() - prev.endsAt < 60_000) await notify(phaseMessage(prev, nextPhase(prev, prev.endsAt)));
}

browser.runtime.onMessage.addListener(async (raw: unknown, sender: browser.runtime.MessageSender) => {
  const msg = raw as Message;
  const s = await load();
  switch (msg.kind) {
    case "timerStart": {
      const prefs = cleanPrefs(msg.prefs);
      await save({ timerPrefs: prefs });
      await saveTimer(startTimer(prefs));
      return { ok: true };
    }
    case "timerPause":
      if (s.timer?.phase !== "focus") return { ok: false };
      await saveTimer(pauseTimer(s.timer));
      return { ok: true };
    case "timerResume":
      if (!s.timer) return { ok: false };
      await saveTimer(resumeTimer(s.timer));
      return { ok: true };
    case "timerSkip":
      // Ends this phase now: a break starts early, or the next focus round does.
      if (!s.timer) return { ok: false };
      await saveTimer(timeLeft(s.timer) > 0 ? nextPhase(s.timer, Date.now()) : s.timer);
      return { ok: true };
    case "timerStop":
      await saveTimer(null);
      return { ok: true };
    case "phonePair":
      return { result: await pair(msg.address, msg.code) };
    case "phoneUnlink":
      await unlink();
      return { ok: true };
    case "pass": {
      // Allowed until the session ends; a full block never gets a pass.
      const rule = s.rules.find((r) => r.domain === msg.domain);
      if (!s.session || !rule || rule.mode !== "wait") return { ok: false };
      await save({ passes: { ...s.passes, [msg.domain]: s.session.until } });
      reportDistraction("continued", `https://${msg.domain}/`, Date.now(), msg.reason);
      return { ok: true };
    }
    case "ytPass": {
      if (!s.session || s.youtube.mode !== "wait" || !msg.key.startsWith("yt:")) return { ok: false };
      await save({ passes: { ...s.passes, [msg.key]: s.session.until } });
      reportDistraction("continued", "https://youtube.com/", Date.now(), msg.reason);
      return { ok: true };
    }
    case "goBack":
      if (sender.tab) await goBack(s, sender.tab, msg.url);
      return { ok: true };
    case "video": {
      // Only the YouTube tab that sent it can be sent to the blocked page.
      const tabId = sender.tab?.id;
      const tabUrl = sender.tab?.url;
      if (tabId === undefined || !tabUrl || !isActive(s) || youtubePassKey(tabUrl) !== youtubePassKey(msg.url)) {
        return { blocked: false };
      }
      const target = youtubeRedirect(s, msg.url, youtubeVideoBlock(msg.info, s.youtube));
      if (target) {
        reportDistraction("blocked_hit", msg.url);
        await browser.tabs.update(tabId, { url: target });
      }
      return { blocked: target !== null };
    }
  }
  return { ok: false };
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === END_ALARM) void resolve();
  if (alarm.name === TIMER_ALARM) void tickTimer();
  if (alarm.name === UNLOAD_ALARM) void unloadIdleTabs();
});

browser.storage.onChanged.addListener((changes) => {
  void updateBadge();
  if (changes.appSession || changes.phoneSession || changes.timer) void resolve();
  if (changes.rules || changes.session || changes.youtube) void sweepTabs();
});

// A session or timer phase that ended while Firefox was closed.
async function startUp(): Promise<void> {
  await tickTimer();
  const s = await load();
  if (s.timer?.pausedAt === null) await browser.alarms.create(TIMER_ALARM, { when: s.timer.endsAt });
  await resolve();
  await updateBadge();
  await browser.alarms.create(UNLOAD_ALARM, { periodInMinutes: 1 });
}
const YOUTUBE_ACCESS = { origins: ["*://*.youtube.com/*"] };

browser.runtime.onStartup.addListener(() => void startUp());
browser.runtime.onInstalled.addListener(async () => {
  await startUp();
  // Without access to YouTube pages, channels, tags and phrases can't be checked: show how to allow it.
  if (!(await browser.permissions.contains(YOUTUBE_ACCESS))) await browser.runtime.openOptionsPage();
});

/** When you allow YouTube access, start checking the YouTube tabs that are already open. */
browser.permissions.onAdded.addListener(async () => {
  if (!(await browser.permissions.contains(YOUTUBE_ACCESS))) return;
  for (const tab of await browser.tabs.query({ url: "*://*.youtube.com/*" })) {
    if (tab.id === undefined) continue;
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["youtube.js"] }).catch(() => {});
  }
});
void startUp();
void runLink();
void runPhoneLink();
