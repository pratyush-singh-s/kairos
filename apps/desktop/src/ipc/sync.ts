import { invoke } from "@tauri-apps/api/core";

/** Mirrors `Me` in crates/focus-sync/src/lib.rs. */
export interface SyncMe {
  deviceId: string;
  name: string;
  kind: "pc" | "phone";
  appVersion: string;
  schema: number;
}

/** Mirrors `LastSync` in crates/focus-sync/src/service.rs. */
export interface SyncLast {
  atMs: number;
  ok: boolean;
  message: string;
  sent: number;
  received: number;
  conflicts: number;
  clockSkewMs: number;
  /** Attached files sent and received. */
  files: number;
}

/** Mirrors `PeerView` (a `Peer` from focus-store plus online and last). */
export interface SyncPeer {
  deviceId: string;
  name: string;
  kind: "pc" | "phone";
  pairedAt: number;
  lastSyncedAt: number | null;
  address: string | null;
  online: boolean;
  last: SyncLast | null;
}

/** Mirrors `Nearby` in crates/focus-sync/src/discovery.rs. */
export interface SyncNearby {
  deviceId: string;
  name: string;
  kind: "pc" | "phone";
  address: string;
  pairing: boolean;
}

/** Mirrors `Progress` in crates/focus-sync/src/session.rs. */
export interface SyncProgress {
  peerId: string;
  peerName: string;
  /** In the file stages, rows are files. */
  stage: "connecting" | "sending" | "receiving" | "applying" | "sending-files" | "receiving-files";
  rowsDone: number;
  rowsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** The attached file on its way, in the file stages. */
  fileName?: string;
}

export interface PairOffer {
  code: string;
  expiresAtMs: number;
}

/** Mirrors `Status` in crates/focus-sync/src/service.rs. */
export interface SyncStatus {
  me: SyncMe;
  addresses: string[];
  port: number;
  peers: SyncPeer[];
  nearby: SyncNearby[];
  offer: PairOffer | null;
  progress: SyncProgress | null;
  listenError: string | null;
  /** Pairing by Google account; null = not built into this release. */
  account: SyncAccount | null;
}

/** Mirrors `AccountView` in crates/focus-sync/src/account.rs. */
export interface SyncAccount {
  /** "" = this device isn't signed in with Google. */
  email: string;
  devices: { deviceId: string; name: string; kind: "pc" | "phone"; skipped: boolean }[];
  checkedAtMs: number;
  error: string | null;
}

export interface PeerInfo {
  deviceId: string;
  name: string;
  kind: string;
}

export const syncStatus = () => invoke<SyncStatus>("sync_status");
export const syncShowCode = () => invoke<PairOffer>("sync_show_code");
export const syncCancelCode = () => invoke<void>("sync_cancel_code");
export const syncPair = (address: string, code: string) => invoke<PeerInfo>("sync_pair", { address, code });
export const syncNow = (deviceId?: string) => invoke<void>("sync_now", { deviceId: deviceId ?? null });
export const syncForget = (deviceId: string) => invoke<void>("sync_forget", { deviceId });
/** Look for this Gmail's other devices now. */
export const syncAccountCheck = () => invoke<void>("sync_account_check");
/** Let a forgotten device of the same Gmail pair again. */
export const syncAccountAllow = (deviceId: string) => invoke<void>("sync_account_allow", { deviceId });
export const syncSetName = (name: string) => invoke<void>("sync_set_name", { name });

/** Windows Firewall lets other devices reach this PC (always true on the phone, which has no such command). */
export const syncFirewallAllowed = () => invoke<boolean>("sync_firewall_allowed").catch(() => true);
/** Asks Windows for admin and lets Focus through the firewall; true when it worked. */
export const syncAllowFirewall = () => invoke<boolean>("sync_allow_firewall");
