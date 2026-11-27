import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { formatAgo, formatBytes } from "@focus/core";
import { Card } from "../../components/Card";
import { useHistoryChanged } from "../../ipc/history";
import {
  syncAccountAllow,
  syncAccountCheck,
  syncAllowFirewall,
  syncCancelCode,
  syncFirewallAllowed,
  syncForget,
  syncNow,
  syncPair,
  syncSetName,
  syncShowCode,
  syncStatus,
  type SyncAccount,
  type SyncPeer,
  type SyncProgress,
  type SyncStatus,
} from "../../ipc/sync";

const STAGE: Record<SyncProgress["stage"], string> = {
  connecting: "Connecting",
  sending: "Sending",
  receiving: "Receiving",
  applying: "Saving",
  "sending-files": "Sending files",
  "receiving-files": "Receiving files",
};

/** "123 456" */
const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** A clock difference worth mentioning (over two minutes). */
const skewWarning = (ms: number) =>
  Math.abs(ms) > 120_000
    ? `The clocks on this device and that one differ by ${Math.round(Math.abs(ms) / 60_000)} min. Turn on "Set time automatically" on both so the newest change wins.`
    : null;

export function SyncProgressBar(props: { progress: SyncProgress }) {
  const p = props.progress;
  const share = p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : p.rowsTotal > 0 ? p.rowsDone / p.rowsTotal : 0;
  const pct = p.stage === "applying" ? 100 : Math.round(Math.min(1, share) * 100);
  const detail =
    p.stage === "connecting"
      ? `Connecting to ${p.peerName}…`
      : p.rowsTotal === 0
        ? `${STAGE[p.stage]}: nothing new`
        : p.stage === "sending-files" || p.stage === "receiving-files"
          ? `${STAGE[p.stage]} ${Math.min(p.rowsDone + 1, p.rowsTotal)} of ${p.rowsTotal}${p.fileName ? ` (${p.fileName})` : ""} · ${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}`
          : `${STAGE[p.stage]} ${p.rowsDone} of ${p.rowsTotal} changes · ${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}`;
  return (
    <div className="sync-progress">
      <div className="sync-progress-text">
        <span>Syncing with {p.peerName}</span>
        <span className="muted small">{detail}</span>
      </div>
      <div
        className="sync-bar"
        role="progressbar"
        aria-label={`Syncing with ${p.peerName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span style={{ width: `${pct}%` }} data-busy={p.stage === "connecting" || p.stage === "applying"} />
      </div>
    </div>
  );
}

/** Pairing by Google account: devices signed in with the same Gmail pair by themselves. */
function AccountCard(props: {
  account: SyncAccount;
  pairedIds: Set<string>;
  now: number;
  signIn?: { busy: boolean; start: () => void; signOut: () => void };
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const { account, signIn } = props;
  const others = account.devices;
  if (!account.email) {
    return (
      <Card title="Same Google account">
        <p className="muted small">Sign in with the same Gmail on your PC and phone. They pair by themselves.</p>
        {signIn ? (
          <button type="button" className="button primary" disabled={signIn.busy} onClick={signIn.start}>
            {signIn.busy ? "Signing in…" : "Sign in with Google"}
          </button>
        ) : (
          <p className="small">Sign in under Settings › Data &amp; accounts.</p>
        )}
        {account.error && <p className="error small">{account.error}</p>}
      </Card>
    );
  }
  return (
    <Card title="Same Google account">
      <p className="small">
        Signed in as <strong>{account.email}</strong>.{" "}
        {others.length === 0 ? "No other device with this Gmail yet." : "Devices with this Gmail pair by themselves."}
      </p>
      {others.length > 0 && (
        <ul className="sync-nearby">
          {others.map((d) => (
            <li key={d.deviceId}>
              <span>
                <span aria-hidden="true">{d.kind === "phone" ? "📱" : "💻"}</span> {d.name}
                <span className="muted small">
                  {d.skipped ? " · unpaired here" : props.pairedIds.has(d.deviceId) ? " · paired" : " · pairing…"}
                </span>
              </span>
              {d.skipped && (
                <button
                  type="button"
                  className="button small-button"
                  onClick={() => syncAccountAllow(d.deviceId).then(props.onChange, (e: unknown) => props.onError(String(e)))}
                >
                  Pair again
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {account.error && <p className="error small">{account.error}</p>}
      <div className="sync-device-actions">
        <button type="button" className="button small-button" onClick={() => void syncAccountCheck().then(props.onChange)}>
          Check now
        </button>
        {account.checkedAtMs > 0 && <span className="muted small">Checked {formatAgo(account.checkedAtMs, props.now)}</span>}
        {signIn && (
          <button type="button" className="link-button small" onClick={signIn.signOut}>
            Sign out
          </button>
        )}
      </div>
    </Card>
  );
}

/** Pair with your other PC or your phone, and see how syncing is going. `googleSignIn` is the
 * phone's own Google sign-in (the PC signs in under Settings). */
export function SyncPage(
  props: {
    useGoogleSignIn?: (onDone: () => void, onError: (e: string) => void) => { busy: boolean; start: () => void; signOut: () => void } | undefined;
  } = {},
) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [name, setName] = useState("");
  // Pairing with a device: its address and the code typed for it.
  const [target, setTarget] = useState<{ address: string; name: string } | null>(null);
  const [manual, setManual] = useState("");
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [paired, setPaired] = useState<string | null>(null);
  // Windows Firewall keeping the phone out (src-tauri/src/firewall.rs).
  const [firewallOk, setFirewallOk] = useState(true);
  const [allowing, setAllowing] = useState(false);

  const reload = useCallback(() => {
    syncStatus()
      .then((s) => {
        setStatus(s);
        setProgress(s.progress);
        setName((n) => (n === "" ? s.me.name : n));
      })
      .catch((err: unknown) => setError(String(err)));
  }, []);
  useEffect(reload, [reload]);
  const noSignIn = useCallback(() => undefined, []);
  const googleSignIn = (props.useGoogleSignIn ?? noSignIn)(
    useCallback(() => {
      setError(null);
      reload();
    }, [reload]),
    setError,
  );
  // Opening Sync looks for this Gmail's other devices straight away.
  useEffect(() => {
    void syncAccountCheck().catch(() => {});
  }, []);
  useEffect(() => {
    void syncFirewallAllowed().then(setFirewallOk);
  }, []);
  useHistoryChanged(reload, "sync-changed");

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    listen<SyncProgress>("sync-progress", (e) => setProgress(e.payload))
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Online states and the code's time left move on their own.
  useEffect(() => {
    const t = window.setInterval(() => {
      setNow(Date.now());
      reload();
    }, 3000);
    return () => window.clearInterval(t);
  }, [reload]);

  async function pair() {
    const address = target?.address ?? manual.trim();
    if (!address) return;
    setPairing(true);
    setError(null);
    try {
      const info = await syncPair(address, code);
      setPaired(info.name);
      setTarget(null);
      setManual("");
      setCode("");
      reload();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setPairing(false);
    }
  }

  async function allowFirewall() {
    setAllowing(true);
    setError(null);
    try {
      const ok = await syncAllowFirewall();
      setFirewallOk(ok);
      if (ok) void syncNow();
      else setError("Kairos still isn't allowed through Windows Firewall. Press Allow and answer Yes when Windows asks.");
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setAllowing(false);
    }
  }

  function forget(peer: SyncPeer) {
    if (!window.confirm(`Stop syncing with ${peer.name}? Everything already here stays here.`)) return;
    syncForget(peer.deviceId).then(reload, (err: unknown) => setError(String(err)));
  }

  if (!status) {
    return (
      <section aria-labelledby="sync-title">
        <h1 id="sync-title" className="page-title">
          Sync
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

  const offer = status.offer && status.offer.expiresAtMs > now ? status.offer : null;
  const secondsLeft = offer ? Math.max(0, Math.round((offer.expiresAtMs - now) / 1000)) : 0;

  return (
    <section aria-labelledby="sync-title" className="sync-page">
      <h1 id="sync-title" className="page-title">
        Sync
      </h1>
      <p className="muted sync-intro">
        Keeps your PC and phone the same over Wi-Fi. Encrypted, no server.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status.listenError && (
        <div className="card notice error-notice">
          <p>{status.listenError}</p>
          <p className="muted small">It can still connect to the others.</p>
        </div>
      )}
      {!firewallOk && (
        <div className="card notice error-notice">
          <p>Windows Firewall is stopping your phone from reaching this PC, so its changes only arrive when you press Sync here.</p>
          <p className="muted small">Windows will ask for permission once.</p>
          <button type="button" className="button primary small-button" disabled={allowing} onClick={() => void allowFirewall()}>
            {allowing ? "Waiting for Windows…" : "Allow Kairos through the firewall"}
          </button>
        </div>
      )}
      {progress && (
        <div className="card">
          <SyncProgressBar progress={progress} />
        </div>
      )}

      {status.account && (
        <AccountCard
          account={status.account}
          pairedIds={new Set(status.peers.map((p) => p.deviceId))}
          now={now}
          signIn={googleSignIn}
          onChange={reload}
          onError={setError}
        />
      )}

      <Card title="Your devices">
        {status.peers.length === 0 ? (
          <p className="muted">No devices paired yet. Sign in with the same Gmail on both, or pair with a code below.</p>
        ) : (
          <ul className="sync-devices">
            {status.peers.map((p) => {
              const last = p.last;
              const skew = last ? skewWarning(last.clockSkewMs) : null;
              return (
                <li key={p.deviceId}>
                  <div className="sync-device-main">
                    <span className="sync-device-name">
                      <span aria-hidden="true">{p.kind === "phone" ? "📱" : "💻"}</span> {p.name}
                    </span>
                    <span className={`pill ${p.online ? "pill-ok" : "pill-neutral"}`}>{p.online ? "Nearby" : "Not nearby"}</span>
                  </div>
                  <p className="muted small">
                    {p.lastSyncedAt ? `Last synced ${formatAgo(p.lastSyncedAt, now)}` : "Not synced yet"}
                    {last?.ok && (last.sent > 0 || last.received > 0)
                      ? ` · sent ${last.sent}, got ${last.received} changes`
                      : ""}
                    {last?.ok && last.files > 0 ? ` · ${last.files} file${last.files === 1 ? "" : "s"} moved` : ""}
                    {p.address ? ` · ${p.address.replace(/:\d+$/, "")}` : ""}
                  </p>
                  {last && !last.ok && <p className="error small">{last.message}</p>}
                  {last?.ok && last.conflicts > 0 && (
                    <p className="small">
                      {last.conflicts === 1 ? "A note was" : `${last.conflicts} notes were`} changed on both devices. Your version is
                      kept as a note ending in "(conflict copy)".
                    </p>
                  )}
                  {skew && <p className="small">{skew}</p>}
                  <div className="sync-device-actions">
                    <button type="button" className="button small-button" onClick={() => void syncNow(p.deviceId)}>
                      Sync now
                    </button>
                    <button type="button" className="link-button small" onClick={() => forget(p)}>
                      Unpair
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Pair with a code">
        {paired && (
          <p className="sync-paired" role="status">
            ✓ Paired with {paired}. The first sync starts now.
          </p>
        )}
        <div className="sync-pair-grid">
          <div>
            <h3 className="sync-subtitle">Show a code here</h3>
            {offer ? (
              <>
                <p className="sync-code" aria-label={`Pairing code ${offer.code.split("").join(" ")}`}>
                  {spaced(offer.code)}
                </p>
                <p className="muted small">
                  On the other device open Sync, pick <strong>{status.me.name}</strong> and type this code. It works for{" "}
                  {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")} more.
                </p>
                <button type="button" className="button small-button" onClick={() => void syncCancelCode().then(reload)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <p className="muted small">Type this code on the other device.</p>
                <button type="button" className="button primary" onClick={() => void syncShowCode().then(reload)}>
                  Show a code
                </button>
              </>
            )}
          </div>
          <div>
            <h3 className="sync-subtitle">Pair with a device nearby</h3>
            {status.nearby.length === 0 ? (
              <p className="muted small">Looking for Kairos on your Wi-Fi… Open Kairos on the other device.</p>
            ) : (
              <ul className="sync-nearby">
                {status.nearby.map((n) => (
                  <li key={n.deviceId}>
                    <span>
                      <span aria-hidden="true">{n.kind === "phone" ? "📱" : "💻"}</span> {n.name}
                      {n.pairing && <span className="muted small"> · showing a code</span>}
                    </span>
                    <button
                      type="button"
                      className="button small-button"
                      aria-pressed={target?.address === n.address}
                      onClick={() => setTarget({ address: n.address, name: n.name })}
                    >
                      Pair
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!target && (
              <label className="field sync-manual">
                <span>Not listed? Type its address</span>
                <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="192.168.1.20" inputMode="decimal" />
              </label>
            )}
            {(target || manual.trim()) && (
              <form
                className="sync-code-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void pair();
                }}
              >
                <label className="field">
                  <span>Code shown on {target?.name ?? manual.trim()}</span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123 456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                  />
                </label>
                <div className="sync-device-actions">
                  <button type="submit" className="button primary" disabled={pairing || code.replace(/\D/g, "").length !== 6}>
                    {pairing ? "Pairing…" : "Pair"}
                  </button>
                  {target && (
                    <button type="button" className="link-button small" onClick={() => setTarget(null)}>
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>
      </Card>

      <Card title="This device">
        <label className="field sync-name">
          <span>Name other devices see</span>
          <input
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (name.trim() && name.trim() !== status.me.name) void syncSetName(name).then(reload);
            }}
          />
        </label>
        <p className="muted small">
          {status.addresses.length > 0
            ? `Address on your network: ${status.addresses.join(", ")}`
            : "Not connected to a network right now."}{" "}
          · Kairos {status.me.appVersion}
        </p>
        <p className="muted small">
          Both devices need the same version of Kairos to sync.
        </p>
      </Card>
    </section>
  );
}
