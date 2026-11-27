import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_YOUTUBE,
  MAX_WAIT_SECONDS,
  MIN_WAIT_SECONDS,
  addYoutubeEntry,
  clampWait,
  cleanRules,
  cleanYoutubeRules,
  entryLabel,
  groupItemWith,
  moveItemToGroup,
  newItemGroup,
  removeTagGroup,
  renameTagGroup,
  MAX_GROUP_NAME,
  normalizeDomain,
  parseYoutubeEntry,
  removeYoutubeEntry,
  upsertRule,
  youtubeEntries,
  type BlockMode,
  type BlockRule,
  type FeedMode,
  type YoutubeRules,
} from "@focus/core";
import { Card } from "../../components/Card";
import { TagGroups } from "./TagGroups";
import {
  getAppBlocking,
  getBlocking,
  listAppChoices,
  pickAppExe,
  saveAppBlocking,
  saveBlocking,
  type AppChoice,
  type AppRule,
  type BlockingLists,
} from "../../ipc/blocking";
import { browserLinkStatus, browserNames, type BrowserLink } from "../../ipc/browserLink";
import { useHistoryChanged } from "../../ipc/history";
import { Dropdown } from "../../components/Dropdown";
import { Cycle } from "../settings/SettingsPage";
import { getPrivateWindows, setPrivateWindows, type PrivateMode, type PrivateStatus } from "../../ipc/privateWindows";

const MODE_OPTIONS: { value: BlockMode; label: string }[] = [
  { value: "wait", label: "Then continue" },
  { value: "block", label: "Full block" },
];

const SUGGESTIONS = ["youtube.com", "instagram.com", "reddit.com", "x.com", "facebook.com", "netflix.com"];

interface Lists {
  rules: BlockRule[];
  youtube: YoutubeRules;
  defaultWait: number;
}

function clean(b: BlockingLists): Lists {
  return { rules: cleanRules(b.rules), youtube: cleanYoutubeRules(b.youtube ?? DEFAULT_YOUTUBE), defaultWait: clampWait(b.defaultWait) };
}

/** What the box will block, said while you type. */
function entryHint(input: string): string {
  const entry = parseYoutubeEntry(input);
  if (!entry) return "";
  if (entry.kind === "channel") return `Blocks the channel ${entry.value}`;
  if (entry.kind === "tag") return `Blocks videos tagged #${entry.value}`;
  return `Blocks videos with "${entry.value}" in the title or tags`;
}

/** The sites and YouTube choices every browser on this PC blocks during focus. */
export function BlockingPage() {
  const [lists, setLists] = useState<Lists | null>(null);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<BrowserLink | null>(null);
  // Saves go out in order; the newest lists are what the page shows.
  const latest = useRef<Lists | null>(null);

  const reload = useCallback(() => {
    getBlocking()
      .then((b) => {
        const l = clean(b);
        latest.current = l;
        setLists(l);
        setConfigured(b.configured);
      })
      .catch((err: unknown) => setError(String(err)));
  }, []);
  useEffect(reload, [reload]);
  useHistoryChanged(reload, "blocking-changed");

  useEffect(() => {
    const check = () => void browserLinkStatus().then(setLink).catch(() => {});
    check();
    const t = window.setInterval(check, 3000);
    return () => window.clearInterval(t);
  }, []);

  function change(next: (l: Lists) => Lists) {
    const base = latest.current;
    if (!base) return;
    const l = next(base);
    latest.current = l;
    setLists(l);
    setConfigured(true);
    setError(null);
    saveBlocking(l).catch((err: unknown) => setError(`Could not save: ${String(err)}`));
  }

  if (!lists) {
    return (
      <section aria-labelledby="blocking-title">
        <h1 id="blocking-title" className="page-title">
          Blocking
        </h1>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="blocking-title" className="blocking-page">
      <h1 id="blocking-title" className="page-title">
        Blocking
      </h1>
      <ExtensionBanner link={link} />
      <p className="muted blocking-intro">
        Blocked while you focus. Free during breaks.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!configured && (
        <div className="card notice">
          <p>
            <strong>Nothing here yet.</strong> If Kairos Blocker already has sites in your browser, they move here by themselves the
            next time the browser links to Kairos. Or add sites below.
          </p>
        </div>
      )}

      <div className="blocking-grid">
        {/* Two columns that stack on their own, so the tall YouTube card leaves no gap under Blocked sites. */}
        <div className="blocking-col">
          <Card title="Blocked sites">
            <Sites lists={lists} onChange={change} />
          </Card>
          <Card title="Blocked apps">
            <Apps defaultWait={lists.defaultWait} />
          </Card>
        </div>
        <div className="blocking-col">
          <Card title="YouTube">
            <Youtube youtube={lists.youtube} onChange={(yt) => change((l) => ({ ...l, youtube: yt(l.youtube) }))} />
          </Card>
        </div>
        <Card title="Browsers">
          <BrowserStatus link={link} />
          <PrivateWindows />
          <label className="field blocking-default">
            Countdown for new "Wait" sites (seconds)
            <input
              type="number"
              min={MIN_WAIT_SECONDS}
              max={MAX_WAIT_SECONDS}
              defaultValue={lists.defaultWait}
              key={lists.defaultWait}
              onBlur={(e) => change((l) => ({ ...l, defaultWait: clampWait(Number(e.target.value)) }))}
            />
          </label>
        </Card>
      </div>
    </section>
  );
}

/** How something is blocked, in one pill: "Wait [20] s · Then continue ▾", or "Full block ▾". */
function WaitPicker(props: {
  mode: BlockMode;
  seconds: number;
  modeLabel: string;
  secondsLabel: string;
  onMode: (m: BlockMode) => void;
  onSeconds: (s: number) => void;
}) {
  const wait = props.mode === "wait";
  return (
    <span className="wait-pick" data-mode={props.mode}>
      {wait && (
        <span className="wait-pick-time">
          Wait
          <input
            type="number"
            className="wait-pick-seconds"
            min={MIN_WAIT_SECONDS}
            max={MAX_WAIT_SECONDS}
            aria-label={props.secondsLabel}
            defaultValue={props.seconds}
            key={props.seconds}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const v = clampWait(Number(e.target.value));
              if (v !== props.seconds) props.onSeconds(v);
              else e.target.value = String(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          s
        </span>
      )}
      <Dropdown
        className="wait-pick-mode"
        label={props.modeLabel}
        value={props.mode}
        options={MODE_OPTIONS}
        onChange={props.onMode}
      />
    </span>
  );
}

function Sites(props: { lists: Lists; onChange: (next: (l: Lists) => Lists) => void }) {
  const { rules, defaultWait } = props.lists;
  const [site, setSite] = useState("");
  const [mode, setMode] = useState<BlockMode>("wait");
  const [wait, setWait] = useState(defaultWait);
  const [problem, setProblem] = useState("");

  const put = (rule: BlockRule) => props.onChange((l) => ({ ...l, rules: upsertRule(l.rules, rule) }));

  function add(input: string, m: BlockMode, w: number): boolean {
    const domain = normalizeDomain(input);
    if (!domain) {
      setProblem(`"${input}" doesn't look like a website. Try something like youtube.com.`);
      return false;
    }
    setProblem("");
    put({ domain, mode: m, waitSeconds: w });
    return true;
  }

  return (
    <>
      <p className="muted small">
        <strong>Wait</strong>: let in after a countdown. <strong>Full block</strong>: no way in.
      </p>
      <form
        className="blocking-add blocking-add-site"
        onSubmit={(e) => {
          e.preventDefault();
          if (add(site, mode, wait)) setSite("");
        }}
      >
        <input
          type="text"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          placeholder="Add a site, e.g. reddit.com"
          aria-label="Site to block"
          autoComplete="off"
          spellCheck={false}
        />
        <WaitPicker mode={mode} seconds={wait} modeLabel="How to block it" secondsLabel="Countdown in seconds" onMode={setMode} onSeconds={setWait} />
        <button type="submit" className="button primary">
          Add
        </button>
      </form>
      {problem && (
        <p className="error small" role="alert">
          {problem}
        </p>
      )}
      <div className="chips" aria-label="Suggestions">
        {SUGGESTIONS.filter((d) => !rules.some((r) => r.domain === d)).map((d) => (
          <button key={d} type="button" className="chip" onClick={() => add(d, "wait", defaultWait)}>
            + {d}
          </button>
        ))}
      </div>
      {rules.length === 0 ? (
        <p className="muted blocking-empty">No sites yet.</p>
      ) : (
        <ul className="list blocking-rules">
          {rules.map((r) => (
            <li key={r.domain}>
              <span className="blocking-domain">{r.domain}</span>
              <WaitPicker mode={r.mode} seconds={r.waitSeconds} modeLabel={`How ${r.domain} is blocked`} secondsLabel={`Countdown for ${r.domain}, in seconds`} onMode={(m) => put({ ...r, mode: m })} onSeconds={(s) => put({ ...r, waitSeconds: s })} />
              <button
                type="button"
                className="link-button"
                aria-label={`Remove ${r.domain}`}
                onClick={() => props.onChange((l) => ({ ...l, rules: l.rules.filter((x) => x.domain !== r.domain) }))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** "C:\\Games\\Steam.exe" or "Discord" -> "steam.exe" / "discord.exe" (same as `normalize_exe` in Rust). */
function exeName(input: string): string | null {
  const name = (input.trim().replace(/^"|"$/g, "").split(/[\\/]/).pop() ?? "").trim().toLowerCase();
  if (!name || /[<>:"|?*\u0000-\u001f]/.test(name)) return null;
  return name.endsWith(".exe") ? name : `${name}.exe`;
}

/** Windows programs blocked during focus. Kept apart from the browsers' lists. */
function Apps(props: { defaultWait: number }) {
  const [apps, setApps] = useState<AppRule[] | null>(null);
  const [protectedApps, setProtected] = useState<string[]>([]);
  const [choices, setChoices] = useState<AppChoice[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<BlockMode>("block");
  const [wait, setWait] = useState(props.defaultWait);
  const [problem, setProblem] = useState("");
  const latest = useRef<AppRule[]>([]);

  const reload = useCallback(() => {
    getAppBlocking()
      .then((b) => {
        latest.current = b.apps;
        setApps(b.apps);
        setProtected(b.protected);
      })
      .catch((err: unknown) => setProblem(String(err)));
  }, []);
  useEffect(reload, [reload]);
  useHistoryChanged(reload, "blocking-changed");
  const refreshChoices = useCallback(() => void listAppChoices().then(setChoices).catch(() => {}), []);
  useEffect(refreshChoices, [refreshChoices]);

  function save(next: AppRule[]) {
    latest.current = next;
    setApps(next);
    saveAppBlocking(next)
      .then((kept) => {
        latest.current = kept;
        setApps(kept);
      })
      .catch((err: unknown) => setProblem(`Could not save: ${String(err)}`));
  }

  function put(rule: AppRule) {
    const cur = latest.current;
    const i = cur.findIndex((a) => a.exe === rule.exe);
    save(i < 0 ? [...cur, rule] : cur.map((a, j) => (j === i ? rule : a)));
  }

  function add(exe: string, name: string, m: BlockMode, w: number): boolean {
    if (protectedApps.includes(exe)) {
      setProblem(`${name} can't be blocked: Windows needs it, and you need a way out.`);
      return false;
    }
    setProblem("");
    put({ exe, name, mode: m, waitSeconds: w });
    return true;
  }

  function addTyped(text: string): boolean {
    const t = text.trim().toLowerCase();
    const choice = choices.find((c) => c.name.toLowerCase() === t || c.exe === t || c.exe === `${t}.exe`);
    if (choice) return add(choice.exe, choice.name, mode, wait);
    const exe = exeName(text);
    if (!exe) {
      setProblem(`"${text}" doesn't look like a program. Pick one below, or type its file name, e.g. discord.exe.`);
      return false;
    }
    const stem = exe.slice(0, -4);
    return add(exe, stem.charAt(0).toUpperCase() + stem.slice(1), mode, wait);
  }

  async function browse() {
    setProblem("");
    try {
      const c = await pickAppExe();
      if (c) add(c.exe, c.name, mode, wait);
    } catch (err) {
      setProblem(String(err));
    }
  }

  if (!apps) return <p className="muted">Loading…</p>;
  const offered = choices.filter((c) => !apps.some((a) => a.exe === c.exe)).slice(0, 16);

  return (
    <>
      <p className="muted small">
        Blocked apps close to the taskbar while you focus. <strong>Wait</strong>: open after a countdown.
      </p>
      <form
        className="blocking-add blocking-add-site"
        onSubmit={(e) => {
          e.preventDefault();
          if (addTyped(input)) setInput("");
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Add an app, e.g. Discord or steam.exe"
          aria-label="App to block"
          list="blocking-app-choices"
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id="blocking-app-choices">
          {offered.map((c) => (
            <option key={c.exe} value={c.name}>
              {c.exe}
            </option>
          ))}
        </datalist>
        <WaitPicker mode={mode} seconds={wait} modeLabel="How to block the app" secondsLabel="App countdown in seconds" onMode={setMode} onSeconds={setWait} />
        <span className="blocking-seconds">
          <button type="submit" className="button primary">
            Add
          </button>{" "}
          <button type="button" className="button" onClick={() => void browse()}>
            Browse…
          </button>
        </span>
      </form>
      {problem && (
        <p className="error small" role="alert">
          {problem}
        </p>
      )}
      {offered.length > 0 && (
        <div className="chips blocking-apps-picker" aria-label="Apps on this PC">
          {offered.map((c) => (
            <button
              key={c.exe}
              type="button"
              className="chip"
              title={c.open ? `${c.exe} (open now)` : c.exe}
              onClick={() => add(c.exe, c.name, mode, wait)}
            >
              {c.open && (
                <span className="blocking-open-dot" aria-label="open now">
                  ●
                </span>
              )}
              + {c.name}
            </button>
          ))}
          <button type="button" className="link-button small" onClick={refreshChoices}>
            Refresh
          </button>
        </div>
      )}
      {apps.length === 0 ? (
        <p className="muted blocking-empty">Open the app, then press Refresh.</p>
      ) : (
        <ul className="list blocking-rules">
          {apps.map((a) => (
            <li key={a.exe}>
              <span className="blocking-domain">
                {a.name}
                <span className="blocking-app-exe">{a.exe}</span>
              </span>
              <WaitPicker mode={a.mode} seconds={a.waitSeconds} modeLabel={`How ${a.name} is blocked`} secondsLabel={`Countdown for ${a.name}, in seconds`} onMode={(m) => put({ ...a, mode: m })} onSeconds={(s) => put({ ...a, waitSeconds: s })} />
              <button
                type="button"
                className="link-button"
                aria-label={`Remove ${a.name}`}
                onClick={() => save(latest.current.filter((x) => x.exe !== a.exe))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const KIND_NAMES = { channel: "channel", tag: "tag", phrase: "phrase" } as const;

function Youtube(props: { youtube: YoutubeRules; onChange: (next: (yt: YoutubeRules) => YoutubeRules) => void }) {
  const yt = props.youtube;
  const [entry, setEntry] = useState("");
  const entries = youtubeEntries(yt);
  const set = (part: Partial<YoutubeRules>) => props.onChange((cur) => ({ ...cur, ...part }));

  return (
    <>
      <p className="muted small">
        Keep the useful parts of YouTube, block the rest.
      </p>
      <label className="check">
        <input type="checkbox" checked={yt.blockShorts} onChange={(e) => set({ blockShorts: e.target.checked })} /> Block Shorts, and
        hide them from YouTube's pages
      </label>
      <p className="muted small">While you focus, also hide:</p>
      <label className="check">
        <input type="checkbox" checked={yt.hideComments} onChange={(e) => set({ hideComments: e.target.checked })} /> Comments
      </label>
      <label className="check">
        <input type="checkbox" checked={yt.hideRecommended} onChange={(e) => set({ hideRecommended: e.target.checked })} /> Suggested
        videos (the Up next column and end screens)
      </label>
      <label className="check">
        <input type="checkbox" checked={yt.hideHomeFeed} onChange={(e) => set({ hideHomeFeed: e.target.checked })} /> The home page
        feed (search still works)
      </label>

      <h3 className="blocking-sub">What to block</h3>
      <p className="muted small">
        <strong>@channel</strong>, <strong>#tag</strong> or any word.
      </p>
      <form
        className="blocking-add"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = parseYoutubeEntry(entry);
          if (!parsed) return;
          setEntry("");
          props.onChange((cur) => addYoutubeEntry(cur, parsed));
        }}
      >
        <input
          type="text"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          placeholder="@channel, #tag or a phrase, e.g. minecraft"
          aria-label="Channel, tag or phrase to block"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="button primary">
          Block
        </button>
      </form>
      <p className="small blocking-hint" aria-live="polite">
        {entryHint(entry)}
      </p>
      {entries.length === 0 ? (
        <p className="muted blocking-empty">Nothing yet.</p>
      ) : (
        <>
        {yt.tags.length + yt.keywords.length > 0 && (
          <TagGroups
            youtube={yt}
            onGroupWith={(item, onto) => props.onChange((cur) => groupItemWith(cur, item, onto))}
            onMove={(item, group) => props.onChange((cur) => moveItemToGroup(cur, item, group))}
            onNewGroup={(item) => props.onChange((cur) => newItemGroup(cur, item, item.value))}
            onRename={(name, to) => props.onChange((cur) => renameTagGroup(cur, name, to.slice(0, MAX_GROUP_NAME)))}
            onUngroup={(name) => props.onChange((cur) => removeTagGroup(cur, name, false))}
            onRemove={(item) => props.onChange((cur) => removeYoutubeEntry(cur, item))}
          />
        )}
        <ul className="list blocking-rules blocking-entries">
          {entries.filter((en) => en.kind === "channel").map((en) => (
            <li key={`${en.kind}:${en.value}`}>
              <span className="blocking-domain">
                <span className={`blocking-kind blocking-kind-${en.kind}`}>{KIND_NAMES[en.kind]}</span>
                {entryLabel(en)}
              </span>
              <button
                type="button"
                className="link-button"
                aria-label={`Remove ${entryLabel(en)}`}
                onClick={() => props.onChange((cur) => removeYoutubeEntry(cur, en))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        </>
      )}

      <h3 className="blocking-sub">Blocked videos on YouTube's pages</h3>
      <div className="blocking-radios" role="radiogroup" aria-label="Blocked videos on YouTube's pages">
        {(
          [
            ["cover", "Cover the thumbnail and show what matched"],
            ["hide", "Remove them from the page"],
          ] as [FeedMode, string][]
        ).map(([value, label]) => (
          <label key={value} className="check">
            <input type="radio" name="yt-feed" checked={yt.feed === value} onChange={() => set({ feed: value })} /> {label}
          </label>
        ))}
      </div>

      <div className="blocking-add">
        <span className="muted small">When something on YouTube is blocked:</span>
        <WaitPicker mode={yt.mode} seconds={yt.waitSeconds} modeLabel="How YouTube blocks are handled" secondsLabel="YouTube countdown in seconds" onMode={(m) => set({ mode: m })} onSeconds={(s) => set({ waitSeconds: s })} />
      </div>
    </>
  );
}

/** Site and YouTube blocking only work through the browser extension: say so, and whether it is there. */
function ExtensionBanner(props: { link: BrowserLink | null }) {
  const l = props.link;
  const on = !!l?.linked;
  return (
    <div className="ext-banner" data-on={on || undefined} role="status">
      <span className="ext-dot" aria-hidden="true" />
      <div className="ext-text">
        <strong>{on ? `Connected: ${browserNames(l!)}` : "Browser extension needed"}</strong>
        <span className="muted small">
          {on
            ? l!.blocking
              ? "Blocking your sites now."
              : "Blocks your sites when a focus starts."
            : l && !l.listening
              ? "Another program is using port 47811. Close it and restart Kairos."
              : "Sites and YouTube are blocked by the Kairos Blocker extension. It's in the Kairos download zip: kairos-blocker for Firefox or Zen, kairos-blocker-chrome for Chrome, Edge or Brave."}
        </span>
      </div>
    </div>
  );
}

const PRIVATE_OPTIONS: { id: PrivateMode; label: string }[] = [
  { id: "off", label: "Allowed" },
  { id: "focus", label: "Blocked during focus" },
  { id: "always", label: "Always blocked" },
];

/** Incognito / InPrivate / Private windows, switched off with each browser's Windows policy (no extension needed). */
function PrivateWindows() {
  const [status, setStatus] = useState<PrivateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const check = () => void getPrivateWindows().then(setStatus).catch(() => {});
    check();
    const t = window.setInterval(check, 3000);
    return () => window.clearInterval(t);
  }, []);

  async function choose(mode: PrivateMode) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus((s) => (s ? { ...s, mode } : s));
    try {
      setStatus(await setPrivateWindows(mode));
    } catch (err) {
      setError(String(err));
      void getPrivateWindows().then(setStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const problem = error ?? status.error;
  return (
    <div className="private-windows">
      <Cycle label="Private windows" options={PRIVATE_OPTIONS} value={status.mode} onChange={(m) => void choose(m)} />
      <p className={`small ${problem ? "error" : "muted"}`} role="status" aria-live="polite">
        {busy
          ? "Click Yes if Windows asks."
          : problem
            ? <>
                {problem}{" "}
                <button type="button" className="link-button" onClick={() => void choose(status.mode)}>
                  Allow
                </button>
              </>
            : status.blocked
              ? "Off now in Chrome, Edge, Brave, Helium, Firefox and Zen. Restart Firefox or Zen once."
              : status.mode === "focus"
                ? "Turns off when a focus starts."
                : "Incognito and InPrivate windows work."}
      </p>
    </div>
  );
}

function BrowserStatus(props: { link: BrowserLink | null }) {
  const l = props.link;
  return (
    <>
      <p>
        <span className={`pill ${l?.linked ? "pill-ok" : "pill-neutral"}`}>
          <span aria-hidden="true">{l?.linked ? "● " : "○ "}</span>
          {l?.linked ? `${browserNames(l)}${l.blocking ? " · blocking" : ""}` : "No browser connected"}
        </span>
      </p>
      <p className="muted small">
        {l && !l.listening
          ? "Another program is using the link's port (47811). Close it and restart Kairos."
          : "Install Kairos Blocker in each browser you use."}
      </p>
    </>
  );
}
