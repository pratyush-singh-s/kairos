# Focus 0.21.4.B: the Terminal theme looks like a real terminal

Install `Focus-0.21.4.B-installer.zip` over your current Focus (0.21.4, now called 0.21.4.A). Your data and
settings stay. The browser extension is unchanged.

Version names: the letter tells the look apart within the same release line. 0.21.4.A is the build before,
0.21.4.B is this one. Settings shows 0.21.4.B; the Windows "Installed apps" list shows 0.21.5, because
Windows needs a plain number that goes up to upgrade in place.

## What's new (Terminal theme only; Glass is unchanged)

- **Windows Terminal tab bar.** The title bar is a tab strip with a `>_` tab that names the shell and the page
  (`Windows PowerShell · focus notes`).
- **Each page is printed by a command.** The top line shows `PS C:\Focus> focus dashboard`, and the page reads
  like its output.
- **A live prompt under every page**, with a blinking block cursor. Click it or press `Ctrl` + `` ` `` and type:
  - a page name: `dashboard`, `timer`, `history`, `todo`, `deadlines`, `notes`, `calendar`, `stats`,
    `blocking`, `sync`, `settings` (also `cd notes`)
  - `help`, `ls`, `date`, `clear` (or `cls`, `Ctrl` + `L`), `glass` (switch theme), `exit` (close the window)
  - `Tab` finishes a page name, `Up` / `Down` bring back earlier commands, `Esc` leaves the prompt.
- **tmux-style status line** along the bottom: `[focus] 0:page*`, the running timer (click it to open the
  timer) and the clock.
- **Settings > Appearance** (when Terminal is on): pick the **Shell** prompt (PowerShell `PS C:\Focus>`,
  Bash `you@focus:~$`, Command Prompt `C:\Focus>`) and turn on the **Old screen effect** (CRT scan lines and
  a soft glow; off by default).

All Terminal colour palettes (Dark, Phosphor, Amber, Dracula, Nord, Gruvbox, Custom) work with the new parts.

## 0.21.5.B: borders made of characters

Every panel border is now drawn with box-drawing characters, like a real terminal app:

```
┌─1 today's tasks ──────────┐
│ [ ] Gym                   │
└───────────────────────────┘
```

- Panels, the To-do week board and the menu's edge use `┌ ─ ┐ │ └ ┘`; the panel title and number sit in
  the top line, and the panel you point at lights up green.
- Day columns on the To-do board are split by `│`, with a `────` rule under each day.
- Buttons read `[ Pause ]` instead of having a box; text fields are a highlighted strip with no outline.
- Windows "Installed apps" shows 0.21.6 for this build (it needs a plain number that goes up).

## 0.21.6.B: Code page, Neovim look, keyboard moves, typing sound

**Code page** (Terminal theme only; Alt+7 or type `code` / `nvim` at the prompt). Laid out like Neovim:
file tree on the left, the file with line numbers, a status line with the mode, and a terminal split
underneath.

- Files are plain files in `Documents\Focus Code` (open them in any other editor too). Press **+** and type
  a name such as `hello.py`, `main.cpp`, `test.c`, `Main.java`, `app.js`, `main.rs`, `main.go`; it starts
  with a small example. In the tree: Enter opens, `r` renames, `d` deletes.
- **Run**: F5, Ctrl+Enter or the Run button. Output appears live in the terminal split. When the program
  asks for input, type it there and press Enter. Ctrl+C stops it, Ctrl+D ends the input.
- Saving: Ctrl+S, and anything typed is saved by itself a moment later.
- **Vim keys** (bottom of the file tree): `i` to type, Esc for normal mode, `:w` saves, `:run` runs.
- Focus runs your code with the compilers installed on this PC. `:checkhealth` (bottom of the file tree)
  shows which ones it found. To install:
  - Python: python.org/downloads (tick "Add python.exe to PATH")
  - C and C++: winlibs.com (MinGW-w64 GCC), then add its `bin` folder to PATH
  - Java: adoptium.net (Temurin JDK 21)
  - JavaScript: nodejs.org · Rust: rustup.rs · Go: go.dev/dl
  Restart Focus after installing.

**Keyboard**

- Alt+1 … Alt+9 and Alt+0 open the pages in menu order (the numbers are shown in the menu): Alt+1
  Dashboard, Alt+2 Focus timer, Alt+3 History, Alt+4 To-do, Alt+5 Deadlines, Alt+6 Notes, Alt+7 Code,
  Alt+8 Calendar, Alt+9 Statistics, Alt+0 Blocking.
- In the Terminal theme the arrow keys move between buttons, links and boxes, like moving between windows
  in Neovim. In a text box Left/Right still move the caret.

**Neovim look**: the bottom bar is a lualine-style status line that shows the mode (NORMAL, INSERT while
you type in a box, COMMAND at the prompt), the page, the timer, how far down you are (Top, Bot, 42%) and
the clock. Empty space under a page shows `~` lines like an empty Neovim buffer.

**Typing sound** (Settings > Typing sound, every theme): Creamy + thock (default), Thock, Creamy or Off,
with a volume slider and a box to try it. The sounds are made by Focus itself, a little different on every
key, deeper on Space, Enter and Backspace, with a soft sound when you let go.

Windows "Installed apps" shows 0.21.7 for this build.

## 0.21.7.B: runaway programs can't freeze Focus

- A program that prints without end (for example a loop that never stops) no longer freezes Focus. Output
  is sent to the screen a few times a second, and when it comes faster than anyone can read, Focus shows
  the newest part with a note like `[… 512 KB of output skipped to keep up …]`. Press Stop (or Ctrl+C in
  the terminal) to end it.
- Closing Focus also stops any program still running from the Code page.
- Windows "Installed apps" shows 0.21.8 for this build.

## 0.21.8.B: no leftover programs, no "Permission denied"

- Each run builds a fresh program file, so a copy that is still open (or being scanned by your
  antivirus) can no longer block the next build with "cannot open output file … Permission denied".
- Every program started from the Code page, and anything it starts, is ended when you press Stop and
  when Focus closes for any reason, including when the installer closes Focus to upgrade it.
- Windows "Installed apps" shows 0.21.9 for this build.

## 0.21.9.B: logo on the Dashboard

- In the Terminal theme the Dashboard opens with a big FOCUS logo in block characters (shading from the
  accent colour to blue, following your palette), like a Neovim start screen. The Code page's start
  screen uses the same logo. Glass is unchanged.
- Windows "Installed apps" shows 0.21.10 for this build.

## 0.21.10.B: your icon as the Dashboard logo

- The Terminal-theme Dashboard now shows your own icon (the brain with four arrows) drawn in block
  characters, with the same accent-to-blue shading. The Code page's start screen keeps the FOCUS
  letters. Glass is unchanged.
- Windows "Installed apps" shows 0.21.11 for this build.

## 0.21.11.B: Dashboard logo removed

- The logo is gone from the Terminal-theme Dashboard; it opens straight on your cards again. The Code
  page's start screen still shows the FOCUS letters.
- Windows "Installed apps" shows 0.21.12 for this build.

## 0.21.16.B: Neovim keys on the Code page

- Vim keys are now **on by default** on the Code page (switch them off with "vim keys" under the file
  tree). The status lines show the mode: NORMAL, INSERT, VISUAL, V-LINE, V-BLOCK, REPLACE, COMMAND.
- Everything Vim already had keeps working (motions, operators, text objects, registers, macros, marks,
  `/` search, `:s`, `gcc` comments). New on top, the Neovim way:
  - **Space is the leader**: `Space w` save, `Space q` save + close, `Space r` run, `Space e` file tree,
    `Space t` terminal, `Space n` new file, `Space b` list files, `Space y` / `Space p` Windows
    clipboard, `Space ?` the cheat sheet. `]b` / `[b` next / previous file.
  - `jk` (typed quickly) leaves insert mode. `ZZ` saves and closes, `ZQ` closes without saving.
  - **Windows**: `Ctrl+h` file tree, `Ctrl+j` terminal, `Ctrl+l` / `Ctrl+k` / `Esc` back to the code;
    `Ctrl+w h/j/k/l/w` too.
  - **File tree** (nvim-tree keys): `j` `k` move, `l` `o` Enter open, `a` new, `r` rename, `d` delete,
    `R` refresh, `q` back to the code.
  - **Commands**: `:w`, `:w name.py` (save as), `:wq`, `:x`, `:q` (E37 if unsaved), `:q!`, `:e name.py`
    (open or make), `:e!` (reload), `:enew`, `:bn`, `:bp`, `:bd`, `:ls`, `:Ex`, `:Lex`,
    `:NvimTreeToggle`, `:term`, `:run`, `:make`, `:checkhealth`, `:set rnu` / `:set nornu` (relative
    line numbers), `:help`.
- **⌨ ? button** (top right of the Code page, next to Run): opens a panel with every shortcut. `:help` and
  `Space ?` open it too; `q` or Esc closes it.
- **Statistics, "When you focus"**: on Month and Year it is now a GitHub-style calendar (one column
  per week, weekdays down the left, months along the top, each day shaded by focus time, today
  outlined). Week keeps the weekday-by-hour grid.
- Terminal theme: heat grids fill each cell with ░▒▓█ runs (no dotted gaps); bars on the History
  and Statistics pages are thin solid columns (no uneven stripes); deadline tiles in "bars" style
  no longer overlap.
- Deadlines show one dot / square per day for anything up to a year (it used to switch to one per
  week after 120 days). "Rounded square" cells have small corners now.
- Windows "Installed apps" shows 0.21.17 for this build.
