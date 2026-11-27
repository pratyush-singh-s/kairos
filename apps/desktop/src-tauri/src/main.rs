// Prevents an extra console window on Windows in release builds. Do not remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // "--firewall-check" / "--firewall-allow" from the installer: answer and exit, no window.
    if let Some(code) = focus_desktop_lib::firewall::from_args() {
        std::process::exit(code);
    }
    focus_desktop_lib::run()
}
