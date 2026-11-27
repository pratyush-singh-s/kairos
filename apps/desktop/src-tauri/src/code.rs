//! The Code page (Terminal theme): source files in Documents\Focus Code, run with the compilers
//! and interpreters already installed on this PC. Output streams to the page as it is printed and
//! the page can type into a running program.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// File types the page can make and run.
const EXTENSIONS: &[&str] = &["py", "c", "cpp", "cc", "h", "hpp", "java", "js", "rs", "go", "txt"];

/// What a run is doing now: the compiler, then the program.
struct Proc {
    child: Arc<Mutex<Child>>,
    job: Option<Job>,
}

impl Proc {
    fn stop(&self) {
        if let Some(job) = &self.job {
            job.end();
        }
        // Also when the job ended it: kill is harmless on a process that has ended.
        let _ = self.child.lock().unwrap().kill();
    }
}

/// One run per run id, from the moment Run is pressed until it ends.
#[derive(Default)]
struct Run {
    proc: Option<Proc>,
    stdin: Option<ChildStdin>,
    stopped: bool,
}

impl Run {
    fn stop(&mut self) {
        self.stopped = true;
        self.stdin = None;
        if let Some(p) = &self.proc {
            p.stop();
        }
    }
}

#[derive(Default)]
pub struct CodeState {
    runs: Mutex<HashMap<u64, Run>>,
    next: AtomicU64,
}

impl CodeState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFile {
    name: String,
    size: u64,
    modified_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    run_id: u64,
    /// "out", "err" or "info" (Focus's own lines: compiling…, exit code).
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    run_id: u64,
    code: Option<i32>,
    ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toolchain {
    language: &'static str,
    /// The program found, e.g. "g++ (MinGW-W64) 14.2.0"; None = not installed.
    found: Option<String>,
    /// Where to get it when missing.
    get: &'static str,
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let docs = app.path().document_dir().map_err(|e| format!("could not find Documents: {e}"))?;
    let dir = docs.join("Focus Code");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    Ok(dir)
}

/// A plain file name in the code folder: no folders, a known extension.
fn checked(name: &str) -> Result<&str, String> {
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("");
    let ok = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        && EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str());
    if ok { Ok(name) } else { Err(format!("{name:?} is not a file name Kairos can use (try main.py, hello.cpp, Main.java)")) }
}

fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window flashes up
    }
    cmd
}

#[tauri::command]
pub fn code_folder(app: AppHandle) -> Result<String, String> {
    Ok(folder(&app)?.display().to_string())
}

#[tauri::command]
pub fn code_list(app: AppHandle) -> Result<Vec<CodeFile>, String> {
    let dir = folder(&app)?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || checked(&name).is_err() {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        files.push(CodeFile { name, size: meta.len(), modified_ms });
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

#[tauri::command]
pub fn code_read(app: AppHandle, name: String) -> Result<String, String> {
    let path = folder(&app)?.join(checked(&name)?);
    std::fs::read_to_string(&path).map_err(|e| format!("could not open {name}: {e}"))
}

#[tauri::command]
pub fn code_save(app: AppHandle, name: String, text: String) -> Result<(), String> {
    if text.len() > 2_000_000 {
        return Err("file is too big (2 MB at most)".into());
    }
    let path = folder(&app)?.join(checked(&name)?);
    std::fs::write(&path, text).map_err(|e| format!("could not save {name}: {e}"))
}

#[tauri::command]
pub fn code_delete(app: AppHandle, name: String) -> Result<(), String> {
    let path = folder(&app)?.join(checked(&name)?);
    std::fs::remove_file(&path).map_err(|e| format!("could not delete {name}: {e}"))
}

#[tauri::command]
pub fn code_rename(app: AppHandle, from: String, to: String) -> Result<(), String> {
    let dir = folder(&app)?;
    let target = dir.join(checked(&to)?);
    if target.exists() {
        return Err(format!("{to} already exists"));
    }
    std::fs::rename(dir.join(checked(&from)?), target).map_err(|e| format!("could not rename: {e}"))
}

/// Folders searched for programs, newest first: the PATH as it is saved right now (on Windows it
/// is read again from the registry, so a compiler installed after Focus started is found without
/// restarting Focus), Focus's own PATH, then the folders compilers usually install to, because
/// many installers (and unzipped WinLibs / MinGW folders) never add themselves to PATH.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut add = |d: PathBuf| {
        if !d.as_os_str().is_empty() && !dirs.iter().any(|x| same_dir(x, &d)) {
            dirs.push(d);
        }
    };
    for d in std::env::split_paths(&saved_path()) {
        add(d);
    }
    if let Some(p) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&p) {
            add(d);
        }
    }
    for d in usual_dirs() {
        add(d);
    }
    dirs
}

fn same_dir(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().trim_end_matches(['\\', '/']).eq_ignore_ascii_case(b.to_string_lossy().trim_end_matches(['\\', '/']))
    } else {
        a == b
    }
}

/// PATH as saved for this user and this PC (Windows), with %VARIABLES% filled in.
#[cfg(windows)]
fn saved_path() -> std::ffi::OsString {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let machine = reg_string(HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "Path");
    let user = reg_string(HKEY_CURRENT_USER, "Environment", "Path");
    let joined = [machine, user].into_iter().flatten().map(|s| expand_vars(&s)).collect::<Vec<_>>().join(";");
    joined.into()
}

#[cfg(not(windows))]
fn saved_path() -> std::ffi::OsString {
    std::ffi::OsString::new()
}

#[cfg(windows)]
fn reg_string(root: windows_sys::Win32::System::Registry::HKEY, key: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (key, value) = (wide(key), wide(value));
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    unsafe {
        let mut size: u32 = 0;
        if RegGetValueW(root, key.as_ptr(), value.as_ptr(), flags, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) != 0 {
            return None;
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut size = (buf.len() * 2) as u32;
        if RegGetValueW(root, key.as_ptr(), value.as_ptr(), flags, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) != 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

/// Fills in %NAME% from the environment (unknown names are left as they are).
#[cfg_attr(not(windows), allow(dead_code))]
fn expand_vars(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(a) = rest.find('%') {
        out.push_str(&rest[..a]);
        let after = &rest[a + 1..];
        match after.find('%') {
            Some(b) if b > 0 => {
                let name = &after[..b];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[b + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Where compilers and interpreters usually end up on Windows.
#[cfg(windows)]
fn usual_dirs() -> Vec<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let c = PathBuf::from(r"C:\");
    let pf = env("ProgramFiles").unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let pf86 = env("ProgramFiles(x86)").unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
    let pd = env("ProgramData").unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    let home = env("USERPROFILE");
    let local = env("LOCALAPPDATA");
    let mut dirs = Vec::new();
    for sub in ["ucrt64", "mingw64", "clang64", "mingw32"] {
        dirs.push(c.join("msys64").join(sub).join("bin"));
    }
    for d in ["mingw64", "mingw32", "MinGW", "MinGW64", "TDM-GCC-64", "TDM-GCC-32", "Strawberry\\c", "cygwin64"] {
        dirs.push(c.join(d).join("bin"));
    }
    dirs.push(pd.join(r"mingw64\mingw64\bin")); // choco install mingw
    dirs.push(pd.join(r"chocolatey\bin"));
    for p in [&pf, &pf86] {
        dirs.push(p.join(r"mingw64\bin"));
        dirs.push(p.join(r"CodeBlocks\MinGW\bin"));
        dirs.push(p.join(r"Dev-Cpp\MinGW64\bin"));
        dirs.push(p.join(r"Embarcadero\Dev-Cpp\TDM-GCC-64\bin"));
        dirs.push(p.join(r"LLVM\bin"));
        dirs.push(p.join("nodejs"));
        dirs.push(p.join(r"Go\bin"));
        dirs.extend(subdirs(&p.join("mingw-w64")).into_iter().flat_map(|d| [d.join(r"mingw64\bin"), d.join(r"mingw32\bin")]));
        dirs.extend(subdirs(&p.join("Eclipse Adoptium")).into_iter().map(|d| d.join("bin")));
        dirs.extend(subdirs(&p.join("Java")).into_iter().map(|d| d.join("bin")));
        dirs.extend(subdirs(&p.join("Microsoft")).into_iter().filter(|d| d.to_string_lossy().contains("jdk")).map(|d| d.join("bin")));
    }
    if let Some(local) = &local {
        dirs.push(local.join(r"Microsoft\WinGet\Links"));
        dirs.extend(subdirs(&local.join(r"Microsoft\WinGet\Packages")).into_iter().flat_map(|d| [d.join(r"mingw64\bin"), d.join(r"mingw32\bin"), d.join("bin")]));
        dirs.extend(subdirs(&local.join(r"Programs\Python")).into_iter().rev());
    }
    if let Some(home) = &home {
        dirs.push(home.join(r"scoop\shims"));
        dirs.push(home.join(r".cargo\bin"));
    }
    // A MinGW / WinLibs zip unpacked straight to C:\, the Desktop, Documents or Downloads.
    let mut roots = vec![c.clone()];
    if let Some(home) = &home {
        roots.extend(["Downloads", "Desktop", "Documents", "OneDrive\\Desktop", "OneDrive\\Documents"].map(|d| home.join(d)));
    }
    for root in roots {
        for d in subdirs(&root) {
            dirs.push(d.join("bin"));
            dirs.push(d.join(r"mingw64\bin"));
            dirs.push(d.join(r"mingw32\bin"));
            // An extra folder level, e.g. Downloads\winlibs-x86_64…\mingw64\bin.
            for inner in subdirs(&d) {
                let name = inner.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                if name.contains("mingw") || name.contains("gcc") || name.contains("winlibs") {
                    dirs.push(inner.join("bin"));
                    dirs.push(inner.join(r"mingw64\bin"));
                }
            }
        }
    }
    dirs
}

#[cfg(not(windows))]
fn usual_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// The folders in a folder (at most 200, so a huge folder can't slow a run down).
#[cfg_attr(not(windows), allow(dead_code))]
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries.flatten().take(200).filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect();
    out.sort();
    out
}

/// The full path of a program, searched for as described at `search_dirs`.
fn locate(program: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) { format!("{program}.exe") } else { program.to_string() };
    search_dirs().into_iter().map(|d| d.join(&file)).find(|p| p.is_file())
}

/// A command for a program found by `locate`: its own folder goes first on PATH (MinGW's gcc
/// needs it for its helper programs, and the programs it builds need its DLLs), then the saved PATH.
fn command_for(exe: &Path, tool_dir: Option<&Path>) -> Command {
    let mut cmd = Command::new(exe);
    let mut path: Vec<PathBuf> = tool_dir.map(Path::to_path_buf).into_iter().collect();
    path.extend(search_dirs().into_iter().filter(|d| d.is_dir()));
    if let Ok(joined) = std::env::join_paths(path.iter().filter(|d| !d.to_string_lossy().contains(';'))) {
        cmd.env("PATH", joined);
    }
    no_window(&mut cmd);
    cmd
}

/// The first line a program prints for `--version` and where it is, if it runs at all.
fn version_of(program: &str, args: &[&str]) -> Option<(String, PathBuf)> {
    let exe = locate(program)?;
    let out = command_for(&exe, exe.parent()).args(args).stdin(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    let line = String::from_utf8_lossy(&text).lines().next().unwrap_or(program).trim().to_string();
    Some((if line.is_empty() { program.to_string() } else { line }, exe))
}

/// Python on Windows: the "py" launcher first, because "python" may be the Microsoft Store stub.
fn python() -> Option<(PathBuf, Vec<String>)> {
    if let Some((_, exe)) = version_of("py", &["-3", "--version"]) {
        return Some((exe, vec!["-3".into()]));
    }
    ["python", "python3"]
        .into_iter()
        .find_map(|p| version_of(p, &["--version"]).filter(|(v, _)| v.starts_with("Python")))
        .map(|(_, exe)| (exe, vec![]))
}

/// "gcc (MinGW-W64) 14.2.0  ·  C:\mingw64\bin".
fn shown((version, exe): (String, PathBuf)) -> String {
    let dir = exe.parent().map(|d| d.display().to_string()).unwrap_or_default();
    format!("{version}  ·  {dir}")
}

#[tauri::command]
pub async fn code_toolchains() -> Vec<Toolchain> {
    tauri::async_runtime::spawn_blocking(|| {
        let gcc_get = "winlibs.com (MinGW-w64 GCC): unzip it to C:\\mingw64, Kairos finds it there";
        vec![
            Toolchain {
                language: "Python",
                found: python().and_then(|(p, a)| {
                    let mut args: Vec<&str> = a.iter().map(String::as_str).collect();
                    args.push("--version");
                    let name = p.file_stem()?.to_string_lossy().to_string();
                    version_of(&name, &args).map(|(v, _)| shown((v, p)))
                }),
                get: "python.org/downloads (tick \"Add python.exe to PATH\")",
            },
            Toolchain {
                language: "C",
                found: version_of("gcc", &["--version"]).or_else(|| version_of("clang", &["--version"])).map(shown),
                get: gcc_get,
            },
            Toolchain {
                language: "C++",
                found: version_of("g++", &["--version"]).or_else(|| version_of("clang++", &["--version"])).map(shown),
                get: gcc_get,
            },
            Toolchain { language: "Java", found: version_of("java", &["--version"]).map(shown), get: "adoptium.net (Temurin JDK 21)" },
            Toolchain { language: "JavaScript", found: version_of("node", &["--version"]).map(shown), get: "nodejs.org" },
            Toolchain { language: "Rust", found: version_of("rustc", &["--version"]).map(shown), get: "rustup.rs" },
            Toolchain { language: "Go", found: version_of("go", &["version"]).map(shown), get: "go.dev/dl" },
        ]
    })
    .await
    .unwrap_or_default()
}

/// C/C++ programs print straight away instead of when they end (output to a pipe is buffered),
/// so "Enter a number:" shows before the program waits for it.
const UNBUFFERED_C: &str = "#include <stdio.h>\n__attribute__((constructor)) static void focus_unbuffered(void) { setvbuf(stdout, NULL, _IONBF, 0); }\n";

/// Deletes earlier builds of this file; ones still in use are left for next time.
fn clear_old_builds(build_dir: &Path, stem: &str) {
    let Ok(entries) = std::fs::read_dir(build_dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let base = name.strip_suffix(".exe").unwrap_or(&name);
        let ours = base == stem || base.strip_prefix(stem).and_then(|r| r.strip_prefix('-')).is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()));
        if ours {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// A Windows job holding one run's program and everything it starts (Python's "py" launcher
/// starts python.exe, for one). Stop ends the whole job, and Windows ends it by itself when Focus
/// ends, however it ends (even when the installer force-closes Focus), so nothing is left running.
#[cfg_attr(not(windows), allow(dead_code))]
struct Job(usize);

#[cfg(windows)]
impl Job {
    fn holding(child: &Child) -> Option<Job> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectExtendedLimitInformation, SetInformationJobObject,
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let job = Job(job as usize);
            if AssignProcessToJobObject(job.0 as _, child.as_raw_handle() as _) == 0 {
                return None; // dropping closes it
            }
            Some(job)
        }
    }

    fn end(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0 as _, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(not(windows))]
impl Job {
    fn holding(_child: &Child) -> Option<Job> {
        None
    }
    fn end(&self) {}
}

/// How to run a file: an optional build step, then the program.
struct Plan {
    build: Option<Command>,
    run: Command,
}

fn plan(dir: &Path, name: &str, run_id: u64) -> Result<Plan, String> {
    let file = dir.join(name);
    let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or("program").to_string();
    let build_dir = dir.join(".build");
    std::fs::create_dir_all(&build_dir).map_err(|e| e.to_string())?;
    // A new program file every run: an older run that is still open (or being scanned by the
    // antivirus) keeps its file locked, and Windows would refuse to overwrite it.
    clear_old_builds(&build_dir, &stem);
    let exe = build_dir.join(if cfg!(windows) { format!("{stem}-{run_id}.exe") } else { format!("{stem}-{run_id}") });
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let missing = |what: &str, get: &str| {
        format!(
            "{what} was not found on this PC. Kairos looked on PATH and in the usual folders (C:\\mingw64\\bin, C:\\msys64\\ucrt64\\bin, Downloads, …).\n\
             Get it from {get}.\n\
             If it is installed already, run :checkhealth, or add the folder that holds {what}.exe to PATH (no restart of Kairos needed).\n"
        )
    };
    let tool = |program: &str| -> Result<(PathBuf, Command), String> {
        let exe = locate(program).ok_or_else(|| missing(program, "the language's website"))?;
        let cmd = command_for(&exe, exe.parent());
        Ok((exe, cmd))
    };

    let compiled = |compilers: &[&str], extra: &[&str]| -> Result<Plan, String> {
        let cc = compilers
            .iter()
            .find_map(|c| locate(c))
            .ok_or_else(|| missing(compilers[0], "winlibs.com (MinGW-w64 GCC, unzip it to C:\\mingw64)"))?;
        let helper = build_dir.join("focus_unbuffered.c");
        std::fs::write(&helper, UNBUFFERED_C).map_err(|e| e.to_string())?;
        let mut b = command_for(&cc, cc.parent());
        b.args(extra).arg(&file);
        // The helper is C; compile it as C even from g++.
        b.args(["-x", "c"]).arg(&helper).args(["-x", "none"]);
        b.arg("-o").arg(&exe);
        // The program finds the compiler's DLLs (libstdc++, libwinpthread) through PATH.
        Ok(Plan { build: Some(b), run: command_for(&exe, cc.parent()) })
    };

    match ext.as_str() {
        "py" => {
            let (py, args) = python().ok_or_else(|| missing("Python", "python.org/downloads"))?;
            let mut run = command_for(&py, py.parent());
            run.args(args).arg("-u").arg(&file);
            Ok(Plan { build: None, run })
        }
        "c" => compiled(&["gcc", "clang"], &["-O2", "-Wall"]),
        "cpp" | "cc" => compiled(&["g++", "clang++"], &["-std=c++17", "-O2", "-Wall"]),
        "java" => {
            // Java 11+ runs a single source file directly.
            let (_, mut run) = tool("java").map_err(|_| missing("Java", "adoptium.net (Temurin JDK 21)"))?;
            run.arg(&file);
            Ok(Plan { build: None, run })
        }
        "js" => {
            let (_, mut run) = tool("node").map_err(|_| missing("node", "nodejs.org"))?;
            run.arg(&file);
            Ok(Plan { build: None, run })
        }
        "rs" => {
            let (rustc, mut b) = tool("rustc").map_err(|_| missing("rustc", "rustup.rs"))?;
            b.arg("-O").arg(&file).arg("-o").arg(&exe);
            Ok(Plan { build: Some(b), run: command_for(&exe, rustc.parent()) })
        }
        "go" => {
            let (_, mut run) = tool("go").map_err(|_| missing("go", "go.dev/dl"))?;
            run.arg("run").arg(&file);
            Ok(Plan { build: None, run })
        }
        _ => Err(format!("{name} can't be run; Kairos runs .py .c .cpp .java .js .rs .go files")),
    }
}

fn say(app: &AppHandle, run_id: u64, stream: &'static str, text: impl Into<String>) {
    let _ = app.emit("code-output", Output { run_id, stream, text: text.into() });
}

/// Output waiting to go to the page. A program can print far faster than a window can draw, so
/// output is sent in batches a few times a second, and if it piles up only the newest part is kept.
#[derive(Default)]
struct Pending {
    parts: Vec<(&'static str, String)>,
    bytes: usize,
    skipped: usize,
}

/// At most this much output is sent per batch; anything older is skipped (and counted).
const MAX_BATCH: usize = 48 * 1024;
const FLUSH_EVERY: Duration = Duration::from_millis(70);

impl Pending {
    fn push(&mut self, stream: &'static str, text: String) {
        self.bytes += text.len();
        match self.parts.last_mut() {
            Some((s, t)) if *s == stream => t.push_str(&text),
            _ => self.parts.push((stream, text)),
        }
        while self.bytes > MAX_BATCH && !self.parts.is_empty() {
            let over = self.bytes - MAX_BATCH;
            let (_, first) = &mut self.parts[0];
            if first.len() <= over {
                self.bytes -= first.len();
                self.skipped += first.len();
                self.parts.remove(0);
            } else {
                // Cut at a character boundary.
                let mut cut = over;
                while !first.is_char_boundary(cut) {
                    cut += 1;
                }
                first.drain(..cut);
                self.bytes -= cut;
                self.skipped += cut;
            }
        }
    }
}

fn flush(app: &AppHandle, run_id: u64, pending: &Mutex<Pending>) {
    let batch = std::mem::take(&mut *pending.lock().unwrap());
    if batch.skipped > 0 {
        say(app, run_id, "info", format!("\n[… {} KB of output skipped to keep up …]\n", batch.skipped.div_ceil(1024)));
    }
    for (stream, text) in batch.parts {
        say(app, run_id, stream, text);
    }
}

fn pump(pending: Arc<Mutex<Pending>>, stream: &'static str, mut from: impl Read + Send + 'static) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = from.read(&mut buf) {
            if n == 0 {
                break;
            }
            pending.lock().unwrap().push(stream, String::from_utf8_lossy(&buf[..n]).into_owned());
        }
    })
}

/// Starts a step of a run (the compiler, then the program) and lets Stop reach it. Err = it could
/// not start, or Stop was pressed first.
fn start(app: &AppHandle, run_id: u64, cmd: &mut Command, keep_stdin: bool) -> Result<(Arc<Mutex<Child>>, Option<ChildStdin>, Option<std::process::ChildStdout>, Option<std::process::ChildStderr>), String> {
    let stdin = if keep_stdin { Stdio::piped() } else { Stdio::null() };
    let mut child = cmd.stdin(stdin).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let job = Job::holding(&child);
    let (stdin, out, err) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let child = Arc::new(Mutex::new(child));
    let state = app.state::<CodeState>();
    let mut runs = state.runs.lock().unwrap();
    let proc = Proc { child: child.clone(), job };
    match runs.get_mut(&run_id) {
        Some(run) if !run.stopped => run.proc = Some(proc),
        _ => {
            proc.stop();
            return Err("stopped".into());
        }
    }
    Ok((child, stdin, out, err))
}

fn stopped(app: &AppHandle, run_id: u64) -> bool {
    app.state::<CodeState>().runs.lock().unwrap().get(&run_id).is_none_or(|r| r.stopped)
}

/// Waits for a step to end, sending its output as it comes. None = it could not be waited on.
fn wait(app: &AppHandle, run_id: u64, child: &Mutex<Child>, pending: &Mutex<Pending>, live: bool, limit: Option<Duration>) -> Result<Option<i32>, &'static str> {
    let began = Instant::now();
    loop {
        match child.lock().unwrap().try_wait() {
            Ok(Some(status)) => return Ok(status.code()),
            Ok(None) => {}
            Err(_) => return Ok(None),
        }
        if live {
            flush(app, run_id, pending);
        }
        if limit.is_some_and(|l| began.elapsed() > l) {
            let _ = child.lock().unwrap().kill();
            return Err("timeout");
        }
        std::thread::sleep(FLUSH_EVERY);
    }
}

/// Builds (if needed) and starts the file. Returns the run id; output arrives as "code-output"
/// events and the end as "code-exit". The run can be stopped from the moment it is made, also
/// while Focus is still finding the compiler or compiling.
#[tauri::command]
pub fn code_run(app: AppHandle, state: tauri::State<'_, CodeState>, name: String) -> Result<u64, String> {
    let dir = folder(&app)?;
    checked(&name)?;
    let run_id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.runs.lock().unwrap().insert(run_id, Run::default());
    let app2 = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let finish = |code: Option<i32>| {
            app2.state::<CodeState>().runs.lock().unwrap().remove(&run_id);
            let _ = app2.emit("code-exit", Exit { run_id, code, ms: started.elapsed().as_millis() as u64 });
        };
        let plan = match plan(&dir, &name, run_id) {
            Ok(p) => p,
            Err(e) => {
                say(&app2, run_id, "err", e);
                return finish(None);
            }
        };
        if stopped(&app2, run_id) {
            return finish(None);
        }
        if let Some(mut build) = plan.build {
            say(&app2, run_id, "info", format!("compiling {name}…\n"));
            let (child, _, out, err) = match start(&app2, run_id, build.current_dir(&dir), false) {
                Ok(c) => c,
                Err(e) if e == "stopped" => return finish(None),
                Err(e) => {
                    say(&app2, run_id, "err", format!("could not start the compiler: {e}\n"));
                    return finish(None);
                }
            };
            let pending = Arc::new(Mutex::new(Pending::default()));
            let readers: Vec<_> = [out.map(|o| pump(pending.clone(), "out", o)), err.map(|e| pump(pending.clone(), "err", e))].into_iter().flatten().collect();
            let result = wait(&app2, run_id, &child, &pending, false, Some(Duration::from_secs(120)));
            for r in readers {
                let _ = r.join();
            }
            let text: String = std::mem::take(&mut *pending.lock().unwrap()).parts.into_iter().map(|(_, t)| t).collect();
            if stopped(&app2, run_id) {
                return finish(None);
            }
            match result {
                Err(_) => {
                    say(&app2, run_id, "err", "the compiler took over 2 minutes and was stopped\n");
                    return finish(None);
                }
                Ok(code) => {
                    let ok = code == Some(0);
                    if !text.trim().is_empty() {
                        say(&app2, run_id, if ok { "info" } else { "err" }, text);
                    }
                    if !ok {
                        say(&app2, run_id, "err", "build failed: the compiler's message above names the line to fix\n");
                        return finish(code);
                    }
                }
            }
        }
        let mut run = plan.run;
        let (child, stdin, out, err) = match start(&app2, run_id, run.current_dir(&dir), true) {
            Ok(c) => c,
            Err(e) if e == "stopped" => return finish(None),
            Err(e) => {
                say(&app2, run_id, "err", format!("could not start {name}: {e}\n"));
                return finish(None);
            }
        };
        if let Some(run) = app2.state::<CodeState>().runs.lock().unwrap().get_mut(&run_id) {
            run.stdin = stdin;
        }
        let pending = Arc::new(Mutex::new(Pending::default()));
        let readers: Vec<_> = [out.map(|o| pump(pending.clone(), "out", o)), err.map(|e| pump(pending.clone(), "err", e))].into_iter().flatten().collect();
        let code = wait(&app2, run_id, &child, &pending, true, None).unwrap_or(None);
        // Send the last of the output before saying it ended. A program it started may still hold
        // the pipes open, so don't wait on the readers for long.
        let deadline = Instant::now() + Duration::from_millis(500);
        for r in readers {
            while !r.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        flush(&app2, run_id, &pending);
        if code == Some(-1073741515) || code == Some(0xC000_0135u32 as i32) {
            say(&app2, run_id, "err", "\nWindows could not find a DLL the program needs (0xC0000135). Run :checkhealth to see which compiler Kairos used.\n");
        }
        finish(code);
    });
    Ok(run_id)
}

/// Types a line into the running program.
#[tauri::command]
pub fn code_stdin(state: tauri::State<'_, CodeState>, run_id: u64, text: String) -> Result<(), String> {
    let mut runs = state.runs.lock().unwrap();
    let run = runs.get_mut(&run_id).ok_or("the program is not running")?;
    let stdin = run.stdin.as_mut().ok_or("the program is not reading input yet")?;
    stdin.write_all(text.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
}

/// Ends the input (Ctrl+D / Ctrl+Z), for programs that read until the end.
#[tauri::command]
pub fn code_close_stdin(state: tauri::State<'_, CodeState>, run_id: u64) -> Result<(), String> {
    if let Some(run) = state.runs.lock().unwrap().get_mut(&run_id) {
        run.stdin = None;
    }
    Ok(())
}

/// Stops every program still running (Focus is closing), so none is left behind.
pub fn stop_all(app: &AppHandle) {
    if let Some(state) = app.try_state::<CodeState>() {
        for run in state.runs.lock().unwrap().values_mut() {
            run.stop();
        }
    }
}

/// Stops a run at any point: finding the compiler, compiling or running. Returns false when
/// Focus knows of no such run (it already ended), so the page can stop waiting for it.
#[tauri::command]
pub fn code_stop(state: tauri::State<'_, CodeState>, run_id: u64) -> bool {
    match state.runs.lock().unwrap().get_mut(&run_id) {
        Some(run) => {
            run.stop();
            true
        }
        None => false,
    }
}
