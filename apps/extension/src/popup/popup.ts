/** Toolbar popup: is blocking on, the focus timer, the current site's rule, quick actions. */
import { hostOf, normalizeDomain, ruleFor, upsertRule, type BlockMode } from "@focus/core";
import { applyTheme, formatLeft, isActive, load, save, type ExtState, type Message } from "../state";
import { TIMER_PRESETS, cleanPrefs, phaseLabel, timeLeft, type TimerPrefs } from "../timer";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const YT_ACCESS = { origins: ["*://*.youtube.com/*"] };

async function render(): Promise<void> {
  const s = await applyTheme();
  $("version").textContent = browser.runtime.getManifest().version;

  const on = isActive(s);
  const status = $("status");
  status.dataset.on = String(on);
  const source = on ? s.session!.source : null;
  const left = on ? formatLeft(s.session!.until - Date.now()) : "";
  $("status-text").textContent = !on
    ? s.timer?.phase === "break"
      ? "Blocking is off · break"
      : "Blocking is off"
    : source === "app"
      ? s.link.paused
        ? "Blocking is on · focus paused"
        : `Blocking is on · ${left} of focus left`
      : source === "phone"
        ? s.phoneStatus.paused
          ? "Blocking is on · focus paused on your phone"
          : `Blocking is on · ${left} left (phone)`
        : s.timer?.pausedAt != null
          ? "Blocking is on · timer paused"
          : `Blocking is on · ${left} of focus left`;
  const link = $("link");
  link.dataset.on = String(s.link.connected);
  link.textContent = s.link.connected
    ? `Linked to the Kairos app${s.link.appVersion ? ` ${s.link.appVersion}` : ""}`
    : "Kairos app not on this PC (or closed)";
  const phone = $("phone-link");
  phone.hidden = !s.phone;
  phone.dataset.on = String(s.phoneStatus.connected);
  if (s.phone) phone.textContent = s.phoneStatus.connected ? `Linked to ${s.phone.name}` : `${s.phone.name} not reachable (same Wi-Fi?)`;
  $("hint").textContent =
    source === "app"
      ? "Blocking follows your Focus session. It stops on breaks and when the session ends."
      : source === "phone"
        ? "Blocking follows the focus session on your phone."
        : "";
  renderTimer(s, source === "app" || source === "phone");
  const yt = s.youtube;
  const needsAccess = yt.channels.length + yt.tags.length + yt.keywords.length > 0;
  $("yt-access").hidden = !needsAccess || (await browser.permissions.contains(YT_ACCESS));

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const host = tab?.url ? hostOf(tab.url) : null;
  const domain = host ? normalizeDomain(host) : null;
  const site = $("site");
  if (!domain || !tab?.url) {
    site.hidden = true;
    return;
  }
  site.hidden = false;
  $("site-name").textContent = domain;
  const rule = ruleFor(tab.url, s.rules);
  $("site-rule").textContent = rule
    ? rule.mode === "block"
      ? `Fully blocked${rule.domain !== domain ? ` (via ${rule.domain})` : ""}`
      : `Wait ${rule.waitSeconds}s${rule.domain !== domain ? ` (via ${rule.domain})` : ""}`
    : "Not on your list";
  $("remove").hidden = !rule || rule.domain !== domain;
  for (const id of ["add-wait", "add-block"]) $(id).dataset.current = "false";
  if (rule && rule.domain === domain) $(rule.mode === "block" ? "add-block" : "add-wait").dataset.current = "true";
  $("add-wait").textContent = `Wait ${s.defaultWait}s`;
}

async function setRule(mode: BlockMode | null): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const host = tab?.url ? hostOf(tab.url) : null;
  const domain = host ? normalizeDomain(host) : null;
  if (!domain) return;
  const s = await load();
  const existing = s.rules.find((r) => r.domain === domain);
  const rules =
    mode === null
      ? s.rules.filter((r) => r.domain !== domain)
      : upsertRule(s.rules, { domain, mode, waitSeconds: existing?.waitSeconds ?? s.defaultWait });
  await save({ rules });
  await render();
}

$("add-wait").addEventListener("click", () => void setRule("wait"));
$("add-block").addEventListener("click", () => void setRule("block"));
$("remove").addEventListener("click", () => void setRule(null));
$("options").addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
  window.close();
});
/* The focus timer. */

let presetsShown = "";

function renderTimer(s: ExtState, otherInCharge: boolean): void {
  const t = s.timer;
  $("timer").dataset.phase = t?.phase ?? "idle";
  $("timer-idle").hidden = !!t;
  $("timer-running").hidden = !t;
  $("t-note").textContent = otherInCharge
    ? t
      ? "The Kairos app or phone is running focus now, so it's in charge until it stops."
      : "The Kairos app or phone is running focus now. You can start this timer when it stops."
    : "";
  $<HTMLButtonElement>("t-start").disabled = otherInCharge;
  if (t) {
    $("t-left").textContent = formatLeft(timeLeft(t));
    $("t-phase").textContent = phaseLabel(t) + (t.pausedAt !== null ? " · paused (sites stay blocked)" : "");
    const pause = $<HTMLButtonElement>("t-pause");
    pause.textContent = t.pausedAt !== null ? "Resume" : "Pause";
    pause.hidden = t.phase === "break";
    $("t-skip").textContent = t.phase === "break" ? "Skip break" : "Skip";
    return;
  }
  // Filled once per opening, so typing in the boxes isn't undone every second.
  const key = JSON.stringify(s.timerPrefs);
  if (presetsShown === key) return;
  presetsShown = key;
  fillPrefs(s.timerPrefs);
}

function fillPrefs(p: TimerPrefs): void {
  $<HTMLInputElement>("t-focus").value = String(p.focusMin);
  $<HTMLInputElement>("t-break").value = String(p.breakMin);
  $<HTMLInputElement>("t-rounds").value = String(p.rounds);
  const chips = $("presets");
  chips.replaceChildren();
  for (const preset of TIMER_PRESETS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = preset.rounds > 1 ? `${preset.focusMin} / ${preset.breakMin} × ${preset.rounds}` : `${preset.focusMin} min`;
    chip.dataset.current = String(JSON.stringify(preset) === JSON.stringify(p));
    chip.addEventListener("click", () => fillPrefs(preset));
    chips.append(chip);
  }
}

function typedPrefs(): TimerPrefs {
  return cleanPrefs({
    focusMin: Number($<HTMLInputElement>("t-focus").value),
    breakMin: Number($<HTMLInputElement>("t-break").value),
    rounds: Number($<HTMLInputElement>("t-rounds").value),
  });
}

async function send(msg: Message): Promise<void> {
  await browser.runtime.sendMessage(msg);
  await render();
}

for (const id of ["t-focus", "t-break", "t-rounds"]) {
  $(id).addEventListener("input", () => {
    for (const chip of $("presets").querySelectorAll<HTMLElement>(".chip")) chip.dataset.current = "false";
  });
}
$("t-start").addEventListener("click", () => void send({ kind: "timerStart", prefs: typedPrefs() }));
$("t-pause").addEventListener("click", async () => {
  const s = await load();
  await send({ kind: s.timer?.pausedAt != null ? "timerResume" : "timerPause" });
});
$("t-skip").addEventListener("click", () => void send({ kind: "timerSkip" }));
$("t-stop").addEventListener("click", () => {
  presetsShown = "";
  void send({ kind: "timerStop" });
});

void render();
window.setInterval(() => void render(), 1000);

$("yt-allow").addEventListener("click", () => {
  // Asked straight from the click, as Firefox requires.
  void browser.permissions.request(YT_ACCESS).then(() => render());
});
