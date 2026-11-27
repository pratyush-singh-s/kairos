# Building from source (optional)

You do not need this to use Focus; each phase ships a ready-made installer.
These steps are for running the code yourself on Windows 11.

## One-time setup

1. **Microsoft C++ Build Tools**: install "Desktop development with C++" from
   https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. **Rust**: install from https://rustup.rs (default options).
3. **Node.js 22 LTS**: install from https://nodejs.org
4. **pnpm**: in PowerShell run `corepack enable` then `corepack prepare pnpm@10.28.0 --activate`
5. WebView2 is already part of Windows 11.

Check with:

```powershell
rustc --version
node --version
pnpm --version
```

## Run

From the `focus` folder:

```powershell
pnpm install
pnpm test          # unit tests
pnpm typecheck     # TypeScript checks
pnpm dev           # opens the desktop app with live reload
```

Firefox extension:

```powershell
pnpm build:extension
cd apps/extension
pnpm start         # opens a test Firefox with the extension loaded
```

## Build an installer

```powershell
pnpm build:desktop
```

The installer appears in `apps/desktop/src-tauri/target/release/bundle/nsis/`.
`scripts/build-release.sh` builds everything into `release/<version>/` (Git Bash on Windows, or Linux).
