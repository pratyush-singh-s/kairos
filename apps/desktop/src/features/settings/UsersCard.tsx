import { useCallback, useEffect, useState } from "react";
import { Card } from "../../components/Card";
import { useHistoryChanged } from "../../ipc/history";
import { getUsersInfo, getUsersOverview, type UsersInfo, type UsersOverview } from "../../ipc/users";

const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

/**
 * Kairos users (users.rs). Every install is counted (and the signed-in email,
 * when signed in) for the app's maker. The maker, signed in with their own Google account, also
 * sees the counts and who signed in. The database itself refuses everyone else.
 */
export function UsersCard() {
  const [info, setInfo] = useState<UsersInfo | null>(null);
  const [data, setData] = useState<UsersOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    getUsersInfo().then(setInfo, () => setInfo(null));
    setLoading(true);
    getUsersOverview()
      .then(setData, () => setData(null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  useHistoryChanged(load, "google-changed");

  // Only the maker (signed in with their own account) sees anything here.
  if (!info?.builtIn || !data?.owner) return null;

  function copy() {
    if (!data) return;
    const rows = [["Name", "Email", "First seen", "Last seen", "Version"], ...data.people.map((p) => [p.name, p.email, day(p.firstSeen), day(p.lastSeen), p.version])];
    void navigator.clipboard.writeText(rows.map((r) => r.join("\t")).join("\n")).then(() => setCopied(true));
  }

  return (
    <Card title="Kairos users">
      {data?.owner && (
        <div className="users-owner">
          <p className="users-stats">
            <strong>{data.installs}</strong> installs · <strong>{data.activeWeek}</strong> opened this week · <strong>{data.newWeek}</strong> new this week
          </p>
          {data.people.length === 0 ? (
            <p className="muted small">No sign-ins yet.</p>
          ) : (
            <table className="users-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>First</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.email}>
                    <td>{p.name || "—"}</td>
                    <td>{p.email}</td>
                    <td>{day(p.firstSeen)}</td>
                    <td>{day(p.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="google-actions">
            <button type="button" className="button" onClick={load} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </button>
            {data.people.length > 0 && (
              <button type="button" className="button" onClick={copy}>
                {copied ? "Copied" : "Copy list"}
              </button>
            )}
          </div>
        </div>
      )}
      {data?.error && <p className="error small">{data.error}</p>}
    </Card>
  );
}
