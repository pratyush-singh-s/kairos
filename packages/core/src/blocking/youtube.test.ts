import { describe, expect, it } from "vitest";
import {
  DEFAULT_YOUTUBE,
  groupItemWith,
  moveItemToGroup,
  groupTagWith,
  moveTagToGroup,
  renameTagGroup,
  removeTagGroup,
  cleanYoutubeRules,
  isYoutubeUrl,
  keywordMatches,
  normalizeChannel,
  normalizeKeyword,
  parseYoutubeEntry,
  addYoutubeEntry,
  removeYoutubeEntry,
  youtubeEntries,
  tagMatches,
  blockLabel,
  youtubeUrlBlock,
  youtubeVideoBlock,
  type VideoInfo,
  type YoutubeRules,
} from "./youtube";

const rules: YoutubeRules = { ...DEFAULT_YOUTUBE, channels: ["@mkbhd", "ucbjycsmduvyeataddl7xdg", "linus tech tips"], tags: ["gaming"], keywords: ["minecraft", "true crime"] };
const video = (over: Partial<VideoInfo>): VideoInfo => ({ videoId: "abc", title: "Learning Rust", tags: [], ...over });

describe("normalizeChannel", () => {
  it("accepts handles, ids, names and links", () => {
    expect(normalizeChannel("https://www.youtube.com/@MKBHD/videos")).toBe("@mkbhd");
    expect(normalizeChannel("youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ")).toBe("ucbjycsmduvyel83r_u4jriq");
    expect(normalizeChannel(" @Veritasium ")).toBe("@veritasium");
    expect(normalizeChannel("Linus  Tech Tips")).toBe("linus tech tips");
    expect(normalizeChannel("https://m.youtube.com/@caf%C3%A9")).toBe("@café");
  });
  it("refuses empty input and links that are not channels", () => {
    expect(normalizeChannel("  ")).toBeNull();
    expect(normalizeChannel("@")).toBeNull();
    expect(normalizeChannel("https://www.youtube.com/watch?v=1")).toBeNull();
  });
});

describe("keywordMatches", () => {
  it("matches whole words, any case", () => {
    expect(keywordMatches("MINECRAFT Hardcore day 100", "minecraft")).toBe(true);
    expect(keywordMatches("#minecraft", "minecraft")).toBe(true);
    expect(keywordMatches("A true   crime story", "true crime")).toBe(true);
    expect(keywordMatches("minecrafter", "minecraft")).toBe(false);
    expect(keywordMatches("untrue crime", "true crime")).toBe(false);
  });
  it("treats special characters literally", () => {
    expect(keywordMatches("Learn C++ fast", "c++")).toBe(true);
    expect(keywordMatches("cxx", "c++")).toBe(false);
  });
  it("ignores empty keywords", () => {
    expect(keywordMatches("anything", " ")).toBe(false);
    expect(normalizeKeyword("  ")).toBeNull();
  });
});

describe("youtubeUrlBlock", () => {
  it("blocks Shorts only when chosen", () => {
    expect(youtubeUrlBlock("https://www.youtube.com/shorts/xyz", rules)).toEqual({ reason: "shorts" });
    expect(youtubeUrlBlock("https://m.youtube.com/shorts/xyz", rules)).toEqual({ reason: "shorts" });
    expect(youtubeUrlBlock("https://www.youtube.com/shorts/xyz", { ...rules, blockShorts: false })).toBeNull();
  });
  it("blocks pages of blocked channels", () => {
    expect(youtubeUrlBlock("https://www.youtube.com/@MKBHD/videos", rules)).toEqual({ reason: "channel", channel: "@mkbhd" });
    expect(youtubeUrlBlock("https://www.youtube.com/channel/UCBJycsmduvYEataddL7xdg", rules)?.reason).toBe("channel");
    expect(youtubeUrlBlock("https://www.youtube.com/@veritasium", rules)).toBeNull();
  });
  it("leaves the rest of YouTube and other sites alone", () => {
    expect(youtubeUrlBlock("https://www.youtube.com/watch?v=1", rules)).toBeNull();
    expect(youtubeUrlBlock("https://example.com/shorts/1", rules)).toBeNull();
    expect(isYoutubeUrl("https://notyoutube.com/")).toBe(false);
  });
});

describe("youtubeVideoBlock", () => {
  it("blocks by channel handle, id or name", () => {
    expect(youtubeVideoBlock(video({ channelHandle: "@MKBHD" }), rules)).toEqual({ reason: "channel", channel: "@mkbhd" });
    expect(youtubeVideoBlock(video({ channelId: "UCBJycsmduvYEataddL7xdg" }), rules)?.reason).toBe("channel");
    expect(youtubeVideoBlock(video({ channelName: "Linus Tech Tips" }), rules)?.reason).toBe("channel");
  });
  it("blocks by words in the title or tags", () => {
    expect(youtubeVideoBlock(video({ title: "Minecraft but…" }), rules)).toEqual({ reason: "keyword", keyword: "minecraft" });
    expect(youtubeVideoBlock(video({ tags: ["documentary", "True Crime"] }), rules)).toEqual({ reason: "keyword", keyword: "true crime" });
  });
  it("lets other videos play", () => {
    expect(youtubeVideoBlock(video({ channelHandle: "@veritasium", tags: ["physics"] }), rules)).toBeNull();
  });
});

describe("cleanYoutubeRules", () => {
  it("fills in defaults and drops bad data", () => {
    expect(cleanYoutubeRules(undefined)).toEqual(DEFAULT_YOUTUBE);
    expect(cleanYoutubeRules({ tags: ["#Gaming"], feed: "hide" })).toMatchObject({ tags: ["gaming"], feed: "hide" });
    const c = cleanYoutubeRules({ channels: ["@A", "@a", 3 as never, ""], keywords: [" Game "], mode: "x" as never, waitSeconds: 999_999 });
    expect(c.channels).toEqual(["@a"]);
    expect(c.keywords).toEqual(["game"]);
    expect(c.mode).toBe("wait");
    expect(c.waitSeconds).toBe(86_400);
  });
});

describe("the block box", () => {
  it("tells channels, tags and phrases apart", () => {
    expect(parseYoutubeEntry("@MrBeast")).toEqual({ kind: "channel", value: "@mrbeast" });
    expect(parseYoutubeEntry("https://youtube.com/@MrBeast/shorts")).toEqual({ kind: "channel", value: "@mrbeast" });
    expect(parseYoutubeEntry("UCX6OQ3DkcsbYNE6H8uQQuVA")).toEqual({ kind: "channel", value: "ucx6oq3dkcsbyne6h8uqquva" });
    expect(parseYoutubeEntry("#Gaming")).toEqual({ kind: "tag", value: "gaming" });
    expect(parseYoutubeEntry("  Minecraft  Hardcore ")).toEqual({ kind: "phrase", value: "minecraft hardcore" });
    expect(parseYoutubeEntry("#")).toBeNull();
    expect(parseYoutubeEntry("   ")).toBeNull();
  });
  it("adds without duplicates and removes", () => {
    let r = addYoutubeEntry(DEFAULT_YOUTUBE, { kind: "tag", value: "gaming" });
    r = addYoutubeEntry(r, { kind: "tag", value: "gaming" });
    r = addYoutubeEntry(r, { kind: "channel", value: "@a" });
    expect(youtubeEntries(r)).toEqual([{ kind: "channel", value: "@a" }, { kind: "tag", value: "gaming" }]);
    expect(removeYoutubeEntry(r, { kind: "tag", value: "gaming" }).tags).toEqual([]);
  });
});

describe("tags", () => {
  it("match video tags and #hashtags in titles, ignoring case and spaces", () => {
    expect(tagMatches("gaming", "Video", ["Gaming"])).toBe(true);
    expect(tagMatches("minecraftshorts", "Video", ["Minecraft Shorts"])).toBe(true);
    expect(tagMatches("gaming", "Best clips #Gaming #fun", [])).toBe(true);
    expect(tagMatches("gaming", "Gaming chair review", [])).toBe(false);
    expect(tagMatches("gaming", "Video", ["pc gaming"])).toBe(false);
  });
  it("count #hashtags in the description", () => {
    const desc = "15,583 views\nIn this video we cover the creation of our beast.\n#steamnextfest #horrorgame #devlog #indiegame";
    expect(youtubeVideoBlock(video({ title: "We Made Godot's Smartest Monster", description: desc }), { ...rules, tags: ["devlog"] })).toEqual({ reason: "tag", tag: "devlog" });
    expect(youtubeVideoBlock(video({ title: "We Made Godot's Smartest Monster", description: "a devlog without hashtag" }), { ...rules, tags: ["devlog"], keywords: [] })).toBeNull();
  });
  it("block videos and read as #tag", () => {
    const b = youtubeVideoBlock(video({ title: "Clips #gaming" }), rules);
    expect(b).toEqual({ reason: "tag", tag: "gaming" });
    expect(blockLabel(b!)).toBe("#gaming");
  });
});

describe("tag groups", () => {
  const base = (tags: string[]) => cleanYoutubeRules({ tags });

  it("dropping one tag on another makes a group named after the target", () => {
    const r = groupTagWith(base(["gaming", "sologaming", "music"]), "sologaming", "gaming");
    expect(r.groups).toEqual([{ name: "gaming", tags: ["gaming", "sologaming"] }]);
    expect(r.tags).toEqual(["gaming", "sologaming", "music"]);
  });

  it("dropping on a grouped tag joins its group, leaving the old one", () => {
    let r = groupTagWith(base(["a", "b", "c", "d"]), "b", "a");
    r = groupTagWith(r, "d", "c");
    r = groupTagWith(r, "d", "b");
    expect(r.groups).toEqual([
      { name: "a", tags: ["a", "b", "d"] },
      { name: "c", tags: ["c"] },
    ]);
  });

  it("renames, ungroups and removes", () => {
    let r = groupTagWith(base(["gaming", "sologaming"]), "sologaming", "gaming");
    r = renameTagGroup(r, "gaming", "  Gaming  ");
    expect(r.groups[0]!.name).toBe("Gaming");
    r = moveTagToGroup(r, "sologaming", null);
    expect(r.groups).toEqual([{ name: "Gaming", tags: ["gaming"] }]);
    expect(removeTagGroup(r, "Gaming", false).tags).toEqual(["gaming", "sologaming"]);
    expect(removeTagGroup(r, "Gaming", true).tags).toEqual(["sologaming"]);
  });

  it("removing a tag takes it out of its group, and empty groups go", () => {
    const r = groupTagWith(base(["a", "b"]), "b", "a");
    const once = removeYoutubeEntry(r, { kind: "tag", value: "a" });
    expect(once.groups).toEqual([{ name: "a", tags: ["b"] }]);
    expect(removeYoutubeEntry(once, { kind: "tag", value: "b" }).groups).toEqual([]);
  });

  it("cleaning drops unknown tags, repeats and bad groups, and keeps names unique", () => {
    const r = cleanYoutubeRules({
      tags: ["a", "b", "c"],
      groups: [{ name: "X", tags: ["a", "zzz"] }, { name: "x", tags: ["a", "b"] }, { name: "Y" } as never, "junk" as never],
    });
    expect(r.groups).toEqual([
      { name: "X", tags: ["a"] },
      { name: "x 2", tags: ["b"] },
    ]);
  });

  it("names the group when a tag in it blocks a video", () => {
    const r = groupTagWith(base(["gaming", "sologaming"]), "sologaming", "gaming");
    const block = youtubeVideoBlock({ videoId: "v", title: "Late night #sologaming", tags: [] }, r);
    expect(block && blockLabel(block)).toBe("#sologaming (gaming)");
  });
});

describe("phrase groups", () => {
  const tag = (value: string) => ({ kind: "tag" as const, value });
  const phrase = (value: string) => ({ kind: "phrase" as const, value });
  const rules = () => cleanYoutubeRules({ tags: ["gaming"], keywords: ["minecraft", "mods"] });

  it("a phrase can join a tag's group, and phrases can group together", () => {
    let r = groupItemWith(rules(), phrase("minecraft"), tag("gaming"));
    expect(r.groups).toEqual([{ name: "gaming", tags: ["gaming"], phrases: ["minecraft"] }]);
    r = groupItemWith(r, phrase("mods"), phrase("minecraft"));
    expect(r.groups[0]!.phrases).toEqual(["minecraft", "mods"]);
    r = moveItemToGroup(r, phrase("mods"), null);
    expect(r.groups[0]!.phrases).toEqual(["minecraft"]);
  });

  it("blocks say which group a phrase is in, and removing the phrase leaves the group", () => {
    const r = groupItemWith(rules(), phrase("minecraft"), tag("gaming"));
    const block = youtubeVideoBlock({ videoId: "x", title: "Minecraft, but the FBI", tags: [] }, r);
    expect(block && blockLabel(block)).toBe("minecraft (gaming)");
    expect(removeYoutubeEntry(r, phrase("minecraft")).groups).toEqual([{ name: "gaming", tags: ["gaming"] }]);
  });

  it("stored groups keep their phrases only while the phrases are blocked", () => {
    const r = cleanYoutubeRules({ keywords: ["mods"], groups: [{ name: "G", tags: [], phrases: ["mods", "gone"] }] });
    expect(r.groups).toEqual([{ name: "G", tags: [], phrases: ["mods"] }]);
  });
});
