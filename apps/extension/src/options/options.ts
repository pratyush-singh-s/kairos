/** Options page: the list of sites, how each is blocked, the theme, and a test run. */
import {
  MAX_WAIT_SECONDS,
  MIN_WAIT_SECONDS,
  clampWait,
  addYoutubeEntry,
  entryLabel,
  normalizeDomain,
  parseYoutubeEntry,
  removeYoutubeEntry,
  upsertRule,
  youtubeEntries,
  type FeedMode,
  type BlockMode,
  type YoutubeRules,
} from "@focus/core";
import { applyTheme, formatLeft, isActive, load, save, type ExtState, type Message, type Theme } from "../state";
import { sendTagGroups } from "../link";
import { cleanAddress, phonePermission, type PairResult } from "../phone";
import { renderTagGroups } from "./tagGroups";
import { MAX_UNLOAD_MINUTES, MIN_UNLOAD_MINUTES, clampUnloadMinutes } from "../unload";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SUGGESTIONS = ["youtube.com", "instagram.com", "reddit.com", "x.com", "facebook.com", "netflix.com"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function modeSelect(mode: BlockMode, label: string): HTMLSelectElement {
  const select = el("select", { ariaLabel: label });
  select.append(el("option", { value: "wait", textContent: "Wait, then continue", selected: mode === "wait" }));
  select.append(el("option", { value: "block", textContent: "Full block", selected: mode === "block" }));
  return select;
}

/**
 * While the Kairos app manages the lists, they are shown here but changed on its Blocking page.
 * Tag groups are the exception: they can be changed here too while the app is open.
 */
function showManaged(managed: boolean, by: ExtState["managedBy"]): void {
  $("managed").hidden = !managed;
  $("managed-text").hidden = by === "phone";
  $("managed-phone-text").hidden = by !== "phone";
  for (const id of ["sites-panel", "yt-panel"]) {
    const panel = $(id);
    panel.dataset.managed = String(managed);
    for (const c of panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")) {
      if (!c.closest("#yt-tags")) c.disabled = managed;
    }
  }
  $<HTMLInputElement>("default-wait").disabled = managed;
  $<HTMLSelectElement>("theme").disabled = managed;
}

async function render(): Promise<void> {
  const s = await applyTheme();
  $<HTMLSelectElement>("theme").value = s.theme;
  $<HTMLInputElement>("default-wait").value = String(s.defaultWait);
  $<HTMLInputElement>("new-wait").value = String(s.defaultWait);
  $<HTMLInputElement>("unload-on").checked = s.unloadTabs.on;
  const unloadMin = $<HTMLInputElement>("unload-min");
  unloadMin.value = String(s.unloadTabs.minutes);
  unloadMin.min = String(MIN_UNLOAD_MINUTES);
  unloadMin.max = String(MAX_UNLOAD_MINUTES);
  unloadMin.disabled = !s.unloadTabs.on;

  const list = $("rules");
  list.replaceChildren();
  $("empty").hidden = s.rules.length > 0;
  for (const rule of s.rules) {
    const mode = modeSelect(rule.mode, `How ${rule.domain} is blocked`);
    const wait = el("input", {
      type: "number",
      min: String(MIN_WAIT_SECONDS),
      max: String(MAX_WAIT_SECONDS),
      value: String(rule.waitSeconds),
      ariaLabel: `Countdown for ${rule.domain}, in seconds`,
      disabled: rule.mode === "block",
      className: "seconds",
    });
    const remove = el("button", { type: "button", className: "button link", textContent: "Remove", ariaLabel: `Remove ${rule.domain}` });
    mode.addEventListener("change", () => void update(rule.domain, mode.value as BlockMode, Number(wait.value)));
    wait.addEventListener("change", () => void update(rule.domain, mode.value as BlockMode, Number(wait.value)));
    remove.addEventListener("click", async () => {
      const cur = await load();
      await save({ rules: cur.rules.filter((r) => r.domain !== rule.domain) });
      await render();
    });
    list.append(el("li", {}, el("span", { className: "domain", textContent: rule.domain }), mode, el("span", { className: "wait" }, wait, " s"), remove));
  }

  const chips = $("suggestions");
  chips.replaceChildren();
  for (const d of SUGGESTIONS.filter((d) => !s.rules.some((r) => r.domain === d))) {
    const chip = el("button", { type: "button", className: "chip", textContent: `+ ${d}` });
    chip.addEventListener("click", () => void add(d, "wait", s.defaultWait));
    chips.append(chip);
  }

  renderYoutube(s);
  showManaged(s.managed, s.managedBy);
  renderPhone(s);
  showSession(s);
}

const SOURCE_NAMES = { app: "the Kairos app", phone: "your phone", timer: "the focus timer" } as const;

function showSession(s: ExtState): void {
  const on = isActive(s);
  $("session").textContent = on
    ? `Blocking is on now, from ${SOURCE_NAMES[s.session!.source]} · ${formatLeft(s.session!.until - Date.now())} left`
    : "Blocking is off now.";
}

function renderPhone(s: ExtState): void {
  $("phone-unlinked").hidden = !!s.phone;
  $("phone-linked").hidden = !s.phone;
  if (!s.phone) return;
  $("phone-name").textContent = s.phone.name;
  $("phone-state").textContent = s.phoneStatus.connected
    ? `linked at ${s.phone.address}${s.phoneStatus.appVersion ? ` · Kairos ${s.phoneStatus.appVersion}` : ""}`
    : `not reachable at ${s.phone.address}. Is it on the same Wi-Fi? If its address changed, unlink and link again.`;
}

const PAIR_ERRORS: Record<Exclude<PairResult, "linked">, string> = {
  "bad-code": "That code didn't work. Codes last 5 minutes; get a new one on the phone and try again.",
  "no-answer": "The phone didn't answer. Check the address, that both are on the same Wi-Fi, and that the Link a browser screen is open.",
  "old-phone": "This phone's Kairos app is too old to link a browser. Update it first.",
};

const YT_ORIGINS = { origins: ["*://*.youtube.com/*"] };

function renderYoutube(s: ExtState): void {
  const yt = s.youtube;
  $<HTMLInputElement>("yt-shorts").checked = yt.blockShorts;
  $<HTMLInputElement>("yt-comments").checked = yt.hideComments;
  $<HTMLInputElement>("yt-recommended").checked = yt.hideRecommended;
  $<HTMLInputElement>("yt-home").checked = yt.hideHomeFeed;
  $<HTMLSelectElement>("yt-mode").value = yt.mode;
  const wait = $<HTMLInputElement>("yt-wait");
  wait.value = String(yt.waitSeconds);
  wait.disabled = yt.mode === "block";
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="yt-feed"]')) r.checked = r.value === yt.feed;
  const list = $("yt-entries");
  list.replaceChildren();
  // Tags are listed by group below; channels and phrases here.
  const entries = youtubeEntries(yt).filter((e) => e.kind !== "tag");
  if (entries.length === 0 && yt.tags.length === 0) list.append(el("li", { className: "muted" }, "Nothing yet."));
  for (const entry of entries) {
    const label = entryLabel(entry);
    const remove = el("button", { type: "button", className: "button link", textContent: "Remove", ariaLabel: `Remove ${label}` });
    remove.addEventListener("click", () => void saveYoutube((cur) => removeYoutubeEntry(cur, entry)));
    list.append(
      el("li", {}, el("span", { className: "domain" }, el("span", { className: `kind kind-${entry.kind}`, textContent: KIND_NAMES[entry.kind] }), label), remove),
    );
  }
  // Groups change here even while the app manages the lists: it saves them for every browser.
  const canGroup = !s.managed || (s.managedBy === "app" && s.link.connected);
  renderTagGroups($("yt-tags"), yt, canGroup, {
    change: (next) => void saveGroups(next),
    remove: s.managed ? null : (tag) => void saveYoutube((cur) => removeYoutubeEntry(cur, { kind: "tag", value: tag })),
  });
  $("yt-groups-note").textContent =
    yt.tags.length > 0 && !canGroup ? "Open the Kairos app to group tags here, or group them on its Blocking page." : "";
  void browser.permissions.contains(YT_ORIGINS).then((ok) => {
    $("yt-permission").hidden = ok;
  });
}

const KIND_NAMES = { channel: "channel", tag: "tag", phrase: "phrase" } as const;

async function saveYoutube(change: (yt: YoutubeRules) => Partial<YoutubeRules>): Promise<void> {
  const s = await load();
  await save({ youtube: { ...s.youtube, ...change(s.youtube) } });
  await render();
}

/** Saves new tag groups: in the app while it manages the lists (it sends them back), else here. */
async function saveGroups(next: (yt: YoutubeRules) => YoutubeRules): Promise<void> {
  const s = await load();
  const yt = next(s.youtube);
  const note = $("yt-groups-note");
  note.textContent = "";
  if (s.managed) {
    const sent = await sendTagGroups(yt.groups);
    if (sent !== "saved") {
      await render();
      note.textContent =
        sent === "old-app"
          ? "To group tags here, update the Kairos app to 0.21.4 or newer. You can also group them on its Blocking page."
          : "The Kairos app didn't answer. Open it, then try again.";
      return;
    }
  }
  await save({ youtube: { ...s.youtube, groups: yt.groups } });
  await render();
}

async function update(domain: string, mode: BlockMode, waitSeconds: number): Promise<void> {
  const s = await load();
  await save({ rules: upsertRule(s.rules, { domain, mode, waitSeconds: clampWait(waitSeconds) }) });
  await render();
}

async function add(input: string, mode: BlockMode, waitSeconds: number): Promise<boolean> {
  const domain = normalizeDomain(input);
  const error = $("add-error");
  if (!domain) {
    error.textContent = `"${input}" doesn't look like a website. Try something like youtube.com.`;
    return false;
  }
  error.textContent = "";
  await update(domain, mode, waitSeconds);
  return true;
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("new-site");
  const mode = $<HTMLSelectElement>("new-mode").value as BlockMode;
  if (await add(input.value, mode, Number($<HTMLInputElement>("new-wait").value))) input.value = "";
  input.focus();
});
$("yt-shorts").addEventListener("change", () => {
  void saveYoutube(() => ({ blockShorts: $<HTMLInputElement>("yt-shorts").checked }));
});
for (const [id, key] of [["yt-comments", "hideComments"], ["yt-recommended", "hideRecommended"], ["yt-home", "hideHomeFeed"]] as const) {
  $(id).addEventListener("change", () => {
    void saveYoutube(() => ({ [key]: $<HTMLInputElement>(id).checked }));
  });
}
$("yt-mode").addEventListener("change", () => {
  void saveYoutube(() => ({ mode: $<HTMLSelectElement>("yt-mode").value as BlockMode }));
});
$("yt-wait").addEventListener("change", () => {
  void saveYoutube(() => ({ waitSeconds: clampWait(Number($<HTMLInputElement>("yt-wait").value)) }));
});
// Says what the box will block while you type, so "@", "#" and plain words are clear.
$("yt-entry").addEventListener("input", () => {
  const entry = parseYoutubeEntry($<HTMLInputElement>("yt-entry").value);
  $("yt-entry-kind").textContent = entry
    ? entry.kind === "channel"
      ? `Blocks the channel ${entry.value}`
      : entry.kind === "tag"
        ? `Blocks videos tagged #${entry.value}`
        : `Blocks videos with "${entry.value}" in the title or tags`
    : "";
});
$("yt-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("yt-entry");
  const entry = parseYoutubeEntry(input.value);
  if (!entry) return;
  input.value = "";
  $("yt-entry-kind").textContent = "";
  void saveYoutube((yt) => addYoutubeEntry(yt, entry));
});
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="yt-feed"]')) {
  r.addEventListener("change", () => void saveYoutube(() => ({ feed: r.value as FeedMode })));
}
$("yt-allow").addEventListener("click", () => {
  // Must be asked straight from the click, before anything else is awaited.
  void browser.permissions.request(YT_ORIGINS).then(() => render());
});
$("new-mode").addEventListener("change", () => {
  $<HTMLInputElement>("new-wait").disabled = $<HTMLSelectElement>("new-mode").value === "block";
});
$("theme").addEventListener("change", async () => {
  await save({ theme: $<HTMLSelectElement>("theme").value as Theme });
  await render();
});
$("default-wait").addEventListener("change", async () => {
  await save({ defaultWait: clampWait(Number($<HTMLInputElement>("default-wait").value)) });
  await render();
});
async function saveUnload(): Promise<void> {
  const on = $<HTMLInputElement>("unload-on").checked;
  const minutes = clampUnloadMinutes(Number($<HTMLInputElement>("unload-min").value));
  await save({ unloadTabs: { on, minutes } });
  await render();
}
$("unload-on").addEventListener("change", () => void saveUnload());
$("unload-min").addEventListener("change", () => void saveUnload());
$("pair").addEventListener("click", () => {
  const error = $("pair-error");
  const address = cleanAddress($<HTMLInputElement>("pair-address").value);
  const code = $<HTMLInputElement>("pair-code").value.replace(/\D/g, "");
  if (!address) {
    error.textContent = "Type the address the phone shows, like 192.168.1.23.";
    return;
  }
  if (code.length !== 6) {
    error.textContent = "The code has 6 digits.";
    return;
  }
  error.textContent = "Linking…";
  // Asked straight from the click, as Firefox requires: the right to talk to this address.
  void browser.permissions.request(phonePermission(address)).then(async (granted) => {
    if (!granted) {
      error.textContent = "Kairos Blocker needs your OK to talk to the phone. Press Link again and allow it.";
      return;
    }
    const msg: Message = { kind: "phonePair", address, code };
    const { result } = (await browser.runtime.sendMessage(msg)) as { result: PairResult };
    error.textContent = result === "linked" ? "" : PAIR_ERRORS[result];
    if (result === "linked") $<HTMLInputElement>("pair-code").value = "";
    await render();
  });
});
$("phone-unlink").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ kind: "phoneUnlink" } satisfies Message);
  await render();
});
browser.storage.onChanged.addListener((changes) => {
  // New lists from the app or phone show at once, unless you are typing in a box.
  const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type === "text";
  if ((changes.rules || changes.youtube || changes.theme || changes.defaultWait || changes.managed) && !typing) void render();
  else if (changes.phone || changes.phoneStatus || changes.managedBy) void load().then((s) => (renderPhone(s), showManaged(s.managed, s.managedBy)));
});

void render();
browser.permissions.onAdded.addListener(() => void render());
browser.permissions.onRemoved.addListener(() => void render());
window.setInterval(() => {
  // Refresh only the session line; re-rendering the list would interrupt typing.
  void load().then(showSession);
}, 1000);
