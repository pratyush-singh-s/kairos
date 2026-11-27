/**
 * Runs on YouTube pages. During a focus session it hides Shorts (if you block them) and, if you
 * choose, comments, suggested videos and the home feed; it covers or
 * removes blocked videos in YouTube's lists, and tells the background script which video is
 * playing, so it can block chosen channels, tags and phrases. Nothing leaves your browser.
 */
import { blockLabel, youtubeVideoBlock, type VideoInfo } from "@focus/core";
import { isActive, load, type ExtState, type Message } from "../state";

const SHORTS_STYLE_ID = "focus-blocker-hide-shorts";
const SHORTS_CSS = `
ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, grid-shelf-view-model:has(ytm-shorts-lockup-view-model),
ytd-guide-entry-renderer:has(a[title="Shorts"]), ytd-mini-guide-entry-renderer[aria-label="Shorts"],
ytd-video-renderer:has(a[href^="/shorts/"]), ytd-grid-video-renderer:has(a[href^="/shorts/"]),
yt-tab-shape[tab-title="Shorts"], ytm-pivot-bar-item-renderer:has(.pivot-shorts) { display: none !important; }`;

// The other cleanups, each on its own switch (desktop and mobile site).
const COMMENTS_CSS = `ytd-comments#comments, #comments.ytd-watch-flexy, ytm-comment-section-renderer, ytm-engagement-panel-section-list-renderer[target-id*="comment"] { display: none !important; }`;
const RECOMMENDED_CSS = `
#secondary #related, ytd-watch-next-secondary-results-renderer, ytd-watch-flexy #secondary-inner > #related,
.ytp-endscreen-content, .ytp-ce-element, .videowall-endscreen, .ytp-fullscreen-grid, .ytp-autonav-endscreen-countdown-overlay,
ytm-item-section-renderer[section-identifier="related-items"], ytm-single-column-watch-next-results-renderer ytm-item-section-renderer:has(ytm-video-with-context-renderer) { display: none !important; }`;
const HOME_CSS = `
ytd-browse[page-subtype="home"] ytd-rich-grid-renderer, ytd-browse[page-subtype="home"] #chips-wrapper,
ytm-browse:has(ytm-rich-grid-renderer) ytm-rich-grid-renderer { display: none !important; }
ytd-browse[page-subtype="home"]::after { content: "Home feed hidden while you focus. Search for what you need."; display: block; padding: 48px 24px; text-align: center; font: 500 16px Roboto, Arial, sans-serif; color: var(--yt-spec-text-secondary, #888); }`;

function setStyle(id: string, css: string, on: boolean): void {
  const existing = document.getElementById(id);
  if (on && !existing) {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);
  } else if (!on && existing) {
    existing.remove();
  }
}

function setShortsHidden(hide: boolean): void {
  setStyle(SHORTS_STYLE_ID, SHORTS_CSS, hide);
}

interface PageDetails {
  videoId?: string;
  title?: string;
  author?: string;
  channelId?: string;
  keywords?: string[];
  shortDescription?: string;
}

/** The player's own details for the video (title, channel, tags), read from the page. */
function playerDetails(): PageDetails | null {
  try {
    // Firefox lets extensions read the page's own objects through wrappedJSObject.
    const page = (window as unknown as { wrappedJSObject: Record<string, any> }).wrappedJSObject;
    const player = (document.getElementById("movie_player") as unknown as { wrappedJSObject?: any } | null)?.wrappedJSObject;
    const response = player?.getPlayerResponse?.() ?? page.ytInitialPlayerResponse;
    const details = response?.videoDetails;
    if (!details) return null;
    // Copy it out of the page as plain text, so nothing from the page is used directly.
    return JSON.parse(String(page.JSON.stringify(details))) as PageDetails;
  } catch {
    return null;
  }
}

/** The channel as the page shows it (the player does not give the @handle). */
function domDetails(): { channelName?: string; channelHandle?: string } {
  const owner = document.querySelector<HTMLAnchorElement>(
    "ytd-watch-metadata ytd-channel-name a, ytd-video-owner-renderer a[href^='/@']",
  );
  const handle = /^\/(@[^/?#]+)/.exec(owner?.getAttribute("href") ?? "")?.[1];
  return {
    channelName: owner?.textContent?.trim() || undefined,
    channelHandle: handle ? decodeURIComponent(handle) : undefined,
  };
}

function descriptionText(): string {
  return document.querySelector("ytd-watch-metadata #description")?.textContent ?? "";
}

/** The #hashtag links YouTube shows above the title and in the description. */
function hashtags(): string[] {
  return [...document.querySelectorAll("ytd-watch-metadata #super-title a, ytd-watch-metadata a[href^='/hashtag/'], #description a[href^='/hashtag/']")]
    .map((a) => a.textContent?.trim().replace(/^#/, "") ?? "")
    .filter(Boolean);
}

function currentVideoId(): string | null {
  return new URL(location.href).searchParams.get("v");
}

let checking = 0;

/** Checks the video on this page, waiting up to a few seconds for YouTube to fill it in. */
/** Firefox lets this script read YouTube's own player data; Chrome doesn't. */
const canReadPage = "wrappedJSObject" in window;

async function checkVideo(s: ExtState): Promise<void> {
  const run = ++checking;
  const id = currentVideoId();
  if (!id) return;
  // Without the player's data (Chrome), the video's tags come from YouTube's player lookup instead.
  const looked = canReadPage ? null : fetchMeta(id);
  for (let tries = 0; tries < 24 && run === checking; tries++) {
    const p = playerDetails();
    const dom = domDetails();
    const fromPlayer = p?.videoId === id ? p : null;
    // Right after switching videos the page can still show the previous channel, so its
    // handle only counts once it agrees with the player's channel name.
    const sameChannel = fromPlayer !== null && dom.channelName === fromPlayer.author;
    // If the player's details can't be read (some browsers), use what the page shows, once the
    // tab title says the page is on this video.
    const pageTitle = document.querySelector("ytd-watch-metadata h1")?.textContent?.trim() ?? "";
    const pageOnly = fromPlayer === null && tries >= 8 && pageTitle !== "" && document.title.includes(pageTitle);
    const trustPage = sameChannel || pageOnly;
    const extra = pageOnly && looked ? await looked : null;
    const info: VideoInfo = {
      videoId: id,
      title: fromPlayer?.title ?? (pageOnly ? pageTitle : ""),
      channelName: fromPlayer?.author ?? (pageOnly ? dom.channelName : undefined),
      channelHandle: trustPage ? dom.channelHandle : undefined,
      channelId: fromPlayer?.channelId,
      tags: [...(fromPlayer?.keywords ?? []), ...(extra?.tags ?? []), ...(trustPage ? hashtags() : [])],
      description: fromPlayer?.shortDescription ?? (pageOnly ? `${descriptionText()} ${extra?.description ?? ""}`.trim() : undefined),
    };
    if (youtubeVideoBlock(info, s.youtube)) {
      document.querySelector<HTMLVideoElement>("video")?.pause();
      await browser.runtime.sendMessage({ kind: "video", url: location.href, info } satisfies Message);
      return;
    }
    if (trustPage && dom.channelHandle !== undefined) return; // everything checked
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------- videos in YouTube's lists

/** One video in a list: home page, search results, "Up next", channel pages. */
const ITEMS = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-playlist-video-renderer",
  "yt-lockup-view-model",
  "ytm-video-with-context-renderer",
  "ytm-compact-video-renderer",
].join(", ");
const MARK = "focusBlocker"; // data-focus-blocker="<what the item showed when checked>"

const FEED_CSS = `
[data-focus-blocker-hidden] { display: none !important; }
.focus-blocker-host { position: relative !important; }
.focus-blocker-cover {
  position: absolute; inset: -4px; z-index: 50; display: flex; align-items: center; justify-content: center;
  background: rgba(12, 14, 18, 0.9); backdrop-filter: blur(16px); border-radius: 12px; cursor: default;
}
.focus-blocker-cover span {
  border: 1.5px solid rgba(255, 255, 255, 0.75); padding: 10px 18px; max-width: 80%;
  color: #fff; font: 600 15px/1.3 system-ui, sans-serif; text-align: center; overflow-wrap: anywhere;
}
.focus-blocker-cover small { display: block; font-weight: 400; font-size: 11px; opacity: 0.7; margin-top: 4px; }`;

function ensureFeedStyle(): void {
  if (document.getElementById("focus-blocker-feed")) return;
  const style = document.createElement("style");
  style.id = "focus-blocker-feed";
  style.textContent = FEED_CSS;
  (document.head ?? document.documentElement).append(style);
}

function itemDetails(item: Element): { title: string; channelName?: string; channelHandle?: string } {
  const titleEl = item.querySelector(
    "#video-title, .yt-lockup-metadata-view-model__title, [class*='lockup-metadata'][class*='title' i], [class*='LockupMetadata'][class*='Title'], h3 a, h3, .media-item-headline",
  );
  let title = (titleEl?.getAttribute("title") || titleEl?.textContent || "").trim();
  // YouTube renames its classes now and then: fall back to the video links themselves.
  if (!title) {
    for (const a of item.querySelectorAll<HTMLElement>('a[href*="watch?v="], a[href^="/shorts/"]')) {
      title = (a.getAttribute("title") || a.getAttribute("aria-label") || a.textContent || "").trim();
      if (title) break;
    }
  }
  const link = item.querySelector<HTMLAnchorElement>('a[href^="/@"]');
  const handle = /^\/(@[^/?#]+)/.exec(link?.getAttribute("href") ?? "")?.[1];
  const name = item
    .querySelector("ytd-channel-name #text, ytd-channel-name a, .yt-content-metadata-view-model__metadata-text a, .yt-content-metadata-view-model__metadata-text")
    ?.textContent?.trim();
  return { title, channelName: name || undefined, channelHandle: handle ? decodeURIComponent(handle) : undefined };
}

/** Takes off whatever this script put on an item. */
function unmark(item: HTMLElement): void {
  delete item.dataset[MARK];
  item.removeAttribute("data-focus-blocker-hidden");
  item.classList.remove("focus-blocker-host");
  item.querySelectorAll(".focus-blocker-cover").forEach((c) => c.remove());
}

/** Covers the whole video card (picture, title, channel) with a box saying what matched. */
function cover(item: HTMLElement, label: string): void {
  if (item.querySelector(":scope > .focus-blocker-cover")) return;
  item.classList.add("focus-blocker-host");
  const box = document.createElement("div");
  box.className = "focus-blocker-cover";
  const text = document.createElement("span");
  text.textContent = label;
  const note = document.createElement("small");
  note.textContent = "blocked while you focus";
  text.append(note);
  box.append(text);
  // Swallow clicks so the cover doesn't open the video underneath.
  for (const type of ["click", "mousedown", "mouseup"]) {
    box.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
  item.append(box);
}

function videoIdOf(item: Element): string | null {
  const href = item.querySelector<HTMLAnchorElement>('a[href*="watch?v="]')?.getAttribute("href");
  if (!href) return null;
  return new URL(href, location.origin).searchParams.get("v");
}

function scanFeed(s: ExtState | null): void {
  const on = s !== null && isActive(s);
  const rules = s?.youtube;
  // Tags aren't shown in lists, so they're looked up per video when tags or phrases are blocked.
  const wantMeta = !!rules && rules.tags.length + rules.keywords.length > 0;
  for (const item of document.querySelectorAll<HTMLElement>(ITEMS)) {
    if (!on || !rules) {
      if (item.dataset[MARK] !== undefined) unmark(item);
      continue;
    }
    // A card inside another card (home page): handle only the outer one.
    if (item.parentElement?.closest(ITEMS)) continue;
    const d = itemDetails(item);
    if (!d.title) continue; // not filled in yet
    const id = videoIdOf(item);
    const meta = id && wantMeta ? videoMeta(id) : null;
    // YouTube reuses list items for other videos, so re-check whenever what it shows changes.
    const seen = `${rules.feed}|${id ?? ""}|${d.title}|${d.channelHandle ?? ""}|${d.channelName ?? ""}|${meta ? "m" : "-"}`;
    if (item.dataset[MARK] === seen) continue;
    unmark(item);
    item.dataset[MARK] = seen;
    const block = youtubeVideoBlock(
      { videoId: id ?? "", ...d, tags: meta?.tags ?? [], description: meta?.description },
      rules,
    );
    if (!block) continue;
    ensureFeedStyle();
    if (rules.feed === "hide") item.setAttribute("data-focus-blocker-hidden", "");
    else cover(item, blockLabel(block));
  }
}

// ---------------------------------------------------------------- tags of listed videos

interface VideoMeta {
  tags: string[];
  /** Only the description's #hashtags, to keep the saved copy small. */
  description: string;
}

const META_KEY = "ytMeta";
const META_MAX = 3000;
const meta = new Map<string, VideoMeta>();
const pending = new Set<string>();
const queue: string[] = [];
let running = 0;
let metaLoaded = false;

/** A listed video's tags if known; otherwise starts looking them up and returns null. */
function videoMeta(id: string): VideoMeta | null {
  const known = meta.get(id);
  if (known) return known;
  if (!pending.has(id)) {
    pending.add(id);
    queue.push(id);
    void pump();
  }
  return null;
}

async function loadSavedMeta(): Promise<void> {
  if (metaLoaded) return;
  metaLoaded = true;
  const saved = ((await browser.storage.local.get(META_KEY))[META_KEY] ?? {}) as Record<string, VideoMeta>;
  for (const [id, m] of Object.entries(saved)) if (!meta.has(id)) meta.set(id, m);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveMetaSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const entries = [...meta.entries()].slice(-META_MAX);
    void browser.storage.local.set({ [META_KEY]: Object.fromEntries(entries) });
  }, 2000);
}

/** Looks up a few videos at a time, so YouTube isn't flooded. */
async function pump(): Promise<void> {
  await loadSavedMeta();
  while (running < 3 && queue.length > 0) {
    const id = queue.shift()!;
    if (meta.has(id)) {
      pending.delete(id);
      continue;
    }
    running++;
    void fetchMeta(id)
      .then((m) => {
        if (m) {
          meta.set(id, m);
          saveMetaSoon();
          queueScan();
        }
      })
      .finally(() => {
        running--;
        pending.delete(id);
        void pump();
      });
  }
}

function hashtagsIn(text: string): string {
  return [...text.matchAll(/#[\p{L}\p{N}_]+/gu)].map((m) => m[0]).join(" ");
}

/** Firefox's content.fetch asks as the YouTube page itself (same cookies and origin). */
const pageFetch: typeof fetch =
  (globalThis as unknown as { content?: { fetch?: typeof fetch } }).content?.fetch?.bind(
    (globalThis as unknown as { content: unknown }).content,
  ) ?? fetch;

/** The video's tags and description, from YouTube's own player data. */
async function fetchMeta(id: string): Promise<VideoMeta | null> {
  try {
    const page = (window as unknown as { wrappedJSObject?: Record<string, any> }).wrappedJSObject;
    const version = String(page?.ytcfg?.get?.("INNERTUBE_CLIENT_VERSION") ?? "2.20250101.00.00");
    const res = await pageFetch("/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ videoId: id, context: { client: { clientName: "WEB", clientVersion: version, hl: "en" } } }),
    });
    const data = (await res.json()) as { videoDetails?: { videoId?: string; keywords?: string[]; shortDescription?: string } };
    const v = data.videoDetails;
    if (v?.videoId === id) return { tags: (v.keywords ?? []).slice(0, 60), description: hashtagsIn(v.shortDescription ?? "") };
  } catch {
    // Fall through to the watch page.
  }
  try {
    const html = await (await pageFetch(`/watch?v=${encodeURIComponent(id)}`, { credentials: "same-origin" })).text();
    const keywords = /"keywords":(\[[^\]]*\])/.exec(html)?.[1];
    const desc = /"shortDescription":("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
    if (!keywords && !desc) return null;
    return {
      tags: keywords ? (JSON.parse(keywords) as string[]).slice(0, 60) : [],
      description: desc ? hashtagsIn(JSON.parse(desc) as string) : "",
    };
  } catch {
    return null;
  }
}

let state: ExtState | null = null;
let scanQueued = false;
function queueScan(): void {
  if (scanQueued) return;
  scanQueued = true;
  setTimeout(() => {
    scanQueued = false;
    scanFeed(state);
  }, 300);
}
// ---------------------------------------------------------------- the page as a whole

async function refresh(): Promise<void> {
  const s = await load();
  const changed = JSON.stringify([s.session, s.youtube]) !== JSON.stringify([state?.session, state?.youtube]);
  state = s;
  if (changed) {
    // Rules or session changed: check every list item again.
    document.querySelectorAll<HTMLElement>(ITEMS).forEach(unmark);
  }
  scanFeed(s);
  const on = isActive(s);
  setShortsHidden(on && s.youtube.blockShorts);
  setStyle("focus-blocker-hide-comments", COMMENTS_CSS, on && s.youtube.hideComments);
  setStyle("focus-blocker-hide-recommended", RECOMMENDED_CSS, on && s.youtube.hideRecommended);
  setStyle("focus-blocker-hide-home", HOME_CSS, on && s.youtube.hideHomeFeed);
  if (on && (s.youtube.channels.length > 0 || s.youtube.tags.length > 0 || s.youtube.keywords.length > 0)) await checkVideo(s);
}

function start(): void {
  new MutationObserver(() => {
    if (state && isActive(state)) queueScan();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  // YouTube swaps pages without reloading; it fires this event when a new page is shown.
  document.addEventListener("yt-navigate-finish", () => void refresh());
  // The mobile site (m.youtube.com) has no such event, so also watch the address.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      void refresh();
    }
  }, 1000);
  // A session starting or the lists changing while YouTube is open.
  browser.storage.onChanged.addListener((changes) => {
    if (changes.session || changes.youtube) void refresh();
  });
  void refresh();
}

// The script can be added again to an open tab (when you allow it on YouTube); run it once.
const flags = window as unknown as { focusBlockerStarted?: boolean };
if (!flags.focusBlockerStarted) {
  flags.focusBlockerStarted = true;
  start();
}
