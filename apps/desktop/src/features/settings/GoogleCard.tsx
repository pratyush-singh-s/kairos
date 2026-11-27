import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Card } from "../../components/Card";
import { useHistoryChanged } from "../../ipc/history";
import {
  connectCalendar,
  listCalendars,
  setCalendarAuto,
  setCalendarPush,
  setCalendarShown,
  syncCalendarNow,
  type CalendarSource,
} from "../../ipc/calendar";
import { syncedLabel, useCalendarSync } from "../calendar/CalendarPage";
import {
  cancelGoogleSignIn,
  getGoogleStatus,
  googleSignIn,
  googleSignOut,
  saveGoogleClient,
  type GoogleStatus,
} from "../../ipc/google";
import { getUsersInfo } from "../../ipc/users";
import { EmailLoginForm, EmailSignedIn, useEmailAccount } from "./EmailLogin";

type Message = { error: boolean; text: string } | null;

/**
 * Google account: "Sign in with Google" opens Google's page in your browser (the app never sees
 * your password; the sign-in is kept in Windows Credential Manager). Once signed in, one switch
 * turns on automatic Google Calendar sync, asking Google for Calendar access the first time.
 */
export function GoogleCard() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [sync] = useCalendarSync();
  const [editing, setEditing] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [shared, setShared] = useState(false);
  const [account, setAccount] = useEmailAccount();
  useEffect(() => {
    getUsersInfo().then(
      (i) => setShared(i.builtIn && i.share),
      () => setShared(false),
    );
  }, []);

  const reload = useCallback(() => {
    getGoogleStatus()
      .then(setStatus)
      .catch((err: unknown) =>
        setMessage({
          error: true,
          text: `Could not read the Google setting: ${String(err)}`,
        }),
      );
  }, []);
  useEffect(reload, [reload]);
  useHistoryChanged(reload, "google-changed");

  async function connect(
    how: () => Promise<GoogleStatus> = googleSignIn,
  ): Promise<boolean> {
    setMessage(null);
    setWaiting(true);
    try {
      setStatus(await how());
      return true;
    } catch (err) {
      setMessage({ error: true, text: String(err) });
      return false;
    } finally {
      setWaiting(false);
    }
  }

  /** The auto-sync switch. The first time, Google is asked for Calendar access. */
  async function setAuto(on: boolean) {
    setMessage(null);
    if (on && !status?.calendar && !(await connect(connectCalendar))) return;
    try {
      await setCalendarAuto(on);
    } catch (err) {
      setMessage({ error: true, text: String(err) });
    }
  }

  async function disconnect() {
    setConfirmOut(false);
    try {
      await googleSignOut();
      setMessage({ error: false, text: "Signed out." });
      reload();
    } catch (err) {
      setMessage({ error: true, text: `Not signed out: ${String(err)}` });
    }
  }

  const showForm = status && (!status.configured || editing);
  const waitNote = (
    <p className="confirm-left" role="status">
      Finish on Google's page in your browser…{" "}
      <button
        type="button"
        className="button"
        onClick={() => void cancelGoogleSignIn()}
      >
        Cancel
      </button>
    </p>
  );

  return (
    <Card title="Account">
      {account?.builtIn && !status?.email && !account.email && (
        <p className="muted small">Log in with your email, or with Google.</p>
      )}
      {status === null ? null : showForm ? (
        <ClientForm
          status={status}
          onSaved={(s) => {
            setStatus(s);
            setEditing(false);
            setMessage({ error: false, text: "Saved. Now sign in." });
          }}
          onCancel={status.configured ? () => setEditing(false) : undefined}
        />
      ) : status.email ? (
        <>
          <p className="google-account">
            Signed in as <strong>{status.name ?? status.email}</strong>
            {status.name && <span className="muted"> · {status.email}</span>}
            {!status.name && !waiting && (
              <>
                {" "}
                <button
                  type="button"
                  className="link-button small"
                  onClick={() => void connect()}
                >
                  Sign in again to show your name
                </button>
              </>
            )}
          </p>
          <label className="inline-check google-auto">
            <input
              type="checkbox"
              checked={!!status.calendar && (sync?.autoSync ?? true)}
              disabled={waiting}
              onChange={(e) => void setAuto(e.target.checked)}
            />
            Sync Google Calendar automatically
          </label>
          {waiting ? waitNote : status.calendar ? <CalendarSettings /> : null}
          {account?.email && (
            <EmailSignedIn
              account={account}
              onChange={(a) =>
                setAccount(
                  a ?? { ...account, email: null, name: null, verified: false },
                )
              }
              compact
            />
          )}
          {confirmOut ? (
            <p className="confirm-left">
              Sign out of Google?{" "}
              <button
                type="button"
                className="button danger"
                onClick={() => void disconnect()}
              >
                Sign out
              </button>{" "}
              <button
                type="button"
                className="button"
                onClick={() => setConfirmOut(false)}
              >
                Keep
              </button>
            </p>
          ) : (
            <button
              type="button"
              className="button"
              onClick={() => setConfirmOut(true)}
            >
              Sign out…
            </button>
          )}
        </>
      ) : waiting ? (
        waitNote
      ) : (
        <>
          {account?.builtIn &&
            (account.email ? (
              <EmailSignedIn
                account={account}
                onChange={(a) =>
                  setAccount(
                    a ?? {
                      ...account,
                      email: null,
                      name: null,
                      verified: false,
                    },
                  )
                }
              />
            ) : (
              <EmailLoginForm onDone={setAccount} />
            ))}
          {account?.builtIn && (
            <p className="login-or" aria-hidden="true">
              <span>{account.email ? "Google Calendar" : "or"}</span>
            </p>
          )}
          <div className="google-actions">
            <button
              type="button"
              className="button google-sign-in"
              onClick={() => void connect()}
            >
              <GoogleLogo />
              Sign in with Google
            </button>
            <button
              type="button"
              className="link-button small"
              onClick={() => setEditing(true)}
            >
              {status.builtIn ? "Use my own client ID" : "Change client ID"}
            </button>
            {shared && (
              <p className="muted small google-share-note">
                Your email is shared with Kairos's maker.
              </p>
            )}
          </div>
        </>
      )}
      {message && (
        <p
          className={`small ${message.error ? "error" : "muted"}`}
          role="status"
        >
          {message.text}
        </p>
      )}
    </Card>
  );
}

/** Google's "G" mark, as Google asks sign-in buttons to show it. */
function GoogleLogo() {
  return (
    <svg
      className="google-logo"
      viewBox="0 0 48 48"
      width="18"
      height="18"
      aria-hidden="true"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** The client ID and secret from Google Cloud → Credentials → your Desktop app client. */
function ClientForm(props: {
  status: GoogleStatus;
  onSaved: (s: GoogleStatus) => void;
  onCancel?: () => void;
}) {
  const [id, setId] = useState(props.status.clientId);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      props.onSaved(await saveGoogleClient(id, secret));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="google-form" onSubmit={submit} aria-label="Google client">
      <p className="small">
        First make a free client ID in Google Cloud (about 10 minutes, once).
        The steps are in <strong>GOOGLE-SETUP.md</strong>, next to the
        installer.
      </p>
      <label className="field">
        <span>Client ID</span>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="123456789-abc.apps.googleusercontent.com"
          spellCheck={false}
          autoComplete="off"
          required
        />
      </label>
      <label className="field">
        <span>Client secret</span>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          required
        />
      </label>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="button primary"
          disabled={busy || !id.trim() || !secret.trim()}
        >
          Save
        </button>
        {props.onCancel && (
          <button
            type="button"
            className="button"
            onClick={props.onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Which calendars show in Focus, whether to-dos and deadlines go into Google, and sync state. */
function CalendarSettings() {
  const [sync] = useCalendarSync();
  const [list, setList] = useState<CalendarSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    listCalendars()
      .then(setList)
      .catch((err: unknown) => setError(String(err)));
  }, []);
  useEffect(reload, [reload]);
  useHistoryChanged(reload, "calendar-changed");

  const act = (p: Promise<unknown>) =>
    p.then(
      () => {
        setError(null);
        reload();
      },
      (err: unknown) => setError(String(err)),
    );

  return (
    <div className="google-calendar">
      <h3 className="settings-subtitle">Google Calendar</h3>
      <p className="small" role="status">
        {sync?.syncing ? "Syncing…" : syncedLabel(sync?.lastSyncedAt ?? null)}
        {sync?.error && (
          <span className={sync.expired ? "error" : "muted"}>
            {" "}
            · {sync.error}
          </span>
        )}
        {sync && sync.pending > 0 && (
          <span className="muted"> · {sync.pending} not yet in Google</span>
        )}{" "}
        <button
          type="button"
          className="button small-button"
          onClick={() => void act(syncCalendarNow())}
          disabled={sync?.syncing}
        >
          Sync now
        </button>
      </p>
      <label className="inline-check push-check">
        <input
          type="checkbox"
          checked={sync?.pushFocus ?? true}
          onChange={(e) => void act(setCalendarPush(e.target.checked))}
        />
        Put dated to-dos, plan steps and deadlines in a "Focus" calendar in
        Google
      </label>
      {list.length > 0 && (
        <fieldset className="radio-group">
          <legend>Show in Kairos</legend>
          <ul className="calendar-list">
            {list.map((c) => (
              <li key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={c.selected}
                    onChange={(e) =>
                      void act(setCalendarShown(c.id, e.target.checked))
                    }
                  />
                  <span
                    className="calendar-dot"
                    style={{
                      ["--event-color" as string]: c.color ?? "var(--accent)",
                    }}
                    aria-hidden="true"
                  />
                  {c.summary}
                  {c.holiday && <span className="muted small">holidays</span>}
                  {c.focus && (
                    <span className="muted small">
                      your to-dos and deadlines
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <p className="muted small">
        Add holidays in Google Calendar under Other calendars.
      </p>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
