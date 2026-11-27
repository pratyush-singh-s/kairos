/**
 * The link to the Kairos phone app, for when the Kairos app isn't on this PC. Browsers can't use
 * the phone's own Wi-Fi sync (it needs UDP and encryption extensions can't do), so the phone
 * answers plain web requests on port 47814 instead, the same questions the PC app answers on
 * 127.0.0.1:47811 (see link.ts). You link once with the 6-digit code the phone shows; after that
 * every request carries the token the phone gave back.
 *
 * Both have to be on the same Wi-Fi. If the phone can't be reached, a focus phase it started keeps
 * blocking until its planned end; a paused one stops.
 */
import { listChanges, nextSession, type AppFocus } from "./link";
import { load, save, type ExtState, type PhoneLink } from "./state";

export const PHONE_PORT = 47814;
/** A bit longer than the phone's 25 s wait. */
const REQUEST_TIMEOUT_MS = 35_000;
const RETRY_MS = 10_000;

/** "192.168.1.23", "192.168.1.23:47814" or a pasted "http://..." as "host:port"; null if it isn't an address. */
export function cleanAddress(input: string): string | null {
  const text = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const m = /^([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i.exec(text);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : PHONE_PORT;
  if (port < 1 || port > 65535) return null;
  return `${m[1]!.toLowerCase()}:${port}`;
}

/** The permission to talk to the phone, asked for when you link (Firefox needs a click for it). */
export function phonePermission(address: string): { origins: string[] } {
  return { origins: [`http://${address.replace(/:\d+$/, "")}/*`] };
}

const base = (address: string) => `http://${address}`;

export type PairResult = "linked" | "bad-code" | "no-answer" | "old-phone";

/** Trades the phone's code for a token and saves the link. */
export async function pair(address: string, code: string): Promise<PairResult> {
  const clean = cleanAddress(address);
  const digits = code.replace(/\D/g, "");
  if (!clean || digits.length !== 6) return "bad-code";
  let res: Response;
  try {
    res = await fetch(`${base(clean)}/v1/browser/pair?code=${digits}`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return "no-answer";
  }
  if (res.status === 404) return "old-phone";
  if (!res.ok) return "bad-code";
  const { token, deviceName } = (await res.json()) as { token?: string; deviceName?: string };
  if (!token) return "bad-code";
  const phone: PhoneLink = { address: clean, token, name: deviceName || "Phone" };
  await save({ phone, phoneSession: null, phoneStatus: { connected: true, appVersion: null, paused: false } });
  restartPhoneLink();
  return "linked";
}

export async function unlink(): Promise<void> {
  const s = await load();
  if (s.phone) {
    // Lets the phone forget this browser; it doesn't matter if it can't be reached.
    void fetch(`${base(s.phone.address)}/v1/browser/unpair?token=${encodeURIComponent(s.phone.token)}`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }
  const changes: Partial<ExtState> = { phone: null, phoneSession: null, phoneStatus: { connected: false, appVersion: null, paused: false } };
  // Lists the phone sent stay, but become yours to edit again.
  if (s.managedBy === "phone") Object.assign(changes, { managed: false, managedBy: null });
  await save(changes);
  restartPhoneLink();
}

/** The changes to save for a new answer from the phone (null = it didn't answer). */
export function phoneChanges(s: ExtState, focus: AppFocus | null, now = Date.now()): Partial<ExtState> {
  const changes: Partial<ExtState> = {};
  let session = nextSession(s.phoneSession, focus, "phone", now);
  if (!focus && s.phoneSession && !s.phoneStatus.paused) session = undefined; // keep it until its end
  if (session !== undefined) changes.phoneSession = session;
  const status = { connected: focus !== null, appVersion: focus?.appVersion ?? null, paused: focus ? !!focus.paused : s.phoneStatus.paused };
  if (JSON.stringify(status) !== JSON.stringify(s.phoneStatus)) changes.phoneStatus = status;
  // The phone carries the laptop's lists; the PC app's (when it is here too) are the same ones.
  if (focus?.blocking && focus.blockingConfigured !== false && !s.link.connected) Object.assign(changes, listChanges(s, focus.blocking, "phone"));
  return changes;
}

let stop = new AbortController();

/** Drops the request in flight, so a new or removed link takes effect at once. */
export function restartPhoneLink(): void {
  stop.abort();
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

/** Runs for as long as the background lives, like runLink. */
export async function runPhoneLink(): Promise<void> {
  let since: number | null = null;
  let linkedTo: string | null = null;
  for (;;) {
    stop = new AbortController();
    const signal = stop.signal;
    const s = await load();
    if (!s.phone) {
      since = null;
      await sleep(60_000, signal);
      continue;
    }
    if (s.phone.token !== linkedTo) {
      linkedTo = s.phone.token;
      since = null;
    }
    const q = new URLSearchParams({ token: s.phone.token });
    if (since !== null) q.set("since", String(since));
    try {
      const res = await fetch(`${base(s.phone.address)}/v1/focus?${q.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (res.status === 401) {
        // The phone forgot this browser (unlinked there): link again with a new code.
        await save({ phone: null, phoneSession: null, phoneStatus: { connected: false, appVersion: null, paused: false } });
        continue;
      }
      if (!res.ok) throw new Error(`Phone answered ${res.status}`);
      const focus = (await res.json()) as AppFocus;
      since = focus.version;
      const changes = phoneChanges(await load(), focus);
      if (Object.keys(changes).length) await save(changes);
    } catch {
      if (signal.aborted) continue;
      since = null;
      const changes = phoneChanges(await load(), null);
      if (Object.keys(changes).length) await save(changes).catch(() => {});
      await sleep(RETRY_MS, signal);
    }
  }
}
