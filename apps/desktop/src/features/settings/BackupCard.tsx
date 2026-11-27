import { useState } from "react";
import { Card } from "../../components/Card";
import { makeBackup, restoreBackup } from "../../ipc/backup";

type Busy = "idle" | "saving" | "restoring";

const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

/**
 * Settings → Backup: everything (to-dos, deadlines, notes and their files, history, settings)
 * in one file locked with a password; restoring replaces what's on this PC and restarts Focus.
 */
export function BackupCard() {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [restorePw, setRestorePw] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState<Busy>("idle");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = again.length > 0 && again !== password;
  const canSave = password.length >= 8 && again === password && busy === "idle";

  const save = async () => {
    setBusy("saving");
    setMessage(null);
    try {
      const info = await makeBackup(password);
      if (info) {
        setMessage({ ok: true, text: `Saved ${size(info.bytes)} (${info.attachments} attached file${info.attachments === 1 ? "" : "s"}) to ${info.path}` });
        setPassword("");
        setAgain("");
      }
    } catch (e) {
      setMessage({ ok: false, text: `Backup not made: ${String(e)}` });
    }
    setBusy("idle");
  };

  const restore = async () => {
    setBusy("restoring");
    setMessage(null);
    try {
      // On success Focus restarts, so this only returns when the dialog was closed.
      await restoreBackup(restorePw);
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    }
    setBusy("idle");
  };

  return (
    <Card title="Backup">
      <p className="muted small">
        Everything in one file, locked with a password. Lose the password and the backup can't be opened.
      </p>
      <div className="backup-row">
        <label>
          Password
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Type it again
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        <button type="button" className="button primary" disabled={!canSave} onClick={() => void save()}>
          {busy === "saving" ? "Saving…" : "Make backup…"}
        </button>
      </div>
      {(tooShort || mismatch) && <p className="error small">{tooShort ? "At least 8 characters." : "The passwords don't match."}</p>}

      <h3 className="backup-sub">Restore</h3>
      <p className="muted small">
        Replaces everything on this PC with the backup. Your old data is kept as a copy.
      </p>
      <div className="backup-row">
        <label>
          Backup password
          <input type="password" autoComplete="off" value={restorePw} onChange={(e) => setRestorePw(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          Replace what's on this PC
        </label>
        <button type="button" className="button" disabled={!sure || restorePw.length === 0 || busy !== "idle"} onClick={() => void restore()}>
          {busy === "restoring" ? "Checking…" : "Restore from backup…"}
        </button>
      </div>
      {message && (
        <p className={message.ok ? "muted small" : "error small"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}
    </Card>
  );
}
