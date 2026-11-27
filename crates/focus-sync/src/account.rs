//! Pairing by Google account: a PC and a phone signed in with the same Gmail find and pair with
//! each other on their own, without typing a code.
//!
//! Each signed-in device writes one small document to the Kairos Firebase project (Firestore):
//! `accounts/{email}/devices/{device id}` = its name, "pc"/"phone", its sync public key and its
//! Wi-Fi addresses. It then reads the other documents under the same email and saves each of those
//! devices as paired (`focus_store::sync::save_peer`), exactly as typing the 6-digit code would.
//!
//! Why this is safe: the database rules (docs/firestore.rules) let only someone signed in to
//! Firebase as that Gmail read or write `accounts/{that email}`, and Firebase only signs someone
//! in as a Gmail with a Google sign-in for it. So a public key in that list was put there by one
//! of your own devices. Syncing itself still goes straight between the devices on the Wi-Fi,
//! encrypted with those keys (the Noise handshake checks them); nothing else goes to Firebase.

use std::time::Duration;

use focus_store::{Store, local};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Me;

/// The Firebase project this release talks to (built in by the app).
#[derive(Debug, Clone)]
pub struct Firebase {
    pub project: String,
    /// The project's Web API key (public; the rules protect the data).
    pub key: String,
}

/// A Firebase sign-in: the token the rules check, and how to get the next one.
#[derive(Debug, Clone)]
pub struct Session {
    pub id_token: String,
    pub refresh_token: String,
    pub email: String,
}

/// One of the account's devices, as listed in Firestore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountDevice {
    pub device_id: String,
    pub name: String,
    pub kind: String,
    pub public_key: Vec<u8>,
    /// "192.168.1.20:47813" for each Wi-Fi address it had when it last checked in.
    pub addresses: Vec<String>,
    pub last_seen: String,
}

/// What the Sync page shows about pairing by Google account. Mirrored by `SyncAccount` in
/// src/ipc/sync.ts.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    /// The Gmail this device is signed in with ("" = not signed in).
    pub email: String,
    /// The account's other devices (paired or not).
    pub devices: Vec<AccountPeer>,
    /// The last check worked at this time (ms).
    pub checked_at_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountPeer {
    pub device_id: String,
    pub name: String,
    pub kind: String,
    /// "Forget" was pressed for it here, so it isn't paired again by itself.
    pub skipped: bool,
}

// ---------------------------------------------------------------- HTTP

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

fn send(method: &str, url: &str, bearer: Option<&str>, body: Option<(&str, String)>) -> Result<(u16, Value), String> {
    let agent = agent();
    let auth = bearer.map(|t| format!("Bearer {t}"));
    let result = match method {
        "GET" | "DELETE" => {
            let mut r = if method == "GET" { agent.get(url) } else { agent.delete(url) };
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r.call()
        }
        _ => {
            let mut r = if method == "PATCH" { agent.patch(url) } else { agent.post(url) };
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            let (kind, text) = body.unwrap_or(("application/json", String::new()));
            r.header("Content-Type", kind).send(text)
        }
    };
    let mut response = result.map_err(|e| format!("Couldn't reach Google ({e}). Check the internet connection."))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

fn error_text(answer: &Value) -> String {
    answer
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("no answer")
        .to_string()
}

fn path_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn form_encode(s: &str) -> String {
    path_encode(s)
}

/// The middle part of a JWT, decoded (no signature check: only used to read our own email).
pub fn jwt_claims(token: &str) -> Option<Value> {
    let part = token.split('.').nth(1)?;
    let mut bits: u32 = 0;
    let mut n = 0;
    let mut out = Vec::new();
    for c in part.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        bits = (bits << 6) | v as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
            bits &= (1 << n) - 1;
        }
    }
    serde_json::from_slice(&out).ok()
}

fn email_of(token: &str) -> Option<String> {
    let claims = jwt_claims(token)?;
    let email = claims.get("email")?.as_str()?.trim().to_lowercase();
    (!email.is_empty()).then_some(email)
}

// ---------------------------------------------------------------- signing in

/// Trades a Google ID token (from "Sign in with Google") for a Firebase sign-in.
pub fn sign_in_with_google(fb: &Firebase, google_id_token: &str) -> Result<Session, String> {
    let url = format!("https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key={}", fb.key);
    let body = json!({
        "postBody": format!("id_token={google_id_token}&providerId=google.com"),
        "requestUri": "http://localhost",
        "returnSecureToken": true,
        "returnIdpCredential": false,
    });
    let (status, answer) = send("POST", &url, None, Some(("application/json", body.to_string())))?;
    let id_token = answer.get("idToken").and_then(Value::as_str).filter(|_| status == 200);
    let refresh = answer.get("refreshToken").and_then(Value::as_str).unwrap_or_default();
    match id_token {
        Some(t) => Ok(Session {
            id_token: t.to_string(),
            refresh_token: refresh.to_string(),
            email: answer
                .get("email")
                .and_then(Value::as_str)
                .map(|e| e.trim().to_lowercase())
                .or_else(|| email_of(t))
                .unwrap_or_default(),
        }),
        None => Err(format!("Firebase didn't accept the Google sign-in: {}", error_text(&answer))),
    }
}

/// A fresh Firebase token from the saved refresh token (they last an hour).
pub fn refresh(fb: &Firebase, refresh_token: &str) -> Result<Session, String> {
    let url = format!("https://securetoken.googleapis.com/v1/token?key={}", fb.key);
    let body = format!("grant_type=refresh_token&refresh_token={}", form_encode(refresh_token));
    let (status, answer) = send("POST", &url, None, Some(("application/x-www-form-urlencoded", body)))?;
    let id_token = answer.get("id_token").and_then(Value::as_str).filter(|_| status == 200);
    match id_token {
        Some(t) => Ok(Session {
            id_token: t.to_string(),
            refresh_token: answer.get("refresh_token").and_then(Value::as_str).unwrap_or(refresh_token).to_string(),
            email: email_of(t).unwrap_or_default(),
        }),
        None => Err(format!("Google sign-in ran out ({}). Sign in again.", error_text(&answer))),
    }
}

// ---------------------------------------------------------------- email and password

/// What an email account sign-in gives back.
#[derive(Debug, Clone)]
pub struct EmailSignIn {
    pub session: Session,
    pub name: String,
    pub verified: bool,
}

/// Is the email confirmed (the person opened the link in the verification email)?
pub fn email_verified(id_token: &str) -> bool {
    jwt_claims(id_token).and_then(|c| c.get("email_verified").and_then(Value::as_bool)).unwrap_or(false)
}

/// Firebase's error codes as plain sentences.
pub fn explain_email_error(code: &str) -> String {
    let head = code.split([' ', ':']).next().unwrap_or(code);
    match head {
        "EMAIL_EXISTS" => "This email already has a Kairos account. Log in instead, or use Sign in with Google if you made it with Google.".into(),
        "EMAIL_NOT_FOUND" | "INVALID_PASSWORD" | "INVALID_LOGIN_CREDENTIALS" => "Wrong email or password.".into(),
        "WEAK_PASSWORD" => "Use a password of at least 6 characters.".into(),
        "INVALID_EMAIL" | "MISSING_EMAIL" => "That email doesn't look right.".into(),
        "MISSING_PASSWORD" => "Type a password.".into(),
        "TOO_MANY_ATTEMPTS_TRY_LATER" => "Too many tries. Wait a few minutes and try again.".into(),
        "USER_DISABLED" => "This account has been turned off.".into(),
        "OPERATION_NOT_ALLOWED" | "PASSWORD_LOGIN_DISABLED" => "Email login isn't switched on for Kairos yet (Firebase > Authentication > Email/Password).".into(),
        "TOKEN_EXPIRED" | "USER_NOT_FOUND" | "INVALID_REFRESH_TOKEN" | "INVALID_ID_TOKEN" => "The login ran out. Log in again.".into(),
        _ => format!("Firebase said: {code}"),
    }
}

fn identity(fb: &Firebase, action: &str, body: Value) -> Result<Value, String> {
    let url = format!("https://identitytoolkit.googleapis.com/v1/accounts:{action}?key={}", fb.key);
    let (status, answer) = send("POST", &url, None, Some(("application/json", body.to_string())))?;
    if status == 200 { Ok(answer) } else { Err(explain_email_error(&error_text(&answer))) }
}

fn email_session(answer: &Value) -> Result<EmailSignIn, String> {
    let id_token = answer.get("idToken").and_then(Value::as_str).ok_or("Firebase sent no sign-in.")?.to_string();
    let email = answer.get("email").and_then(Value::as_str).map(|e| e.trim().to_lowercase()).or_else(|| email_of(&id_token)).unwrap_or_default();
    Ok(EmailSignIn {
        verified: email_verified(&id_token),
        name: answer.get("displayName").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        session: Session { refresh_token: answer.get("refreshToken").and_then(Value::as_str).unwrap_or_default().to_string(), id_token, email },
    })
}

/// Makes a new account, saves the name on it and sends the verification email.
pub fn sign_up(fb: &Firebase, email: &str, password: &str, name: &str) -> Result<EmailSignIn, String> {
    let answer = identity(fb, "signUp", json!({ "email": email.trim(), "password": password, "returnSecureToken": true }))?;
    let mut account = email_session(&answer)?;
    let name = name.trim();
    if !name.is_empty() {
        // Best effort: the account works without a name.
        if identity(fb, "update", json!({ "idToken": account.session.id_token, "displayName": name, "returnSecureToken": false })).is_ok() {
            account.name = name.to_string();
        }
    }
    send_verification(fb, &account.session.id_token)?;
    Ok(account)
}

pub fn sign_in_with_password(fb: &Firebase, email: &str, password: &str) -> Result<EmailSignIn, String> {
    let answer = identity(fb, "signInWithPassword", json!({ "email": email.trim(), "password": password, "returnSecureToken": true }))?;
    email_session(&answer)
}

pub fn send_verification(fb: &Firebase, id_token: &str) -> Result<(), String> {
    identity(fb, "sendOobCode", json!({ "requestType": "VERIFY_EMAIL", "idToken": id_token })).map(|_| ())
}

pub fn send_password_reset(fb: &Firebase, email: &str) -> Result<(), String> {
    identity(fb, "sendOobCode", json!({ "requestType": "PASSWORD_RESET", "email": email.trim() })).map(|_| ())
}

// ---------------------------------------------------------------- the device list

fn devices_url(fb: &Firebase, email: &str) -> String {
    format!(
        "https://firestore.googleapis.com/v1/projects/{}/databases/(default)/documents/accounts/{}/devices",
        fb.project,
        path_encode(email)
    )
}

fn now_stamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // RFC 3339 in UTC without a date library: days since 1970 to a civil date.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn string_field(doc: &Value, name: &str) -> String {
    let f = &doc["fields"][name];
    f.get("stringValue").or_else(|| f.get("timestampValue")).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Says "this device is here" under the account, then lists every device of the account
/// (this one included).
pub fn check_in(fb: &Firebase, session: &Session, me: &Me, addresses: &[String]) -> Result<Vec<AccountDevice>, String> {
    if session.email.is_empty() {
        return Err("The Google sign-in has no email.".into());
    }
    let base = devices_url(fb, &session.email);
    let fields = json!({
        "name": { "stringValue": me.name.chars().take(80).collect::<String>() },
        "kind": { "stringValue": me.kind },
        "publicKey": { "stringValue": focus_store::sync::hex(&me.public) },
        "addresses": { "stringValue": addresses.join(",").chars().take(400).collect::<String>() },
        "version": { "stringValue": me.app_version.chars().take(20).collect::<String>() },
        "lastSeen": { "timestampValue": now_stamp() },
    });
    let url = format!("{base}/{}", path_encode(&me.device_id));
    let (status, answer) = send("PATCH", &url, Some(&session.id_token), Some(("application/json", json!({ "fields": fields }).to_string())))?;
    if status == 403 || status == 401 {
        return Err(format!(
            "Kairos's database said no ({}). The new database rules may not be published yet.",
            error_text(&answer)
        ));
    }
    if status != 200 {
        return Err(format!("Kairos's database said {status}: {}", error_text(&answer)));
    }
    let (status, answer) = send("GET", &format!("{base}?pageSize=50"), Some(&session.id_token), None)?;
    if status != 200 {
        return Err(format!("Couldn't list your devices ({status}: {}).", error_text(&answer)));
    }
    let docs = answer["documents"].as_array().cloned().unwrap_or_default();
    Ok(docs
        .iter()
        .filter_map(|d| {
            let device_id = d["name"].as_str()?.rsplit('/').next()?.to_string();
            let public_key = focus_store::sync::unhex(&string_field(d, "publicKey"))?;
            if public_key.len() != 32 {
                return None;
            }
            let kind = string_field(d, "kind");
            Some(AccountDevice {
                device_id,
                name: string_field(d, "name"),
                kind: if kind == "phone" { kind } else { "pc".into() },
                public_key,
                addresses: string_field(d, "addresses")
                    .split(',')
                    .map(str::trim)
                    .filter(|a| a.parse::<std::net::SocketAddr>().is_ok())
                    .map(str::to_string)
                    .collect(),
                last_seen: string_field(d, "lastSeen"),
            })
        })
        .collect())
}

/// Takes this device off the account's list (signing out).
pub fn check_out(fb: &Firebase, session: &Session, device_id: &str) -> Result<(), String> {
    let url = format!("{}/{}", devices_url(fb, &session.email), path_encode(device_id));
    let (status, answer) = send("DELETE", &url, Some(&session.id_token), None)?;
    if status == 200 || status == 404 { Ok(()) } else { Err(format!("{status}: {}", error_text(&answer))) }
}

// ---------------------------------------------------------------- devices not to pair again

const SKIP_KEY: &str = "sync.account_skip";

/// Devices "Forget" was pressed for: pairing by account leaves them alone.
pub fn skipped(store: &Store) -> Vec<String> {
    local::get(store, SKIP_KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_default()
}

pub fn set_skipped(store: &Store, device_id: &str, skip: bool) -> Result<(), String> {
    let mut list = skipped(store);
    list.retain(|d| d != device_id);
    if skip {
        list.push(device_id.to_string());
    }
    let text = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    local::set(store, SKIP_KEY, &text).map_err(|e| e.to_string())
}

/// What a device keeps of its Firebase sign-in (phone: the app signs in once; the PC keeps its
/// Google sign-in instead and doesn't use this).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SavedSignIn {
    pub email: String,
    pub refresh_token: String,
}

const SIGN_IN_KEY: &str = "sync.account_signin";

pub fn saved_sign_in(store: &Store) -> Option<SavedSignIn> {
    let text = local::get(store, SIGN_IN_KEY).ok().flatten()?;
    serde_json::from_str::<SavedSignIn>(&text).ok().filter(|s| !s.refresh_token.is_empty())
}

pub fn save_sign_in(store: &Store, saved: Option<&SavedSignIn>) -> Result<(), String> {
    match saved {
        Some(s) => local::set(store, SIGN_IN_KEY, &serde_json::to_string(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string()),
        None => local::remove(store, SIGN_IN_KEY).map_err(|e| e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_email_from_a_token() {
        // {"email":"Ps@Gmail.com","sub":"1"}
        let payload = "eyJlbWFpbCI6IlBzQEdtYWlsLmNvbSIsInN1YiI6IjEifQ";
        assert_eq!(email_of(&format!("x.{payload}.y")).as_deref(), Some("ps@gmail.com"));
        assert_eq!(email_of("nonsense"), None);
    }

    #[test]
    fn stamps_are_rfc3339() {
        let s = now_stamp();
        assert_eq!(s.len(), 20, "{s}");
        assert!(s.starts_with("20") && s.ends_with('Z'));
    }

    #[test]
    fn skip_list_round_trips() {
        let store = Store::open_in_memory().unwrap();
        assert!(skipped(&store).is_empty());
        set_skipped(&store, "a", true).unwrap();
        set_skipped(&store, "b", true).unwrap();
        set_skipped(&store, "a", false).unwrap();
        assert_eq!(skipped(&store), vec!["b".to_string()]);
    }

    #[test]
    fn emails_are_path_safe() {
        assert_eq!(path_encode("a.b+c@gmail.com"), "a.b%2Bc%40gmail.com");
    }
}
