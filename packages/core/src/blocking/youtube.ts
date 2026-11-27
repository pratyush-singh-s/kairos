/**
 * YouTube blocking: Shorts, chosen channels, tags, and videos whose title or tags contain chosen
 * words. Used when youtube.com itself is not blocked, so the useful parts of YouTube stay open.
 * Everything is typed into one box: "@name" is a channel, "#name" a tag, anything else a phrase.
 */
import { DEFAULT_WAIT_SECONDS, clampWait, hostMatches, hostOf, type BlockMode } from "./rules";

export interface YoutubeRules {
  blockShorts: boolean;
  /** During focus, hide the comments under videos. */
  hideComments: boolean;
  /** During focus, hide suggested videos: the "Up next" column and the end-of-video wall. */
  hideRecommended: boolean;
  /** During focus, hide the home page's video grid (search still works). */
  hideHomeFeed: boolean;
  /** "@handle", a channel id ("UC…"), or a channel's name, all lower-case. */
  channels: string[];
  /** Tags without the "#", lower-case, e.g. "minecraft". */
  tags: string[];
  /** Words or phrases, lower-case. A video whose title or tags contain one is blocked. */
  keywords: string[];
  /** One choice for all of YouTube's blocks: a countdown, or no way through. */
  mode: BlockMode;
  waitSeconds: number;
  /** Blocked videos in YouTube's lists (home, search, up next): covered with a label, or removed. */
  feed: FeedMode;
  /**
   * Tags and phrases gathered under a name ("Gaming": #gaming, #sologaming, minecraft), only to
   * keep the list tidy. Everything in a group is also in `tags` or `keywords`, so blocking works
   * the same with or without groups.
   */
  groups: TagGroup[];
}

export interface TagGroup {
  name: string;
  tags: string[];
  /** Blocked phrases in the group (Focus 0.21.27.B / extension 0.15.1 and newer). */
  phrases?: string[];
}

/** Longest group name, in characters. */
export const MAX_GROUP_NAME = 40;

export type FeedMode = "cover" | "hide";

export const DEFAULT_YOUTUBE: YoutubeRules = {
  blockShorts: true,
  hideComments: false,
  hideRecommended: false,
  hideHomeFeed: false,
  channels: [],
  tags: [],
  keywords: [],
  mode: "wait",
  waitSeconds: DEFAULT_WAIT_SECONDS,
  feed: "cover",
  groups: [],
};

/** What the page tells us about the video being watched. */
export interface VideoInfo {
  videoId: string;
  title: string;
  channelName?: string;
  /** With the "@", e.g. "@mkbhd". */
  channelHandle?: string;
  channelId?: string;
  tags: string[];
  /** The video's description; its #hashtags count as tags. */
  description?: string;
}

export type YoutubeBlock =
  | { reason: "shorts" }
  | { reason: "channel"; channel: string }
  | { reason: "tag"; tag: string; group?: string }
  | { reason: "keyword"; keyword: string; group?: string };

/** One thing typed into the block box. */
export type YoutubeEntry = { kind: "channel" | "tag" | "phrase"; value: string };

const YOUTUBE_DOMAINS = ["youtube.com", "youtube-nocookie.com"];

export function isYoutubeUrl(url: string): boolean {
  const host = hostOf(url);
  return host !== null && YOUTUBE_DOMAINS.some((d) => hostMatches(host, d));
}

/**
 * Turns what someone typed or pasted ("https://www.youtube.com/@MKBHD/videos", "@mkbhd",
 * "youtube.com/channel/UC…", "Marques Brownlee") into how the channel is stored, or null.
 */
export function normalizeChannel(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  const path = /(?:^|\/\/|\.)youtube\.com\/(.*)$/i.exec(s)?.[1];
  if (path !== undefined) {
    const handle = /^(@[^/?#]+)/.exec(path)?.[1];
    const id = /^channel\/([^/?#]+)/.exec(path)?.[1];
    s = handle ?? id ?? "";
    if (!s) return null;
    s = decodeURIComponent(s);
  }
  s = s.toLowerCase().replace(/\s+/g, " ");
  if (s === "@") return null;
  return s.length > 100 ? null : s;
}

/** A tag without its "#", lower-case, or null if empty. */
export function normalizeTag(input: string): string | null {
  const s = input.trim().replace(/^#+/, "").trim().toLowerCase().replace(/\s+/g, " ");
  return s && s.length <= 100 ? s : null;
}

/**
 * Reads what was typed into the block box: "@name" or a channel link is a channel, "#name" is a
 * tag, anything else is a word or phrase.
 */
export function parseYoutubeEntry(input: string): YoutubeEntry | null {
  const s = input.trim();
  if (s.startsWith("@") || /youtube\.com\//i.test(s) || /^UC[\w-]{22}$/.test(s)) {
    const value = normalizeChannel(s);
    return value ? { kind: "channel", value } : null;
  }
  if (s.startsWith("#")) {
    const value = normalizeTag(s);
    return value ? { kind: "tag", value } : null;
  }
  const value = normalizeKeyword(s);
  return value ? { kind: "phrase", value } : null;
}

const LIST_OF = { channel: "channels", tag: "tags", phrase: "keywords" } as const;

/** The rules with one more entry (no duplicates). */
export function addYoutubeEntry(rules: YoutubeRules, entry: YoutubeEntry): YoutubeRules {
  const key = LIST_OF[entry.kind];
  return rules[key].includes(entry.value) ? rules : { ...rules, [key]: [...rules[key], entry.value] };
}

export function removeYoutubeEntry(rules: YoutubeRules, entry: YoutubeEntry): YoutubeRules {
  const key = LIST_OF[entry.kind];
  const next = { ...rules, [key]: rules[key].filter((v) => v !== entry.value) };
  return entry.kind === "channel" ? next : { ...next, groups: cleanGroups(next.groups, next.tags, next.keywords) };
}

/** What a group can hold: blocked tags and blocked phrases. */
export type GroupItem = { kind: "tag" | "phrase"; value: string };

const GROUP_LIST = { tag: "tags", phrase: "phrases" } as const;

const itemsOf = (g: TagGroup): GroupItem[] => [
  ...g.tags.map((value) => ({ kind: "tag" as const, value })),
  ...(g.phrases ?? []).map((value) => ({ kind: "phrase" as const, value })),
];

const holds = (g: TagGroup, item: GroupItem) => (g[GROUP_LIST[item.kind]] ?? []).includes(item.value);

const isBlocked = (rules: YoutubeRules, item: GroupItem) =>
  (item.kind === "tag" ? rules.tags : rules.keywords).includes(item.value);

const groupSize = (g: TagGroup) => g.tags.length + (g.phrases ?? []).length;

/** Leaves `phrases` off a group that has none, as groups looked before phrases could join. */
function tidy(g: TagGroup): TagGroup {
  if ((g.phrases ?? []).length > 0) return g;
  const { phrases: _none, ...rest } = g;
  return rest;
}

/** Takes `item` out of whatever group it is in (empty groups go). */
function ungrouped(groups: TagGroup[], item: GroupItem): TagGroup[] {
  const key = GROUP_LIST[item.kind];
  return groups
    .map((g) => tidy({ ...g, [key]: (g[key] ?? []).filter((v) => v !== item.value) }))
    .filter((g) => groupSize(g) > 0);
}

function withItem(g: TagGroup, item: GroupItem): TagGroup {
  const key = GROUP_LIST[item.kind];
  return { ...g, [key]: [...(g[key] ?? []), item.value] };
}

function groupOf(items: GroupItem[], name: string): TagGroup {
  return tidy(items.reduce(withItem, { name, tags: [] } as TagGroup));
}

/**
 * `item` dropped on `onto`: joins the group `onto` is in, or the two start a new group named
 * after `onto` (rename it afterwards). Dropping something on itself changes nothing.
 */
export function groupItemWith(rules: YoutubeRules, item: GroupItem, onto: GroupItem): YoutubeRules {
  if ((item.kind === onto.kind && item.value === onto.value) || !isBlocked(rules, item) || !isBlocked(rules, onto)) return rules;
  const target = rules.groups.find((g) => holds(g, onto));
  if (target) return moveItemToGroup(rules, item, target.name);
  const groups = ungrouped(ungrouped(rules.groups, item), onto);
  return { ...rules, groups: [...groups, groupOf([onto, item], uniqueGroupName(groups, onto.value))] };
}

/** Puts `item` in the group called `name`, or in no group (null). */
export function moveItemToGroup(rules: YoutubeRules, item: GroupItem, name: string | null): YoutubeRules {
  if (!isBlocked(rules, item)) return rules;
  const groups = ungrouped(rules.groups, item);
  const i = name === null ? -1 : groups.findIndex((g) => g.name === name);
  if (i < 0) return { ...rules, groups };
  return { ...rules, groups: groups.map((g, j) => (j === i ? withItem(g, item) : g)) };
}

/** A new group holding just `item`. */
export function newItemGroup(rules: YoutubeRules, item: GroupItem, name: string): YoutubeRules {
  if (!isBlocked(rules, item)) return rules;
  const groups = ungrouped(rules.groups, item);
  return { ...rules, groups: [...groups, groupOf([item], uniqueGroupName(groups, name))] };
}

/** The group `item` is in, if any. */
export function groupOfItem(rules: YoutubeRules, item: GroupItem): string | null {
  return rules.groups.find((g) => holds(g, item))?.name ?? null;
}

/** Everything in a group, tags first. */
export function groupItems(g: TagGroup): GroupItem[] {
  return itemsOf(g);
}

// The tag-only names, kept for the extension's options page and older callers.
export const groupTagWith = (rules: YoutubeRules, tag: string, onto: string) =>
  groupItemWith(rules, { kind: "tag", value: tag }, { kind: "tag", value: onto });
export const moveTagToGroup = (rules: YoutubeRules, tag: string, name: string | null) =>
  moveItemToGroup(rules, { kind: "tag", value: tag }, name);
export const newTagGroup = (rules: YoutubeRules, tag: string, name: string) => newItemGroup(rules, { kind: "tag", value: tag }, name);
export const groupOfTag = (rules: YoutubeRules, tag: string) => groupOfItem(rules, { kind: "tag", value: tag });

export function renameTagGroup(rules: YoutubeRules, name: string, to: string): YoutubeRules {
  const clean = to.trim().replace(/\s+/g, " ").slice(0, MAX_GROUP_NAME);
  if (!clean || clean === name) return rules;
  const others = rules.groups.filter((g) => g.name !== name);
  const unique = uniqueGroupName(others, clean);
  return { ...rules, groups: rules.groups.map((g) => (g.name === name ? { ...g, name: unique } : g)) };
}

/** Ends a group. `withTags` also stops blocking what is in it; otherwise it stays, ungrouped. */
export function removeTagGroup(rules: YoutubeRules, name: string, withTags: boolean): YoutubeRules {
  const group = rules.groups.find((g) => g.name === name);
  if (!group) return rules;
  const groups = rules.groups.filter((g) => g.name !== name);
  if (!withTags) return { ...rules, groups };
  const phrases = group.phrases ?? [];
  return {
    ...rules,
    groups,
    tags: rules.tags.filter((t) => !group.tags.includes(t)),
    keywords: rules.keywords.filter((k) => !phrases.includes(k)),
  };
}

function uniqueGroupName(groups: TagGroup[], wanted: string): string {
  const base = wanted.trim().slice(0, MAX_GROUP_NAME) || "Group";
  const taken = new Set(groups.map((g) => g.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Keeps only groups of tags and phrases that are blocked, each in one group, names unique. */
function cleanGroups(raw: unknown, tags: string[], keywords: string[]): TagGroup[] {
  if (!Array.isArray(raw)) return [];
  const seenTags = new Set<string>();
  const seenPhrases = new Set<string>();
  const pick = (v: unknown, norm: (s: string) => string | null, allowed: string[], seen: Set<string>) => {
    if (!Array.isArray(v)) return [];
    const out = [
      ...new Set(
        v
          .filter((t): t is string => typeof t === "string")
          .map(norm)
          .filter((t): t is string => !!t && allowed.includes(t) && !seen.has(t)),
      ),
    ];
    out.forEach((t) => seen.add(t));
    return out;
  };
  const out: TagGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const { name, tags: list, phrases } = g as { name?: unknown; tags?: unknown; phrases?: unknown };
    if (typeof name !== "string") continue;
    const groupTags = pick(list, normalizeTag, tags, seenTags);
    const groupPhrases = pick(phrases, normalizeKeyword, keywords, seenPhrases);
    if (groupTags.length + groupPhrases.length === 0) continue;
    out.push(tidy({ name: uniqueGroupName(out, name.trim().replace(/\s+/g, " ")), tags: groupTags, phrases: groupPhrases }));
  }
  return out;
}

/** Every entry, in the order shown in the list. */
export function youtubeEntries(rules: YoutubeRules): YoutubeEntry[] {
  return [
    ...rules.channels.map((value) => ({ kind: "channel" as const, value })),
    ...rules.tags.map((value) => ({ kind: "tag" as const, value })),
    ...rules.keywords.map((value) => ({ kind: "phrase" as const, value })),
  ];
}

/** How an entry or block reads to you: "@name", "#name" or the phrase itself. */
export function entryLabel(entry: YoutubeEntry): string {
  return entry.kind === "tag" ? `#${entry.value}` : entry.value;
}

export function blockLabel(block: YoutubeBlock): string {
  switch (block.reason) {
    case "shorts":
      return "Shorts";
    case "channel":
      return block.channel;
    case "tag":
      return block.group ? `#${block.tag} (${block.group})` : `#${block.tag}`;
    case "keyword":
      return block.group ? `${block.keyword} (${block.group})` : block.keyword;
  }
}

/** Whether a video carries this tag: in its tags, or as a #hashtag in `text` (title, description). */
export function tagMatches(tag: string, text: string, tags: readonly string[]): boolean {
  const squash = (t: string) => t.toLowerCase().replace(/^#/, "").replace(/[\s_-]+/g, "");
  const want = squash(tag);
  if (!want) return false;
  if (tags.some((t) => squash(t) === want)) return true;
  return [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].some((m) => squash(m[1] ?? "") === want);
}

/** A word or phrase to look for, or null if empty. */
export function normalizeKeyword(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  return s && s.length <= 100 ? s : null;
}

/**
 * Whether `text` contains `keyword` as whole words: "game" matches "Game night" and "#game" but
 * not "endgame" or "games". Case does not matter.
 */
export function keywordMatches(text: string, keyword: string): boolean {
  const k = keyword.trim();
  if (!k) return false;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** Blocks that can be decided from the address alone: Shorts and channel pages. */
export function youtubeUrlBlock(url: string, rules: YoutubeRules): YoutubeBlock | null {
  if (!isYoutubeUrl(url)) return null;
  const path = new URL(url).pathname;
  if (rules.blockShorts && /^\/shorts(\/|$)/i.test(path)) return { reason: "shorts" };
  const handle = /^\/(@[^/]+)/.exec(path)?.[1];
  const id = /^\/channel\/([^/]+)/.exec(path)?.[1];
  for (const key of [handle, id]) {
    if (!key) continue;
    const k = decodeURIComponent(key).toLowerCase();
    if (rules.channels.includes(k)) return { reason: "channel", channel: k };
  }
  return null;
}

/**
 * Blocks for a video: its channel, then its tags, then words in its title or tags. Also used for
 * the videos listed on YouTube's pages, where only the title and channel are known.
 */
export function youtubeVideoBlock(info: VideoInfo, rules: YoutubeRules): YoutubeBlock | null {
  const names = [info.channelHandle, info.channelId, info.channelName]
    .filter((n): n is string => !!n)
    .map((n) => n.trim().toLowerCase().replace(/\s+/g, " "));
  const channel = rules.channels.find((c) => names.includes(c));
  if (channel) return { reason: "channel", channel };
  const tag = rules.tags.find((t) => tagMatches(t, `${info.title}\n${info.description ?? ""}`, info.tags));
  if (tag) {
    const group = (rules.groups ?? []).find((g) => g.tags.includes(tag))?.name;
    return group ? { reason: "tag", tag, group } : { reason: "tag", tag };
  }
  const haystack = [info.title, ...info.tags].join("\n");
  const keyword = rules.keywords.find((k) => keywordMatches(haystack, k));
  if (!keyword) return null;
  const kGroup = (rules.groups ?? []).find((g) => (g.phrases ?? []).includes(keyword))?.name;
  return kGroup ? { reason: "keyword", keyword, group: kGroup } : { reason: "keyword", keyword };
}

/** Fills in anything missing from stored settings (older versions, or bad data). */
export function cleanYoutubeRules(raw: Partial<YoutubeRules> | undefined): YoutubeRules {
  const list = (v: unknown, norm: (s: string) => string | null) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map(norm).filter((x): x is string => !!x))] : [];
  const tags = list(raw?.tags, normalizeTag);
  const keywords = list(raw?.keywords, normalizeKeyword);
  return {
    blockShorts: typeof raw?.blockShorts === "boolean" ? raw.blockShorts : DEFAULT_YOUTUBE.blockShorts,
    hideComments: raw?.hideComments === true,
    hideRecommended: raw?.hideRecommended === true,
    hideHomeFeed: raw?.hideHomeFeed === true,
    channels: list(raw?.channels, normalizeChannel),
    tags,
    groups: cleanGroups(raw?.groups, tags, keywords),
    keywords,
    mode: raw?.mode === "block" ? "block" : "wait",
    waitSeconds: clampWait(raw?.waitSeconds ?? DEFAULT_YOUTUBE.waitSeconds),
    feed: raw?.feed === "hide" ? "hide" : "cover",
  };
}
