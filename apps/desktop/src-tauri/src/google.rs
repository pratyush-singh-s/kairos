//! Google sign-in for a desktop app: Google's page opens in your browser, you sign in there, and
//! Google sends a one-time code back to a port on this PC (127.0.0.1). Focus trades the code for
//! tokens (with PKCE, so a stolen code is useless). Focus never sees your password.
//!
//! The long-lived refresh token is kept in Windows Credential Manager, not in the database.
//! Your Google client ID and secret (made in your own Google Cloud project, see GOOGLE-SETUP.md)
//! and the signed-in email are local settings: each PC signs in for itself.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use focus_store::settings;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::StoreState;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
/// Sign-in only asks who you are. Calendar access is asked for separately when you turn it on.
/// "profile" gives the first name for the dashboard greeting (0.21.90.B).
pub const SIGN_IN_SCOPES: &str = "openid email profile";
/// Asked for by "Connect Google Calendar": read and change events, list your calendars (holidays
/// included), read your time zone and week start, and make the "Focus" calendar. One broad scope,
/// because Google rejected the narrower ones (calendar.app.created and friends) with a bare
/// "Error 400: invalid_request" for a Testing-mode app.
pub const CALENDAR_SCOPES: &str = "https://www.googleapis.com/auth/calendar";
/// The error when Google no longer accepts the sign-in; Settings and the Calendar page offer Reconnect.
pub const EXPIRED: &str = "Google sign-in has expired or was removed. Press Reconnect.";
/// How long Focus waits for you to finish on Google's page.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// A client built into the release (set KAIROS_GOOGLE_CLIENT_ID / _SECRET when building), so
/// "Sign in with Google" works with no setup. A client ID saved in Settings wins over it.
const BUILT_IN_ID: Option<&str> = option_env!("KAIROS_GOOGLE_CLIENT_ID");
const BUILT_IN_SECRET: Option<&str> = option_env!("KAIROS_GOOGLE_CLIENT_SECRET");

fn built_in() -> Option<(String, String)> {
    let id = BUILT_IN_ID?.trim();
    (!id.is_empty()).then(|| (id.to_string(), BUILT_IN_SECRET.unwrap_or_default().trim().to_string()))
}

/// Where the refresh token is kept in Windows Credential Manager.
const CREDENTIAL: &str = "Focus/google-refresh-token";

/// Set by "Cancel" while Focus waits for the browser.
pub struct GoogleState {
    cancel: AtomicBool,
    busy: AtomicBool,
    /// The current short-lived access token and when it stops working.
    token: Mutex<Option<(String, Instant)>>,
}

impl GoogleState {
    pub fn new() -> Self {
        Self { cancel: AtomicBool::new(false), busy: AtomicBool::new(false), token: Mutex::new(None) }
    }
}

/// What Settings shows. Mirrored by `GoogleStatus` in src/ipc/google.ts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    /// A client ID has been saved (or one is built in).
    pub configured: bool,
    /// The built-in client is used (no client ID saved in Settings).
    pub built_in: bool,
    pub client_id: String,
    /// The signed-in account; None = not connected.
    pub email: Option<String>,
    /// First name from Google, for "Good afternoon, Ps". None before 0.21.90.B sign-ins.
    pub name: Option<String>,
    /// Scopes Google granted, space separated.
    pub scopes: String,
    /// Calendar access was granted.
    pub calendar: bool,
}

/// Every Calendar scope is among the granted ones.
pub fn has_calendar(scopes: &str) -> bool {
    let granted: Vec<&str> = scopes.split_whitespace().collect();
    CALENDAR_SCOPES.split_whitespace().all(|s| granted.contains(&s))
}

pub fn status(store: &focus_store::Store) -> Result<GoogleStatus, String> {
    let get = |k: &str| settings::get::<serde_json::Value>(store, k).map_err(|e| e.to_string());
    let client_id = get("google.clientId")?.as_str().unwrap_or_default().to_string();
    let email = get("google.email")?.as_str().map(String::from).filter(|e| !e.is_empty());
    let email = email.filter(|_| read_credential().is_some());
    let scopes = get("google.scopes")?.as_str().unwrap_or_default().to_string();
    let name = get("google.name")?.as_str().map(|n| n.trim().to_string()).filter(|n| !n.is_empty() && email.is_some());
    Ok(GoogleStatus { configured: !client_id.is_empty() || built_in().is_some(), built_in: client_id.is_empty() && built_in().is_some(), client_id, calendar: email.is_some() && has_calendar(&scopes), email, name, scopes })
}

/// Checks and saves your client ID and secret (from Google Cloud → Credentials → Desktop app).
pub fn save_client(store: &mut focus_store::Store, client_id: &str, client_secret: &str) -> Result<(), String> {
    let id = client_id.trim();
    let secret = client_secret.trim();
    if !id.ends_with(".apps.googleusercontent.com") || id.contains(char::is_whitespace) {
        return Err("the client ID should end with .apps.googleusercontent.com".into());
    }
    if secret.is_empty() || secret.len() > 200 || secret.contains(char::is_whitespace) {
        return Err("paste the client secret shown next to the client ID".into());
    }
    settings::set(store, "google.clientId", &id).map_err(|e| e.to_string())?;
    settings::set(store, "google.clientSecret", &secret).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- pure helpers (tested)

/// A random URL-safe string (for the PKCE verifier and the state check).
fn random_token(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("could not make a random code: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// The PKCE challenge Google checks the verifier against: base64url(sha256(verifier)).
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Google's sign-in page address.
pub fn auth_url(client_id: &str, redirect_uri: &str, scopes: &str, challenge: &str, state: &str, login_hint: Option<&str>) -> String {
    let mut url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent&include_granted_scopes=true",
        encode(client_id),
        encode(redirect_uri),
        encode(scopes),
        encode(challenge),
        encode(state),
    );
    if let Some(hint) = login_hint {
        url.push_str(&format!("&login_hint={}", encode(hint)));
    }
    url
}

/// What came back to the loopback port.
#[derive(Debug, PartialEq, Eq)]
pub enum Redirect {
    Code { code: String, state: String },
    /// "access_denied" when you press Cancel on Google's page.
    Error(String),
    /// Something else asked (e.g. /favicon.ico); keep waiting.
    Other,
}

/// Reads the first line of the browser's request: "GET /?code=...&state=... HTTP/1.1".
pub fn parse_redirect(request_line: &str) -> Redirect {
    let Some(target) = request_line.split_whitespace().nth(1) else { return Redirect::Other };
    let Some((path, query)) = target.split_once('?') else { return Redirect::Other };
    if path != "/" {
        return Redirect::Other;
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "code" => code = Some(decode(v)),
            "state" => state = Some(decode(v)),
            "error" => error = Some(decode(v)),
            _ => {}
        }
    }
    match (error, code, state) {
        (Some(e), _, _) => Redirect::Error(e),
        (None, Some(code), Some(state)) => Redirect::Code { code, state },
        _ => Redirect::Other,
    }
}

/// The email inside Google's ID token. The token comes straight from Google over HTTPS, so its
/// signature does not need checking here; only the email is read from it.
pub fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("email")?.as_str().map(String::from)
}

/// The first name inside Google's ID token (needs the "profile" scope), else the full name.
pub fn name_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let pick = |k: &str| claims.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    pick("given_name").or_else(|| pick("name"))
}

/// Turns Google's error codes into something a person can act on.
pub fn explain(error: &str) -> String {
    match error {
        "access_denied" => "Sign-in was cancelled on Google's page.".into(),
        "invalid_client" | "unauthorized_client" => {
            "Google did not accept the client ID or secret. Check them in Settings (GOOGLE-SETUP.md, step 4).".into()
        }
        "invalid_grant" => "Google refused the sign-in code (it may have expired). Please connect again.".into(),
        "org_internal" | "admin_policy_enforced" => "This Google account is not allowed to use this client.".into(),
        e if e.contains("redirect_uri") => "Google rejected the return address. Make sure the client type is \"Desktop app\".".into(),
        e => format!("Google said: {e}"),
    }
}

// ---------------------------------------------------------------- the sign-in itself

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

fn post_form(url: &str, form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let body = form.iter().map(|(k, v)| format!("{}={}", encode(k), encode(v))).collect::<Vec<_>>().join("&");
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut response = agent
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send(body)
        .map_err(|e| format!("could not reach Google ({e}). Check your internet connection."))?;
    let text = response.body_mut().read_to_string().map_err(|e| format!("Google's answer could not be read: {e}"))?;
    serde_json::from_str(&text).map_err(|_| format!("Google's answer could not be read: {}", text.chars().take(200).collect::<String>()))
}

fn client(app: &AppHandle) -> Result<(String, String), String> {
    app.state::<StoreState>().with(|store| {
        let get = |k: &str| settings::get::<String>(store, k).map_err(|e| e.to_string());
        let (id, secret) = (get("google.clientId")?, get("google.clientSecret")?);
        if id.is_empty() {
            return built_in().ok_or_else(|| "add your Google client ID in Settings first".to_string());
        }
        Ok((id, secret))
    })
}

/// Waits for Google to send the browser back with a code. Stops on Cancel or after 5 minutes.
fn wait_for_code(app: &AppHandle, listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let google = app.state::<GoogleState>();
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    loop {
        if google.cancel.load(Ordering::SeqCst) {
            return Err("Sign-in was cancelled.".into());
        }
        if Instant::now() > deadline {
            return Err("Sign-in timed out. Press Connect to try again.".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut line = String::new();
                let _ = BufReader::new(&stream).read_line(&mut line);
                match parse_redirect(&line) {
                    Redirect::Other => reply(stream, 404, "Not here."),
                    Redirect::Error(e) => {
                        reply(stream, 200, "Sign-in was cancelled. You can close this tab.");
                        return Err(explain(&e));
                    }
                    Redirect::Code { code, state } => {
                        if state != expected_state {
                            reply(stream, 400, "This sign-in link is out of date. Go back to Kairos and press Connect again.");
                            return Err("The sign-in answer did not match (old browser tab?). Please connect again.".into());
                        }
                        reply(stream, 200, "Kairos is connected to your Google account. You can close this tab and go back to Kairos.");
                        return Ok(code);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("the sign-in listener stopped: {e}")),
        }
    }
}

fn reply(mut stream: TcpStream, status: u16, message: &str) {
    let page = format!(
        "<!doctype html><meta charset=utf-8><title>Kairos</title><body style=\"font:16px system-ui;background:#0c1120;color:#eef1f6;display:grid;place-items:center;height:90vh\"><p>{message}</p></body>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status} OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
}

/// The whole sign-in, run off the main thread: open Google's page, wait, trade the code, save.
/// `scopes` lets a later phase ask for Calendar on top of the sign-in.
pub fn sign_in(app: &AppHandle, scopes: &str) -> Result<GoogleStatus, String> {
    let google = app.state::<GoogleState>();
    // Pressing Connect again replaces an attempt still waiting (e.g. Google showed "Access
    // blocked", which never comes back to Focus).
    if google.busy.swap(true, Ordering::SeqCst) {
        google.cancel.store(true, Ordering::SeqCst);
        let until = Instant::now() + Duration::from_secs(3);
        while google.busy.swap(true, Ordering::SeqCst) {
            if Instant::now() > until {
                return Err("Sign-in is already waiting in your browser.".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    google.cancel.store(false, Ordering::SeqCst);
    let result = (|| {
        let (client_id, client_secret) = client(app)?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("could not open a local port for sign-in: {e}"))?;
        let redirect_uri = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
        let verifier = random_token(48)?;
        let state = random_token(16)?;
        let hint = app.state::<StoreState>().with(|s| Ok(status(s)?.email))?;
        let url = auth_url(&client_id, &redirect_uri, scopes, &pkce_challenge(&verifier), &state, hint.as_deref());
        open_in_browser(&url)?;

        let code = wait_for_code(app, &listener, &state)?;
        let tokens = post_form(
            TOKEN_URL,
            &[
                ("code", &code),
                ("client_id", &client_id),
                ("client_secret", &client_secret),
                ("code_verifier", &verifier),
                ("grant_type", "authorization_code"),
                ("redirect_uri", &redirect_uri),
            ],
        )?;
        if let Some(e) = tokens.error {
            return Err(format!("{} {}", explain(&e), tokens.error_description.unwrap_or_default()).trim().to_string());
        }
        let refresh = tokens.refresh_token.ok_or("Google did not send a lasting sign-in. Please connect again.")?;
        let email = tokens.id_token.as_deref().and_then(email_from_id_token).unwrap_or_default();
        let name = tokens.id_token.as_deref().and_then(name_from_id_token).unwrap_or_default();
        write_credential(&refresh)?;
        remember_token(app, tokens.access_token, tokens.expires_in);
        let status = app.state::<StoreState>().with(|s| {
            settings::set(s, "google.email", &email).map_err(|e| e.to_string())?;
            settings::set(s, "google.name", &name).map_err(|e| e.to_string())?;
            settings::set(s, "google.scopes", &tokens.scope.unwrap_or_default()).map_err(|e| e.to_string())?;
            status(s)
        })?;
        // Count the account, and pair with this Gmail's other devices (the phone) straight away.
        crate::users::signed_in(app);
        crate::sync::account_poke(app);
        Ok(status)
    })();
    google.busy.store(false, Ordering::SeqCst);
    if result.is_ok() {
        let _ = app.emit("google-changed", ());
    }
    result
}

/// Stops waiting for the browser.
pub fn cancel(app: &AppHandle) {
    app.state::<GoogleState>().cancel.store(true, Ordering::SeqCst);
}

fn remember_token(app: &AppHandle, token: Option<String>, expires_in: Option<u64>) {
    let until = Instant::now() + Duration::from_secs(expires_in.unwrap_or(3600).saturating_sub(120));
    *app.state::<GoogleState>().token.lock().unwrap() = token.map(|t| (t, until));
}

/// Drops the access token, e.g. after Google answered 401; the next call gets a new one.
pub fn forget_access_token(app: &AppHandle) {
    remember_token(app, None, None);
}

/// An access token for calling Google, made fresh from the stored sign-in when the last one is
/// about to run out. Fails with `EXPIRED` when Google no longer accepts the sign-in.
pub fn access_token(app: &AppHandle) -> Result<String, String> {
    if let Some((token, until)) = app.state::<GoogleState>().token.lock().unwrap().clone()
        && Instant::now() < until
    {
        return Ok(token);
    }
    let refresh = read_credential().ok_or("Kairos is not connected to Google. Connect it in Settings.")?;
    let (client_id, client_secret) = client(app)?;
    let tokens = post_form(
        TOKEN_URL,
        &[("refresh_token", &refresh), ("client_id", &client_id), ("client_secret", &client_secret), ("grant_type", "refresh_token")],
    )?;
    if let Some(e) = tokens.error {
        return Err(if e == "invalid_grant" { EXPIRED.into() } else { explain(&e) });
    }
    let token = tokens.access_token.ok_or("Google did not send an access token.")?;
    remember_token(app, Some(token.clone()), tokens.expires_in);
    Ok(token)
}

/// A fresh ID token (Google's signed "this is who you are"), for Kairos users (users.rs).
pub fn id_token(app: &AppHandle) -> Result<String, String> {
    let refresh = read_credential().ok_or("Kairos is not signed in to Google.")?;
    let (client_id, client_secret) = client(app)?;
    let tokens = post_form(
        TOKEN_URL,
        &[("refresh_token", &refresh), ("client_id", &client_id), ("client_secret", &client_secret), ("grant_type", "refresh_token")],
    )?;
    if let Some(e) = tokens.error {
        return Err(if e == "invalid_grant" { EXPIRED.into() } else { explain(&e) });
    }
    remember_token(app, tokens.access_token, tokens.expires_in);
    tokens.id_token.ok_or_else(|| "Google did not say who is signed in.".to_string())
}

/// Disconnects: tells Google to forget the sign-in, then removes it from this PC.
pub fn sign_out(app: &AppHandle) -> Result<(), String> {
    // While still signed in: take this PC off the account's device list.
    crate::sync::account_leave(app);
    if let Some(token) = read_credential() {
        // Best effort: even if Google cannot be reached, this PC forgets the sign-in.
        let _ = post_form(REVOKE_URL, &[("token", &token)]);
    }
    delete_credential()?;
    forget_access_token(app);
    app.state::<StoreState>().with(|s| {
        settings::set(s, "google.email", &serde_json::Value::Null).map_err(|e| e.to_string())?;
        settings::set(s, "google.name", &"").map_err(|e| e.to_string())?;
        settings::set(s, "google.scopes", &"").map_err(|e| e.to_string())?;
        settings::set(s, "google.focusCalendarId", &"").map_err(|e| e.to_string())?;
        // With Kairos's own client built in, the next sign-in uses it (a client pasted in
        // Settings from another Google project can't pair by Gmail).
        if built_in().is_some() {
            settings::set(s, "google.clientId", &"").map_err(|e| e.to_string())?;
            settings::set(s, "google.clientSecret", &"").map_err(|e| e.to_string())?;
        }
        // Calendar events copied from Google go too; Google keeps them.
        focus_store::calendar::clear(s.conn()).map_err(|e| e.to_string())
    })?;
    let _ = app.emit("calendar-changed", ());
    crate::gcal::wake(app);
    let _ = app.emit("google-changed", ());
    Ok(())
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn google_status(state: tauri::State<'_, StoreState>) -> Result<GoogleStatus, String> {
    state.with(|s| status(s))
}

#[tauri::command]
pub fn save_google_client(app: AppHandle, state: tauri::State<'_, StoreState>, client_id: String, client_secret: String) -> Result<GoogleStatus, String> {
    let result = state.with(|s| {
        save_client(s, &client_id, &client_secret)?;
        status(s)
    });
    if result.is_ok() {
        let _ = app.emit("google-changed", ());
    }
    result
}

/// Async and on a worker thread: it waits up to 5 minutes for the browser.
#[tauri::command]
pub async fn google_sign_in(app: AppHandle) -> Result<GoogleStatus, String> {
    // Reconnecting keeps Calendar if it was connected.
    let had_calendar = app.state::<StoreState>().with(|s| Ok(has_calendar(&status(s)?.scopes)))?;
    let scopes = if had_calendar { format!("{SIGN_IN_SCOPES} {CALENDAR_SCOPES}") } else { SIGN_IN_SCOPES.to_string() };
    let handle = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || sign_in(&handle, &scopes)).await.map_err(|e| e.to_string())??;
    crate::gcal::wake(&app);
    Ok(status)
}

/// Asks Google for Calendar access on top of the sign-in, then fetches your calendars.
#[tauri::command]
pub async fn google_connect_calendar(app: AppHandle) -> Result<GoogleStatus, String> {
    let scopes = format!("{SIGN_IN_SCOPES} {CALENDAR_SCOPES}");
    let handle = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || sign_in(&handle, &scopes)).await.map_err(|e| e.to_string())??;
    if !status.calendar {
        return Err("Google did not give Calendar access. Press Connect Google Calendar again and tick every box on Google's page.".into());
    }
    crate::gcal::wake(&app);
    Ok(status)
}

#[tauri::command]
pub fn google_cancel_sign_in(app: AppHandle) {
    cancel(&app);
}

#[tauri::command]
pub async fn google_sign_out(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sign_out(&app)).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- Windows plumbing

#[cfg(windows)]
fn open_in_browser(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, target) = (wide("open"), wide(url));
    // SAFETY: both strings are NUL-terminated UTF-16 that live until the call returns.
    let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    if (result as isize) <= 32 {
        return Err("could not open your web browser for sign-in".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_in_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ()).map_err(|e| format!("could not open a browser: {e}"))
}

#[cfg(windows)]
pub(crate) mod credential {
    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME, GetLastError};
    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn write(target: &str, secret: &str) -> Result<(), String> {
        let mut name = wide(target);
        let mut user = wide("Focus");
        let mut blob = secret.as_bytes().to_vec();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: name.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user.as_mut_ptr(),
        };
        // SAFETY: every pointer in `cred` points into buffers that outlive the call.
        if unsafe { CredWriteW(&cred, 0) } == 0 {
            return Err(format!("could not save the sign-in in Windows Credential Manager (error {})", unsafe { GetLastError() }));
        }
        Ok(())
    }

    pub fn read(target: &str) -> Option<String> {
        let name = wide(target);
        let mut out: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `name` is NUL-terminated; `out` is freed with CredFree below.
        if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut out) } == 0 || out.is_null() {
            return None;
        }
        let value = unsafe {
            let c = &*out;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
            String::from_utf8(bytes.to_vec()).ok()
        };
        unsafe { CredFree(out as *const _) };
        value
    }

    pub fn delete(target: &str) -> Result<(), String> {
        let name = wide(target);
        // SAFETY: `name` is NUL-terminated.
        if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            let err = unsafe { GetLastError() };
            if err != ERROR_NOT_FOUND {
                return Err(format!("could not remove the sign-in from Windows Credential Manager (error {err})"));
            }
        }
        Ok(())
    }
}

/// Elsewhere (development on Linux) the token is only kept in memory.
#[cfg(not(windows))]
pub(crate) mod credential {
    use std::sync::Mutex;
    static STORE: Mutex<Option<String>> = Mutex::new(None);
    pub fn write(_: &str, secret: &str) -> Result<(), String> {
        *STORE.lock().unwrap() = Some(secret.to_string());
        Ok(())
    }
    pub fn read(_: &str) -> Option<String> {
        STORE.lock().unwrap().clone()
    }
    pub fn delete(_: &str) -> Result<(), String> {
        *STORE.lock().unwrap() = None;
        Ok(())
    }
}

fn write_credential(token: &str) -> Result<(), String> {
    credential::write(CREDENTIAL, token)
}
fn read_credential() -> Option<String> {
    credential::read(CREDENTIAL)
}
fn delete_credential() -> Result<(), String> {
    credential::delete(CREDENTIAL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_the_rfc_example() {
        // RFC 7636 appendix B.
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let a = random_token(48).unwrap();
        assert!(a.len() >= 43 && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(a, random_token(48).unwrap());
    }

    #[test]
    fn auth_url_carries_everything_google_needs() {
        let url = auth_url("123.apps.googleusercontent.com", "http://127.0.0.1:5000", "openid email", "abc", "xyz", Some("me@gmail.com"));
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com"));
        for part in [
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A5000",
            "scope=openid%20email",
            "code_challenge=abc",
            "code_challenge_method=S256",
            "state=xyz",
            "access_type=offline",
            "login_hint=me%40gmail.com",
        ] {
            assert!(url.contains(part), "{part}");
        }
    }

    #[test]
    fn redirect_requests_are_read() {
        assert_eq!(
            parse_redirect("GET /?state=xyz&code=4%2F0Ab_c&scope=email HTTP/1.1\r\n"),
            Redirect::Code { code: "4/0Ab_c".into(), state: "xyz".into() }
        );
        assert_eq!(parse_redirect("GET /?error=access_denied&state=xyz HTTP/1.1"), Redirect::Error("access_denied".into()));
        assert_eq!(parse_redirect("GET /favicon.ico HTTP/1.1"), Redirect::Other);
        assert_eq!(parse_redirect("GET /?code=only HTTP/1.1"), Redirect::Other);
        assert_eq!(parse_redirect(""), Redirect::Other);
    }

    #[test]
    fn email_is_read_from_the_id_token() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"email":"ps@gmail.com","email_verified":true}"#);
        assert_eq!(email_from_id_token(&format!("h.{payload}.sig")).as_deref(), Some("ps@gmail.com"));
        assert_eq!(email_from_id_token("not-a-token"), None);
        let named = URL_SAFE_NO_PAD.encode(br#"{"email":"ps@gmail.com","name":"Ps Singh","given_name":"Ps"}"#);
        assert_eq!(name_from_id_token(&format!("h.{named}.sig")).as_deref(), Some("Ps"));
        assert_eq!(name_from_id_token(&format!("h.{payload}.sig")), None);
    }

    #[test]
    fn calendar_needs_every_scope() {
        assert!(has_calendar(&format!("openid {CALENDAR_SCOPES} email")));
        assert!(!has_calendar("openid email https://www.googleapis.com/auth/calendar.events"));
    }

    #[test]
    fn errors_are_explained() {
        assert!(explain("access_denied").contains("cancelled"));
        assert!(explain("invalid_client").contains("client ID"));
        assert!(explain("something_new").contains("something_new"));
    }

    #[test]
    fn credential_round_trip() {
        write_credential("1//token").unwrap();
        assert_eq!(read_credential().as_deref(), Some("1//token"));
        delete_credential().unwrap();
        assert_eq!(read_credential(), None);
        delete_credential().unwrap();
    }
}
