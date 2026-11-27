/**
 * Site blocking rules, shared by the Firefox extension (and later the Windows app's settings).
 * A rule names a site by its domain; it also covers every subdomain (youtube.com covers
 * www.youtube.com and m.youtube.com).
 */

export type BlockMode = "wait" | "block";

export interface BlockRule {
  /** Lower-case domain without "www.", e.g. "youtube.com". */
  domain: string;
  /** "wait" = a countdown, then you may continue; "block" = no way through. */
  mode: BlockMode;
  /** Countdown length for "wait", in seconds. */
  waitSeconds: number;
}

export const DEFAULT_WAIT_SECONDS = 20;
export const MIN_WAIT_SECONDS = 3;
/** A day: longer than any focus phase, so in practice no limit. */
export const MAX_WAIT_SECONDS = 86_400;

/**
 * Turns what someone typed or pasted ("https://www.YouTube.com/watch?v=1", "reddit.com/r/x",
 * "*.example.org") into a domain, or null if it is not a usable site name.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.replace(/^\*\./, ""); // wildcard
  s = s.split(/[/?#]/, 1)[0] ?? ""; // path, query, fragment
  s = s.replace(/^[^@]*@/, ""); // user info
  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/\.$/, ""); // trailing dot
  s = s.replace(/^www\d*\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  if (s.split(".").some((part) => !part || part.startsWith("-") || part.endsWith("-"))) return null;
  return s;
}

/** The host of a web address, or null for anything that is not http(s). */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** Whether `host` is `domain` or one of its subdomains. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The rule that applies to a web address (the most specific one wins), or null. */
export function ruleFor(url: string, rules: readonly BlockRule[]): BlockRule | null {
  const host = hostOf(url);
  if (!host) return null;
  let best: BlockRule | null = null;
  for (const r of rules) {
    if (hostMatches(host, r.domain) && (!best || r.domain.length > best.domain.length)) best = r;
  }
  return best;
}

/** Keeps a wait length in range; bad input gives the default. */
export function clampWait(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, Math.round(seconds)));
}

/** Adds or replaces the rule for a domain, keeping the list sorted by domain. */
export function upsertRule(rules: readonly BlockRule[], rule: BlockRule): BlockRule[] {
  const next = rules.filter((r) => r.domain !== rule.domain);
  next.push({ ...rule, waitSeconds: clampWait(rule.waitSeconds) });
  return next.sort((a, b) => a.domain.localeCompare(b.domain));
}

/** A list from storage or from the Focus app, with every entry checked (bad ones dropped, one per domain). */
export function cleanRules(raw: unknown): BlockRule[] {
  if (!Array.isArray(raw)) return [];
  let out: BlockRule[] = [];
  for (const r of raw as Partial<BlockRule>[]) {
    const domain = typeof r?.domain === "string" ? normalizeDomain(r.domain) : null;
    if (!domain) continue;
    out = upsertRule(out, { domain, mode: r.mode === "block" ? "block" : "wait", waitSeconds: Number(r.waitSeconds) });
  }
  return out;
}
