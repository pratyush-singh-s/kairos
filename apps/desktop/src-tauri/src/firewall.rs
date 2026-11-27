//! Letting the phone (or another PC) reach Focus through Windows Firewall.
//!
//! Focus listens for other devices on TCP 47813 and UDP 47812. The first time it does, Windows
//! asks whether to allow it, ticking only "Private networks"; on a Wi-Fi that Windows calls
//! "Public" (or if the box was closed), it adds BLOCK rules for Focus.exe instead. Then the phone
//! can't send its changes or be heard, and only pressing Sync on the PC (which calls out) works.
//!
//! The fix needs admin once: delete every rule for Focus.exe (block rules win over allow rules)
//! and add one allow rule, named [`RULE`], for all network types. The installer runs
//! `Focus.exe --firewall-check` and, when it says "missing", `Focus.exe --firewall-allow`
//! elevated; the Sync page offers the same with an "Allow" button.

pub const RULE: &str = "Focus sync";

/// Handles `--firewall-check` (exit 0 = allowed, 1 = missing) and `--firewall-allow` (exit 0 =
/// done) before anything else starts. None = a normal launch.
pub fn from_args() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--firewall-check") {
        return Some(if allowed() { 0 } else { 1 });
    }
    if args.iter().any(|a| a == "--firewall-allow") {
        return Some(if write_rule().is_ok() { 0 } else { 1 });
    }
    None
}

#[cfg(windows)]
fn netsh(args: &[&str]) -> Option<std::process::Output> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("netsh")
        .args(args)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .ok()
}

#[cfg(windows)]
fn exe() -> Option<String> {
    std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned())
}

/// True when our allow rule exists for this Focus.exe (reading rules doesn't need admin).
#[cfg(windows)]
pub fn allowed() -> bool {
    let Some(out) = netsh(&["advfirewall", "firewall", "show", "rule", &format!("name={RULE}"), "verbose"]) else {
        // netsh missing or not runnable: nothing we can check, so don't nag.
        return true;
    };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    exe().is_none_or(|e| text.contains(&e.to_lowercase()))
}

#[cfg(not(windows))]
pub fn allowed() -> bool {
    true
}

/// Needs admin: drops Windows' own rules for Focus.exe (the blocking ones) and allows it in.
#[cfg(windows)]
fn write_rule() -> Result<(), String> {
    let exe = exe().ok_or("no exe path")?;
    let program = format!("program={exe}");
    let _ = netsh(&["advfirewall", "firewall", "delete", "rule", "name=all", &program]);
    let _ = netsh(&["advfirewall", "firewall", "delete", "rule", &format!("name={RULE}")]);
    let out = netsh(&[
        "advfirewall",
        "firewall",
        "add",
        "rule",
        &format!("name={RULE}"),
        "dir=in",
        "action=allow",
        &program,
        "enable=yes",
        "profile=any",
        "description=Lets your phone and other PCs sync with Kairos on the same Wi-Fi.",
    ])
    .ok_or("netsh didn't run")?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stdout).trim().to_string()) }
}

#[cfg(not(windows))]
fn write_rule() -> Result<(), String> {
    Ok(())
}

/// Runs `Focus.exe --firewall-allow` as admin (Windows asks first) and waits for it.
#[cfg(windows)]
fn allow_elevated() -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{INFINITE, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let exe = wide(&exe().ok_or("no exe path")?);
    let verb = wide("runas");
    let params = wide("--firewall-allow");
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = exe.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err("Windows didn't allow it (the admin prompt was closed).".into());
    }
    if !info.hProcess.is_null() {
        unsafe {
            WaitForSingleObject(info.hProcess, INFINITE);
            CloseHandle(info.hProcess);
        }
    }
    Ok(())
}

/// Whether other devices can get in (the Sync page warns when not).
#[tauri::command]
pub async fn sync_firewall_allowed() -> bool {
    tauri::async_runtime::spawn_blocking(allowed).await.unwrap_or(true)
}

/// The Sync page's "Allow": asks Windows for admin, writes the rule, says whether it's there now.
#[tauri::command]
pub async fn sync_allow_firewall() -> Result<bool, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| allow_elevated().map(|_| allowed())).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        Ok(true)
    }
}
