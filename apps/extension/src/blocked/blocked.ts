/**
 * The page shown instead of a listed site or a blocked YouTube page. "Wait" counts down (only
 * while you are looking at this tab), then offers Continue; "Full block" offers no way through.
 */
import { hostOf, ruleFor, type BlockMode } from "@focus/core";
import { applyTheme, formatLeft, isActive, youtubePassKey, type Message } from "../state";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  const s = await applyTheme();
  const params = new URLSearchParams(location.search);
  const url = params.get("u") ?? "";
  const host = hostOf(url) ?? "this site";
  const yt = params.get("yt");
  const why = params.get("why") ?? "";
  const rule = ruleFor(url, s.rules);
  $("site").textContent = host.replace(/^www\./, "");
  document.title = `Blocked: ${host}`;

  $("close").addEventListener("click", () => {
    void browser.runtime.sendMessage({ kind: "goBack", url } satisfies Message);
  });

  // What blocked it: a site on your list, or one of the YouTube choices.
  let block: { mode: BlockMode; waitSeconds: number; pass: Message | null; reason: string } | null = null;
  if (rule) {
    block = { mode: rule.mode, waitSeconds: rule.waitSeconds, pass: { kind: "pass", domain: rule.domain }, reason: "" };
  } else if (yt) {
    const reason =
      yt === "shorts"
        ? "You chose to block YouTube Shorts while you focus."
        : yt === "channel"
          ? `This is from a channel you blocked: ${why}.`
          : yt === "tag"
            ? `This video is tagged #${why}, which you blocked.`
            : `This video is about something you blocked: "${why}".`;
    const stillBlocked =
      yt === "shorts"
        ? s.youtube.blockShorts
        : yt === "channel"
          ? s.youtube.channels.includes(why)
          : yt === "tag"
            ? s.youtube.tags.includes(why)
            : s.youtube.keywords.includes(why);
    if (stillBlocked) {
      block = { mode: s.youtube.mode, waitSeconds: s.youtube.waitSeconds, pass: { kind: "ytPass", key: youtubePassKey(url) }, reason };
    }
    $("site").textContent = yt === "shorts" ? "YouTube Shorts" : "YouTube";
  }

  // The session ended (or the block was removed) while this page was open.
  if (!isActive(s) || !block) {
    $("title").textContent = "Focus session is over";
    $("message").textContent = "This isn't blocked any more.";
    showContinue(url, null);
    return;
  }

  if (s.session) $("left").textContent = `Focus session: ${formatLeft(s.session.until - Date.now())} left`;

  if (block.mode === "block") {
    $("title").textContent = "Blocked during focus";
    $("message").textContent = block.reason || "You chose to fully block this site while you focus.";
    document.body.dataset.mode = "block";
    return;
  }

  $("title").textContent = "Take a breath";
  $("message").textContent = `${block.reason ? `${block.reason} ` : ""}Do you really need this right now? You can continue when the countdown ends.`;
  document.body.dataset.mode = "wait";
  const pass = block.pass;
  const total = block.waitSeconds * 1000;
  let remaining = total;
  let last = performance.now();
  const bar = $("bar");
  const count = $("count");
  const tick = (t: number) => {
    // Counts down only while this tab is visible, so you can't wait it out in another tab.
    if (document.visibilityState === "visible") remaining -= t - last;
    last = t;
    const left = Math.max(0, remaining);
    count.textContent = String(Math.ceil(left / 1000));
    bar.style.width = `${(1 - left / total) * 100}%`;
    if (left > 0) requestAnimationFrame(tick);
    else showContinue(url, pass);
  };
  requestAnimationFrame(tick);
}

/** Ready-made answers to "Why are you here?"; you can also type your own. */
const REASONS = ["Need it for work", "Quick check", "Bored", "Habit", "Taking a break"];

function showContinue(url: string, pass: Message | null): void {
  const btn = $<HTMLButtonElement>("continue");
  btn.hidden = false;
  // During focus, a reason is asked before you go through.
  const asking = pass !== null && (pass.kind === "pass" || pass.kind === "ytPass");
  const input = $<HTMLInputElement>("reason");
  if (asking) {
    const form = $<HTMLFormElement>("reason-form");
    form.hidden = false;
    const chips = $("reason-chips");
    for (const r of REASONS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = r;
      chip.addEventListener("click", () => {
        input.value = r;
        update();
        btn.focus();
      });
      chips.append(chip);
    }
    const update = () => {
      btn.disabled = input.value.trim().length < 2;
      chips.querySelectorAll<HTMLElement>(".chip").forEach((c) => (c.dataset.current = String(c.textContent === input.value)));
    };
    input.addEventListener("input", update);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!btn.disabled) btn.click();
    });
    update();
  }
  btn.addEventListener("click", async () => {
    if (pass) {
      const reason = asking ? input.value.trim() : undefined;
      if (asking && !reason) return;
      const res = (await browser.runtime.sendMessage({ ...pass, reason } as Message)) as { ok: boolean };
      if (!res?.ok) return;
    }
    if (url) location.replace(url);
  });
  if (asking) input.focus();
  else btn.focus();
}

void main();
