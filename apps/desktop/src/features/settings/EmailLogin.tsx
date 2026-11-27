import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useHistoryChanged } from "../../ipc/history";
import {
  checkEmailVerified,
  emailSignIn,
  emailSignOut,
  emailSignUp,
  getEmailAccount,
  resendVerification,
  resetPassword,
  type EmailAccount,
} from "../../ipc/account";

type Note = { error: boolean; text: string } | null;

/** The Kairos email account: shown inside the Account card (GoogleCard). */
export function useEmailAccount() {
  const [account, setAccount] = useState<EmailAccount | null>(null);
  const reload = useCallback(() => {
    getEmailAccount().then(setAccount, () => setAccount(null));
  }, []);
  useEffect(reload, [reload]);
  useHistoryChanged(reload, "google-changed");
  return [account, setAccount] as const;
}

/** Log in / Create account with an email and a password. */
export function EmailLoginForm(props: { onDone: (a: EmailAccount) => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "up" && password !== again) {
      setNote({ error: true, text: "The passwords don't match." });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      props.onDone(
        mode === "up"
          ? await emailSignUp(email, password, name)
          : await emailSignIn(email, password),
      );
    } catch (err) {
      setNote({ error: true, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function forgot() {
    setNote(null);
    try {
      await resetPassword(email);
      setNote({ error: false, text: `Sent a reset link to ${email.trim()}.` });
    } catch (err) {
      setNote({ error: true, text: String(err) });
    }
  }

  return (
    <form
      className="email-login"
      onSubmit={submit}
      aria-label={mode === "up" ? "Create account" : "Log in"}
    >
      <div className="email-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "in"}
          data-on={mode === "in" || undefined}
          onClick={() => setMode("in")}
        >
          Log in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "up"}
          data-on={mode === "up" || undefined}
          onClick={() => setMode("up")}
        >
          Create account
        </button>
      </div>
      <label className="field">
        <span>Gmail</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          spellCheck={false}
          placeholder="you@gmail.com"
          required
        />
      </label>
      {mode === "up" && (
        <label className="field">
          <span>Username</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="nickname"
            maxLength={40}
            required
          />
        </label>
      )}
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "up" ? "new-password" : "current-password"}
          minLength={6}
          required
        />
      </label>
      {mode === "up" && (
        <>
          <label className="field">
            <span>Repeat password</span>
            <input
              type="password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <p className="muted small">
            Make a new password for Kairos. Don't use your Gmail password.
          </p>
        </>
      )}
      {note && (
        <p className={`small ${note.error ? "error" : "muted"}`} role="status">
          {note.text}
        </p>
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="button primary"
          disabled={
            busy ||
            !email.trim() ||
            !password ||
            (mode === "up" && (!name.trim() || !again))
          }
        >
          {busy ? "Wait…" : mode === "up" ? "Create account" : "Log in"}
        </button>
        {mode === "in" && (
          <button
            type="button"
            className="link-button small"
            disabled={!email.trim()}
            onClick={() => void forgot()}
          >
            Forgot password?
          </button>
        )}
      </div>
    </form>
  );
}

/** Signed in with email: who, the confirm-your-email step, and Log out. */
export function EmailSignedIn(props: {
  account: EmailAccount;
  onChange: (a: EmailAccount | null) => void;
  compact?: boolean;
}) {
  const { account } = props;
  const [note, setNote] = useState<Note>(null);
  const [confirmOut, setConfirmOut] = useState(false);

  async function check() {
    setNote(null);
    try {
      const a = await checkEmailVerified();
      props.onChange(a);
      if (!a.verified)
        setNote({
          error: true,
          text: "Not confirmed yet. Open the link in the email first.",
        });
    } catch (err) {
      setNote({ error: true, text: String(err) });
    }
  }

  async function resend() {
    try {
      await resendVerification();
      setNote({ error: false, text: "Sent again. Check spam too." });
    } catch (err) {
      setNote({ error: true, text: String(err) });
    }
  }

  async function out() {
    setConfirmOut(false);
    try {
      await emailSignOut();
      props.onChange(null);
    } catch (err) {
      setNote({ error: true, text: String(err) });
    }
  }

  return (
    <div className="email-signed-in">
      <p className="google-account">
        {props.compact ? "Also logged in as " : "Logged in as "}
        <strong>{account.name ?? account.email}</strong>
        {account.name && <span className="muted"> · {account.email}</span>}
      </p>
      {!account.verified && (
        <div className="email-verify" role="status">
          <span>Open the link we emailed to {account.email} to finish.</span>
          <span className="google-actions">
            <button
              type="button"
              className="button small-button"
              onClick={() => void check()}
            >
              I've confirmed it
            </button>
            <button
              type="button"
              className="link-button small"
              onClick={() => void resend()}
            >
              Send again
            </button>
          </span>
        </div>
      )}
      {note && (
        <p className={`small ${note.error ? "error" : "muted"}`} role="status">
          {note.text}
        </p>
      )}
      {confirmOut ? (
        <p className="confirm-left">
          Log out of {account.email}?{" "}
          <button
            type="button"
            className="button danger"
            onClick={() => void out()}
          >
            Log out
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
          Log out…
        </button>
      )}
    </div>
  );
}
