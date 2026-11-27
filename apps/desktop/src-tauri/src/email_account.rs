//! A Kairos account with an email and a password (0.21.103.B), next to "Sign in with Google".
//!
//! Accounts live in the same Firebase project as the users count and Gmail pairing (users.rs,
//! KAIROS_FIREBASE_PROJECT / _KEY), so an email account is counted in Kairos users and pairs a PC
//! and phone exactly like a Google sign-in does. Firebase keeps the password; this PC only keeps
//! Firebase's refresh token, in Windows Credential Manager. The database rules only trust a
//! confirmed email, so a new account is counted once its verification link has been opened.
//!
//! Google stays the way to sync Google Calendar. When both are signed in, Google is used.

use focus_store::settings;
use focus_sync::account::{self as fb_account, EmailSignIn};
use focus_sync::{Firebase, Session};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::google::credential;
use crate::state::StoreState;

/// Where the Firebase refresh token is kept in Windows Credential Manager.
const CREDENTIAL: &str = "Kairos/account-refresh-token";

fn firebase() -> Option<Firebase> {
    crate::users::config().map(|(project, key)| Firebase { project: project.into(), key: key.into() })
}

fn need_firebase() -> Result<Firebase, String> {
    firebase().ok_or_else(|| "Email login isn't built into this version of Kairos.".into())
}

/// What Settings shows. Mirrored by `EmailAccount` in src/ipc/account.ts.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmailStatus {
    /// Email login is built into this release.
    pub built_in: bool,
    pub email: Option<String>,
    pub name: Option<String>,
    /// The verification link was opened.
    pub verified: bool,
}

fn get_str(s: &focus_store::Store, key: &str) -> String {
    settings::get::<serde_json::Value>(s, key).ok().and_then(|v| v.as_str().map(|t| t.trim().to_string())).unwrap_or_default()
}

pub fn status(s: &focus_store::Store) -> EmailStatus {
    let email = get_str(s, "account.email");
    let signed_in = !email.is_empty() && credential::read(CREDENTIAL).is_some();
    let name = get_str(s, "account.name");
    EmailStatus {
        built_in: firebase().is_some(),
        email: signed_in.then_some(email),
        name: (signed_in && !name.is_empty()).then_some(name),
        verified: signed_in && settings::get::<bool>(s, "account.verified").unwrap_or(false),
    }
}

fn app_status(app: &AppHandle) -> EmailStatus {
    app.state::<StoreState>().with(|s| Ok::<_, String>(status(s))).unwrap_or_default()
}

/// The first name to greet with when there's no Google name.
pub fn name(app: &AppHandle) -> Option<String> {
    app_status(app).name
}

fn save(app: &AppHandle, account: &EmailSignIn) -> Result<(), String> {
    credential::write(CREDENTIAL, &account.session.refresh_token)?;
    app.state::<StoreState>().with(|s| {
        settings::set(s, "account.email", &account.session.email).map_err(|e| e.to_string())?;
        if !account.name.is_empty() {
            settings::set(s, "account.name", &account.name).map_err(|e| e.to_string())?;
        }
        settings::set(s, "account.verified", &account.verified).map_err(|e| e.to_string())
    })
}

/// Once the email is confirmed: count it in Kairos users and pair with its other devices.
fn announce(app: &AppHandle) {
    if app_status(app).verified {
        crate::users::signed_in(app);
        crate::sync::account_poke(app);
    }
    let _ = app.emit("google-changed", ());
}

/// A fresh Firebase sign-in for the email account (None when not signed in or not confirmed).
fn email_session(app: &AppHandle, fb: &Firebase) -> Result<Option<Session>, String> {
    let st = app_status(app);
    if st.email.is_none() || !st.verified {
        return Ok(None);
    }
    let refresh = credential::read(CREDENTIAL).ok_or("Log in to your Kairos account again.")?;
    let session = fb_account::refresh(fb, &refresh).map_err(|_| "Your Kairos login ran out. Log in again in Settings.".to_string())?;
    if !session.refresh_token.is_empty() && session.refresh_token != refresh {
        credential::write(CREDENTIAL, &session.refresh_token)?;
    }
    Ok(Some(session))
}

/// The account this device is signed in with: Google first, else a confirmed email account.
pub fn current_email(app: &AppHandle) -> Option<String> {
    let google = app.state::<StoreState>().with(|s| crate::google::status(s)).ok().and_then(|st| st.email);
    google.or_else(|| {
        let st = app_status(app);
        st.verified.then_some(st.email).flatten()
    })
}

/// A Firebase sign-in for whichever account is signed in (for users.rs and Gmail pairing).
pub fn firebase_session(app: &AppHandle) -> Result<Option<Session>, String> {
    let fb = need_firebase()?;
    let google = app.state::<StoreState>().with(|s| crate::google::status(s)).ok().and_then(|st| st.email);
    if google.is_some() {
        let session = fb_account::sign_in_with_google(&fb, &crate::google::id_token(app)?)
            .map_err(|e| format!("{e} Sign out of Google in Settings and sign in again."))?;
        return Ok(Some(session));
    }
    email_session(app, &fb)
}

/// The name to show with the account (Google's first name, else the account's name).
pub fn display_name(app: &AppHandle) -> String {
    let google = app.state::<StoreState>().with(|s| crate::google::status(s)).ok();
    match google {
        Some(st) if st.email.is_some() => st.name.unwrap_or_default(),
        _ => name(app).unwrap_or_default(),
    }
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

fn check_email(email: &str) -> Result<(), String> {
    let e = email.trim();
    if e.len() < 3 || !e.contains('@') || e.contains(' ') {
        return Err("That email doesn't look right.".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn account_status(app: AppHandle) -> EmailStatus {
    app_status(&app)
}

#[tauri::command]
pub async fn account_sign_up(app: AppHandle, email: String, password: String, name: String) -> Result<EmailStatus, String> {
    check_email(&email)?;
    if password.chars().count() < 6 {
        return Err("Use a password of at least 6 characters.".into());
    }
    blocking(move || {
        let account = fb_account::sign_up(&need_firebase()?, &email, &password, &name)?;
        save(&app, &account)?;
        announce(&app);
        Ok(app_status(&app))
    })
    .await
}

#[tauri::command]
pub async fn account_sign_in(app: AppHandle, email: String, password: String) -> Result<EmailStatus, String> {
    check_email(&email)?;
    blocking(move || {
        let account = fb_account::sign_in_with_password(&need_firebase()?, &email, &password)?;
        save(&app, &account)?;
        announce(&app);
        Ok(app_status(&app))
    })
    .await
}

/// "I've opened the link": asks Firebase again whether the email is confirmed.
#[tauri::command]
pub async fn account_check_verified(app: AppHandle) -> Result<EmailStatus, String> {
    blocking(move || {
        let fb = need_firebase()?;
        let refresh = credential::read(CREDENTIAL).ok_or("Log in to your Kairos account again.")?;
        let session = fb_account::refresh(&fb, &refresh).map_err(|_| "Your Kairos login ran out. Log in again.".to_string())?;
        if !session.refresh_token.is_empty() && session.refresh_token != refresh {
            credential::write(CREDENTIAL, &session.refresh_token)?;
        }
        let verified = fb_account::email_verified(&session.id_token);
        app.state::<StoreState>().with(|s| settings::set(s, "account.verified", &verified).map_err(|e| e.to_string()))?;
        if verified {
            announce(&app);
        }
        Ok(app_status(&app))
    })
    .await
}

#[tauri::command]
pub async fn account_resend_verification() -> Result<(), String> {
    blocking(move || {
        let fb = need_firebase()?;
        let refresh = credential::read(CREDENTIAL).ok_or("Log in to your Kairos account again.")?;
        let session = fb_account::refresh(&fb, &refresh).map_err(|_| "Your Kairos login ran out. Log in again.".to_string())?;
        fb_account::send_verification(&fb, &session.id_token)
    })
    .await
}

#[tauri::command]
pub async fn account_reset_password(email: String) -> Result<(), String> {
    check_email(&email)?;
    blocking(move || fb_account::send_password_reset(&need_firebase()?, &email)).await
}

#[tauri::command]
pub async fn account_sign_out(app: AppHandle) -> Result<(), String> {
    blocking(move || {
        let google_signed_in = app.state::<StoreState>().with(|s| crate::google::status(s)).ok().and_then(|st| st.email).is_some();
        if !google_signed_in {
            // While still signed in: take this PC off the account's device list.
            crate::sync::account_leave(&app);
        }
        credential::delete(CREDENTIAL)?;
        app.state::<StoreState>().with(|s| {
            settings::set(s, "account.email", &serde_json::Value::Null).map_err(|e| e.to_string())?;
            settings::set(s, "account.name", &"").map_err(|e| e.to_string())?;
            settings::set(s, "account.verified", &false).map_err(|e| e.to_string())
        })?;
        let _ = app.emit("google-changed", ());
        Ok(())
    })
    .await
}
