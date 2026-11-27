import { describe, expect, it } from "vitest";
import { clampWait, cleanRules, hostMatches, normalizeDomain, ruleFor, upsertRule, type BlockRule } from "./rules";

describe("normalizeDomain", () => {
  it("accepts what people paste", () => {
    expect(normalizeDomain("https://www.YouTube.com/watch?v=1")).toBe("youtube.com");
    expect(normalizeDomain("reddit.com/r/programming")).toBe("reddit.com");
    expect(normalizeDomain("*.example.org")).toBe("example.org");
    expect(normalizeDomain(" m.facebook.com:443 ")).toBe("m.facebook.com");
    expect(normalizeDomain("news.ycombinator.com.")).toBe("news.ycombinator.com");
  });

  it("refuses things that are not sites", () => {
    for (const bad of ["", "youtube", "hello world", "http://", "-bad.com", "a..b.com"]) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });
});

describe("matching", () => {
  const rules: BlockRule[] = [
    { domain: "google.com", mode: "wait", waitSeconds: 20 },
    { domain: "mail.google.com", mode: "block", waitSeconds: 20 },
    { domain: "youtube.com", mode: "block", waitSeconds: 20 },
  ];

  it("covers subdomains but not look-alikes", () => {
    expect(hostMatches("m.youtube.com", "youtube.com")).toBe(true);
    expect(hostMatches("notyoutube.com", "youtube.com")).toBe(false);
  });

  it("picks the most specific rule and ignores non-web pages", () => {
    expect(ruleFor("https://mail.google.com/u/0", rules)?.mode).toBe("block");
    expect(ruleFor("https://www.google.com/search?q=x", rules)?.mode).toBe("wait");
    expect(ruleFor("https://example.com", rules)).toBeNull();
    expect(ruleFor("about:blank", rules)).toBeNull();
    expect(ruleFor("moz-extension://abc/blocked.html", rules)).toBeNull();
  });
});

describe("editing", () => {
  it("replaces an existing rule and keeps the list sorted", () => {
    const a = upsertRule([], { domain: "zeta.com", mode: "wait", waitSeconds: 20 });
    const b = upsertRule(a, { domain: "alpha.com", mode: "block", waitSeconds: 20 });
    const c = upsertRule(b, { domain: "zeta.com", mode: "block", waitSeconds: 999_999 });
    expect(c.map((r) => r.domain)).toEqual(["alpha.com", "zeta.com"]);
    expect(c[1]).toEqual({ domain: "zeta.com", mode: "block", waitSeconds: 86_400 });
  });

  it("clamps wait lengths", () => {
    expect(clampWait(1)).toBe(3);
    expect(clampWait(Number.NaN)).toBe(20);
    expect(clampWait(45.4)).toBe(45);
  });
});

describe("cleanRules", () => {
  it("keeps good entries and drops the rest", () => {
    expect(
      cleanRules([
        { domain: "https://www.Reddit.com/r/x", mode: "block", waitSeconds: 5 },
        { domain: "not a site", mode: "wait", waitSeconds: 20 },
        { domain: "x.com", mode: "odd", waitSeconds: 999_999 },
        "junk",
        { domain: "reddit.com", mode: "wait", waitSeconds: 30 },
      ]),
    ).toEqual([
      { domain: "reddit.com", mode: "wait", waitSeconds: 30 },
      { domain: "x.com", mode: "wait", waitSeconds: 86_400 },
    ]);
    expect(cleanRules(null)).toEqual([]);
  });
});
