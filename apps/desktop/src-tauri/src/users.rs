//! Kairos users: a private count of installs and a list of who signed in with Google, for the
//! app's maker (Ps). Everything goes to Ps's own Firebase project (Firestore), built in at release
//! time with KAIROS_FIREBASE_PROJECT and KAIROS_FIREBASE_KEY. Without them this file does nothing.
//!
//! - installs/{random id}: first seen, last opened (once a day), version, "windows". No name,
//!   no email, no PC details.
//! - signins/{email}: email, first name, first/last seen, install id, version. Written with a
//!   Firebase sign-in made from the user's own Google sign-in, so the database rules can check
//!   the email is really theirs (nobody can add someone else's email).
//! - Only Ps can read (the rules in docs/USERS-SETUP.md name Ps's email). The Users card in
//!   Settings asks Firestore; anyone else gets "permission denied" and sees no card.
//! - Always on since 0.21.103.B (the "Count me in" switch was removed at Ps's request).

use std::time::Duration;

use focus_store::settings;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::state::StoreState;

const PROJECT: Option<&str> = option_env!("KAIROS_FIREBASE_PROJECT");
const KEY: Option<&str> = option_env!("KAIROS_FIREBASE_KEY");
const VERSION: &str = include_str!("../RELEASE_LABEL");

pub(crate) fn config() -> Option<(&'static str, &'static str)> {
    let (p, k) = (PROJECT?.trim(), KEY?.trim());
    (!p.is_empty() && !k.is_empty()).then_some((p, k))
}

fn version() -> &'static str {
    VERSION.trim()
}

fn docs_url(project: &str) -> String {
    format!("https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents")
}

// ---------------------------------------------------------------- HTTP

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

/// Sends a request and returns (status, JSON body).
fn send(method: &str, url: &str, bearer: Option<&str>, body: Option<&Value>) -> Result<(u16, Value), String> {
    let agent = agent();
    let auth = bearer.map(|t| format!("Bearer {t}"));
    let mut response = match method {
        "GET" => {
            let mut r = agent.get(url);
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r.call()
        }
        _ => {
            let mut r = if method == "PATCH" { agent.patch(url) } else { agent.post(url) };
            r = r.header("Content-Type", "application/json");
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r.send(body.map(Value::to_string).unwrap_or_default())
        }
    }
    .map_err(|e| format!("could not reach the Kairos users database ({e})"))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

fn now_stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn ts(v: &str) -> Value {
    json!({ "timestampValue": v })
}

fn st(v: &str) -> Value {
    json!({ "stringValue": v })
}

/// The email as a document id: lower case, and safe for a URL path.
pub fn email_id(email: &str) -> String {
    email.trim().to_lowercase()
}

fn path_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ---------------------------------------------------------------- reporting

/// Every install is counted (0.21.103.B: Ps removed the "Count me in" switch). The setting stays
/// so older versions keep working.
fn sharing(_app: &AppHandle) -> bool {
    true
}

/// This install's random id, made on first use.
fn install_id(app: &AppHandle) -> Result<String, String> {
    app.state::<StoreState>().with(|s| {
        let id = settings::get::<String>(s, "users.installId").map_err(|e| e.to_string())?;
        if id.len() >= 16 {
            return Ok(id);
        }
        let mut buf = [0u8; 16];
        getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
        let id: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        settings::set(s, "users.installId", &id).map_err(|e| e.to_string())?;
        Ok(id)
    })
}

/// Adds this install, or moves its "last opened" to now.
fn report_install(project: &str, key: &str, id: &str) -> Result<(), String> {
    let now = now_stamp();
    let base = docs_url(project);
    let create = json!({ "fields": { "firstSeen": ts(&now), "lastSeen": ts(&now), "version": st(version()), "os": st("windows") } });
    let (status, _) = send("POST", &format!("{base}/installs?documentId={id}&key={key}"), None, Some(&create))?;
    if status == 200 {
        return Ok(());
    }
    // 409 = already counted: just say it was opened today.
    let update = json!({ "fields": { "lastSeen": ts(&now), "version": st(version()) } });
    let url = format!("{base}/installs/{id}?key={key}&updateMask.fieldPaths=lastSeen&updateMask.fieldPaths=version&currentDocument.exists=true");
    let (status, answer) = send("PATCH", &url, None, Some(&update))?;
    if status == 200 { Ok(()) } else { Err(format!("install not counted ({status}): {answer}")) }
}

/// Adds or refreshes the signed-in account (Google or a Kairos email account).
fn report_sign_in(app: &AppHandle, project: &str, install: &str) -> Result<(), String> {
    let session = crate::email_account::firebase_session(app)?.ok_or("not signed in")?;
    let email = session.email.clone();
    if email.is_empty() {
        return Err("no email in the sign-in".into());
    }
    let name = crate::email_account::display_name(app);
    let token = session.id_token;
    let id = email_id(&email);
    let now = now_stamp();
    let base = docs_url(project);
    let mut fields = json!({ "email": st(&id), "name": st(&name), "lastSeen": ts(&now), "installId": st(install), "version": st(version()) });
    let doc = format!("{base}/signins/{}", path_encode(&id));
    let mask = "updateMask.fieldPaths=email&updateMask.fieldPaths=name&updateMask.fieldPaths=lastSeen&updateMask.fieldPaths=installId&updateMask.fieldPaths=version";
    let (status, _) = send("PATCH", &format!("{doc}?{mask}&currentDocument.exists=true"), Some(&token), Some(&json!({ "fields": fields })))?;
    if status == 200 {
        return Ok(());
    }
    fields["firstSeen"] = ts(&now);
    let (status, answer) = send("POST", &format!("{base}/signins?documentId={}", path_encode(&id)), Some(&token), Some(&json!({ "fields": fields })))?;
    if status == 200 { Ok(()) } else { Err(format!("sign-in not recorded ({status}): {answer}")) }
}

fn log(what: &str, result: Result<(), String>) {
    if let Err(e) = result {
        eprintln!("kairos users: {what}: {e}");
    }
}

/// After a sign-in: records the account (in the background, never blocks sign-in).
pub fn signed_in(app: &AppHandle) {
    let Some((project, _key)) = config() else { return };
    if !sharing(app) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = install_id(&app).and_then(|id| report_sign_in(&app, project, &id));
        log("sign-in", result);
    });
}

/// At start and then hourly: once a day, counts this install as opened (and the signed-in
/// account as seen, which also adds accounts signed in before this version).
pub fn spawn(app: AppHandle) {
    let Some((project, key)) = config() else { return };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            let last = app.state::<StoreState>().with(|s| settings::get::<String>(s, "users.lastPing").map_err(|e| e.to_string())).unwrap_or_default();
            if sharing(&app) && last != today {
                let result = install_id(&app).and_then(|id| {
                    report_install(project, key, &id)?;
                    if crate::email_account::current_email(&app).is_some() {
                        // A failed account report doesn't block the install count.
                        log("account", report_sign_in(&app, project, &id));
                    }
                    app.state::<StoreState>().with(|s| settings::set(s, "users.lastPing", &today).map_err(|e| e.to_string()))
                });
                log("install", result);
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}

// ---------------------------------------------------------------- the Users card (Ps only)

/// What the Users card shows. Mirrored by `UsersOverview` in src/ipc/users.ts.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsersOverview {
    /// A users database is built into this release.
    pub built_in: bool,
    /// The signed-in account may read the list (Ps). False for everyone else.
    pub owner: bool,
    pub installs: usize,
    /// Installs opened in the last 7 days.
    pub active_week: usize,
    /// Installs first seen in the last 7 days.
    pub new_week: usize,
    pub people: Vec<Person>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub email: String,
    pub name: String,
    pub first_seen: String,
    pub last_seen: String,
    pub version: String,
}

fn field<'a>(doc: &'a Value, name: &str) -> &'a str {
    let f = &doc["fields"][name];
    f.get("stringValue").or_else(|| f.get("timestampValue")).and_then(Value::as_str).unwrap_or("")
}

/// Every document in a collection (pages of 300). Err("denied") when the rules say no.
fn list(project: &str, token: &str, collection: &str) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut page = String::new();
    for _ in 0..100 {
        let mut url = format!("{}/{collection}?pageSize=300", docs_url(project));
        if !page.is_empty() {
            url.push_str(&format!("&pageToken={}", path_encode(&page)));
        }
        let (status, answer) = send("GET", &url, Some(token), None)?;
        if status == 403 || status == 401 {
            return Err("denied".into());
        }
        if status != 200 {
            return Err(format!("the users database said {status}: {}", answer.pointer("/error/message").and_then(Value::as_str).unwrap_or("")));
        }
        out.extend(answer["documents"].as_array().cloned().unwrap_or_default());
        match answer["nextPageToken"].as_str() {
            Some(t) if !t.is_empty() => page = t.to_string(),
            _ => break,
        }
    }
    Ok(out)
}

fn within_week(stamp: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(stamp).is_ok_and(|t| chrono::Utc::now().signed_duration_since(t) < chrono::Duration::days(7))
}

fn overview(app: &AppHandle) -> UsersOverview {
    let Some((project, _key)) = config() else { return UsersOverview::default() };
    let mut out = UsersOverview { built_in: true, ..Default::default() };
    if crate::email_account::current_email(app).is_none() {
        return out;
    }
    let result = (|| {
        let token = crate::email_account::firebase_session(app)?.ok_or("not signed in")?.id_token;
        let installs = list(project, &token, "installs")?;
        let signins = list(project, &token, "signins")?;
        Ok::<_, String>((installs, signins))
    })();
    match result {
        Ok((installs, signins)) => {
            out.owner = true;
            out.installs = installs.len();
            out.active_week = installs.iter().filter(|d| within_week(field(d, "lastSeen"))).count();
            out.new_week = installs.iter().filter(|d| within_week(field(d, "firstSeen"))).count();
            out.people = signins
                .iter()
                .map(|d| Person {
                    email: field(d, "email").to_string(),
                    name: field(d, "name").to_string(),
                    first_seen: field(d, "firstSeen").to_string(),
                    last_seen: field(d, "lastSeen").to_string(),
                    version: field(d, "version").to_string(),
                })
                .collect();
            out.people.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        }
        Err(e) if e == "denied" => {}
        Err(e) => out.error = Some(e),
    }
    out
}

#[tauri::command]
pub async fn users_overview(app: AppHandle) -> Result<UsersOverview, String> {
    tauri::async_runtime::spawn_blocking(move || overview(&app)).await.map_err(|e| e.to_string())
}

/// Turning sharing on counts this install again today.
#[tauri::command]
pub fn set_users_share(app: AppHandle, on: bool) -> Result<(), String> {
    app.state::<StoreState>().with(|s| {
        settings::set(s, "users.share", &on).map_err(|e| e.to_string())?;
        settings::set(s, "users.lastPing", &"").map_err(|e| e.to_string())
    })
}

/// For Settings: is a users database built in, and is this install counted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsersInfo {
    pub built_in: bool,
    pub share: bool,
}

#[tauri::command]
pub fn users_info(app: AppHandle) -> UsersInfo {
    UsersInfo { built_in: config().is_some(), share: sharing(&app) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_safe_ids() {
        assert_eq!(email_id(" Ps@Gmail.com "), "ps@gmail.com");
        assert_eq!(path_encode("a.b+c@gmail.com"), "a.b%2Bc%40gmail.com");
    }

    #[test]
    fn fields_are_read() {
        let doc = json!({ "fields": { "email": { "stringValue": "a@b.c" }, "lastSeen": { "timestampValue": "2026-11-23T10:00:00Z" } } });
        assert_eq!(field(&doc, "email"), "a@b.c");
        assert_eq!(field(&doc, "lastSeen"), "2026-11-23T10:00:00Z");
        assert_eq!(field(&doc, "name"), "");
    }

    #[test]
    fn version_is_the_label() {
        assert!(version().ends_with(".B"), "{}", version());
    }
}
