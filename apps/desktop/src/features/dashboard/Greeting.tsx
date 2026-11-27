import { greeting } from "@focus/core";
import { getEmailAccount } from "../../ipc/account";
import { getGoogleStatus } from "../../ipc/google";
import { useHistoryChanged } from "../../ipc/history";
import { useCommand } from "../../useCommand";

/** "Good afternoon", plus ", Ps" when signed in to Google or a Kairos email account. */
export function Greeting() {
  const [google, reload] = useCommand(getGoogleStatus, 600_000);
  const [account, reloadAccount] = useCommand(getEmailAccount, 600_000);
  useHistoryChanged(reload, "google-changed");
  useHistoryChanged(reloadAccount, "google-changed");
  const googleName = google.kind === "ready" ? google.value.name : null;
  const accountName = account.kind === "ready" ? account.value.name : null;
  const name = googleName ?? accountName;
  return <>{name ? `${greeting(new Date())}, ${name}` : greeting(new Date())}</>;
}
