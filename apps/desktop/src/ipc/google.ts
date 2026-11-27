import { invoke } from "@tauri-apps/api/core";

/** Mirrors `GoogleStatus` in src-tauri/src/google.rs. */
export interface GoogleStatus {
  /** A client ID has been saved. */
  configured: boolean;
  /** The client built into the release is used (no client ID saved). */
  builtIn?: boolean;
  clientId: string;
  /** The signed-in account; null = not connected. */
  email: string | null;
  /** First name from Google (signed in with 0.21.90.B or later), for the dashboard greeting. */
  name?: string | null;
  /** Scopes Google granted, space separated. */
  scopes: string;
  /** Calendar access was granted. */
  calendar: boolean;
}

export const getGoogleStatus = () => invoke<GoogleStatus>("google_status");
export const saveGoogleClient = (clientId: string, clientSecret: string) =>
  invoke<GoogleStatus>("save_google_client", { clientId, clientSecret });
/** Opens Google's page in the browser and resolves once you have signed in there (or fails). */
export const googleSignIn = () => invoke<GoogleStatus>("google_sign_in");
export const cancelGoogleSignIn = () => invoke<void>("google_cancel_sign_in");
export const googleSignOut = () => invoke<void>("google_sign_out");
