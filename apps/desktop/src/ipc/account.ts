import { invoke } from "@tauri-apps/api/core";

/** Mirrors `EmailStatus` in src-tauri/src/email_account.rs. */
export interface EmailAccount {
  /** Email login is built into this release. */
  builtIn: boolean;
  email: string | null;
  name: string | null;
  /** The verification link was opened. */
  verified: boolean;
}

export const getEmailAccount = () => invoke<EmailAccount>("account_status");
export const emailSignUp = (email: string, password: string, name: string) => invoke<EmailAccount>("account_sign_up", { email, password, name });
export const emailSignIn = (email: string, password: string) => invoke<EmailAccount>("account_sign_in", { email, password });
export const checkEmailVerified = () => invoke<EmailAccount>("account_check_verified");
export const resendVerification = () => invoke<void>("account_resend_verification");
export const resetPassword = (email: string) => invoke<void>("account_reset_password", { email });
export const emailSignOut = () => invoke<void>("account_sign_out");
