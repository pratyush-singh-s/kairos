import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeStdin,
  codeFolder,
  codeToolchains,
  deleteCode,
  listCode,
  onCodeExit,
  onCodeOutput,
  readCode,
  renameCode,
  runCode,
  saveCode,
  sendStdin,
  stopCode,
  type CodeExit,
  type CodeFile,
  type CodeOutput,
} from "../../ipc/code";
import { ALLOWED, LANGUAGES, canRun, extOf, languageOf } from "./languages";
import { Editor, type EditorHandle, type EditorMode } from "./Editor";
import { Logo } from "../../app/terminal/Logo";
import { VIM_HELP, type VimCommand } from "./vimKeys";
import { PALETTES } from "@focus/ui";
import { useUi } from "../../theme/UiProvider";

/** The Terminal colour schemes, named the way :colorscheme takes them. */
const SCHEMES = PALETTES.terminal.map((p) => ({ id: p.id, label: p.label, name: p.label.toLowerCase().replace(/é/g, "e").replace(/\s+/g, "-") }));

const VIM_KEY = "focus.code.vim";
const RNU_KEY = "focus.code.rnu";
const LAST_KEY = "focus.code.last";
/** Characters of output kept on screen. */
const MAX_SHOWN = 60_000;

interface Line {
  id: number;
  stream: "out" | "err" | "info" | "in";
  text: string;
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Only a convenience.
  }
}

/**
 * The Code page (Terminal theme only), laid out like Neovim: a file tree on the left, the buffer
 * with line numbers, a status line with the mode, and a terminal split underneath where the
 * program runs. Files are plain files in Documents\Focus Code.
 */
export function CodePage() {
  const ui = useUi();
  const [files, setFiles] = useState<CodeFile[]>([]);
  const [folder, setFolder] = useState("");
  const [open, setOpen] = useState<{ name: string; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1, lines: 1 });
  const [mode, setMode] = useState<EditorMode>("NORMAL");
  // Vim keys are on unless they were switched off.
  const [vimKeys, setVimKeys] = useState(() => readPref(VIM_KEY) !== "off");
  const [relativeNumbers, setRelativeNumbers] = useState(() => readPref(RNU_KEY) === "on");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(() =>
    readPref(VIM_KEY) === null ? { text: "Vim keys are on: i to type, Esc (or jk) for normal mode, :help lists every shortcut" } : null,
  );
  const [newName, setNewName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [runId, setRunId] = useState<number | null>(null);
  const [stdin, setStdin] = useState("");
  const text = useRef("");
  const editor = useRef<EditorHandle>(null);
  const outEnd = useRef<HTMLDivElement>(null);
  const runRef = useRef<number | null>(null);
  runRef.current = runId;
  const nextLine = useRef(1);
  const stdinInput = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const [showKeys, setShowKeys] = useState(false);
  /** A run is being started: its id is not known yet, so its first output is held until it is. */
  const starting = useRef(false);
  const early = useRef<({ kind: "out"; o: CodeOutput } | { kind: "exit"; x: CodeExit })[]>([]);
  const stopTimer = useRef<number | undefined>(undefined);
  const keysPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showKeys) keysPanel.current?.focus();
  }, [showKeys]);

  function closeKeys() {
    setShowKeys(false);
    requestAnimationFrame(() => editor.current?.focus());
  }

  // The lualine along the bottom of the window shows the editor's mode too.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("focus-code-mode", { detail: mode }));
  }, [mode]);
  useEffect(() => () => void window.dispatchEvent(new CustomEvent("focus-code-mode", { detail: null })), []);

  // Only the newest output is kept on screen, so a program that prints without end can't slow Focus.
  const print = useCallback((stream: Line["stream"], t: string) => {
    setLines((ls) => {
      const next = [...ls, { id: nextLine.current++, stream, text: t }];
      let total = next.reduce((n, l) => n + l.text.length, 0);
      while (total > MAX_SHOWN && next.length > 1) total -= next.shift()!.text.length;
      if (total > MAX_SHOWN) next[0] = { ...next[0]!, text: next[0]!.text.slice(total - MAX_SHOWN) };
      return next;
    });
  }, []);

  const ended = useCallback(
    (x: CodeExit) => {
      window.clearTimeout(stopTimer.current);
      const secs = (x.ms / 1000).toFixed(2);
      print("info", `\n[Process exited ${x.code === null ? "" : `with code ${x.code} `}in ${secs}s]\n`);
      runRef.current = null;
      setRunId(null);
    },
    [print],
  );

  const refresh = useCallback(() => {
    listCode()
      .then(setFiles)
      .catch((e) => setMessage({ text: String(e), error: true }));
  }, []);

  useEffect(() => {
    refresh();
    codeFolder().then(setFolder).catch(() => {});
    const last = readPref(LAST_KEY);
    if (last) void openFile(last, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Output of the running program, as it is printed.
  useEffect(() => {
    let alive = true;
    const offs: (() => void)[] = [];
    onCodeOutput((o) => {
      if (o.runId === runRef.current) print(o.stream, o.text);
      else if (starting.current) early.current.push({ kind: "out", o });
    })
      .then((u) => (alive ? offs.push(u) : u()))
      .catch(() => {});
    onCodeExit((x) => {
      if (x.runId !== runRef.current) {
        if (starting.current) early.current.push({ kind: "exit", x });
        return;
      }
      ended(x);
    })
      .then((u) => (alive ? offs.push(u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      offs.forEach((u) => u());
    };
  }, [print, ended]);

  useEffect(() => {
    outEnd.current?.scrollIntoView({ block: "nearest" });
  }, [lines]);

  async function save(quiet = false): Promise<boolean> {
    if (!open) return false;
    try {
      await saveCode(open.name, text.current);
      setDirty(false);
      if (!quiet) setMessage({ text: `"${open.name}" ${text.current.split("\n").length}L, ${new Blob([text.current]).size}B written` });
      refresh();
      return true;
    } catch (e) {
      setMessage({ text: `E212: Can't write: ${String(e)}`, error: true });
      return false;
    }
  }

  // Unsaved changes are written a moment after typing stops, so nothing is ever lost.
  useEffect(() => {
    if (!dirty) return;
    const t = window.setTimeout(() => void save(true), 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, cursor]);

  async function openFile(name: string, quiet = false, discard = false) {
    if (open && dirty && !discard) await save(true);
    try {
      const body = await readCode(name);
      text.current = body;
      setOpen({ name, text: body });
      setDirty(false);
      writePref(LAST_KEY, name);
      if (!quiet) setMessage({ text: `"${name}" ${body.split("\n").length}L` });
      requestAnimationFrame(() => editor.current?.focus());
    } catch (e) {
      if (!quiet) setMessage({ text: String(e), error: true });
    }
  }

  async function create(raw: string) {
    let name = raw.trim();
    if (!name) return setNewName(null);
    if (!name.includes(".")) name += ".py";
    const ext = extOf(name);
    if (!ALLOWED.includes(ext)) {
      setMessage({ text: `E32: Kairos Code can make ${ALLOWED.map((e) => "." + e).join(" ")} files`, error: true });
      return;
    }
    if (files.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      setNewName(null);
      return void openFile(name);
    }
    const stem = name.slice(0, name.lastIndexOf("."));
    const starter = languageOf(name)?.starter(stem) ?? "";
    try {
      await saveCode(name, starter);
      setNewName(null);
      refresh();
      await openFile(name);
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`Delete ${name}? It goes for good (not to the Recycle Bin).`)) return;
    try {
      await deleteCode(name);
      if (open?.name === name) setOpen(null);
      setMessage({ text: `"${name}" deleted` });
      refresh();
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  }

  async function rename(from: string, raw: string) {
    const to = raw.trim();
    setRenaming(null);
    if (!to || to === from) return;
    try {
      if (open?.name === from && dirty) await save(true);
      await renameCode(from, to);
      if (open?.name === from) {
        setOpen({ name: to, text: text.current });
        writePref(LAST_KEY, to);
      }
      refresh();
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  }

  async function run() {
    if (!open) return;
    if (!canRun(open.name)) {
      setMessage({ text: `${open.name} can't be run; open a .py .c .cpp .java .js .rs or .go file`, error: true });
      return;
    }
    if (runRef.current !== null) await stopCode(runRef.current).catch(() => false);
    if (!(await save(true))) return;
    window.clearTimeout(stopTimer.current);
    setLines([]);
    print("info", `$ run ${open.name}\n`);
    starting.current = true;
    early.current = [];
    try {
      const id = await runCode(open.name);
      runRef.current = id;
      setRunId(id);
      // Output (or the end) that came before the id did: a missing compiler fails at once.
      const held = early.current;
      early.current = [];
      starting.current = false;
      for (const e of held) {
        if (e.kind === "out" && e.o.runId === id) print(e.o.stream, e.o.text);
        else if (e.kind === "exit" && e.x.runId === id) ended(e.x);
      }
      requestAnimationFrame(() => stdinInput.current?.focus());
    } catch (e) {
      starting.current = false;
      print("err", `${String(e)}\n`);
    }
  }

  /** Stop always works: if Focus doesn't report the end within 2 s, the page stops waiting. */
  async function stop() {
    const id = runRef.current;
    if (id === null) return;
    print("info", "^C\n");
    const known = await stopCode(id).catch(() => false);
    const giveUp = () => {
      if (runRef.current !== id) return;
      print("info", "\n[Stopped]\n");
      runRef.current = null;
      setRunId(null);
    };
    window.clearTimeout(stopTimer.current);
    if (!known) giveUp();
    else stopTimer.current = window.setTimeout(giveUp, 2000);
  }

  async function checkHealth() {
    setLines([]);
    print("info", ":checkhealth\n\nfocus.code: looking for compilers on this PC…\n");
    const found = await codeToolchains().catch(() => []);
    for (const t of found) {
      print(t.found ? "out" : "err", `  ${t.found ? "OK" : "--"}  ${t.language.padEnd(11)}${t.found ?? `not found: get it from ${t.get}`}\n`);
    }
    print("info", "\nAfter installing one, restart Kairos so it can find it.\n");
  }

  const scheme = SCHEMES.find((x) => x.id === ui.terminalPalette) ?? (ui.terminalPalette === "custom" ? null : SCHEMES[0]!);

  /** :colorscheme name switches the Terminal colours; with no name it lists them. */
  function colorscheme(raw: string) {
    const want = raw.trim().toLowerCase();
    if (!want) {
      setLines([]);
      print("info", ":colorscheme\n\n");
      for (const x of SCHEMES) print(x.id === scheme?.id ? "out" : "info", `  ${x.id === scheme?.id ? ">" : " "} ${x.name}\n`);
      print("info", "\n:colo <name> switches · the same list is in Settings > Appearance\n");
      return;
    }
    const found = SCHEMES.find((x) => x.name === want || x.id === want || x.name.startsWith(want));
    if (!found) {
      setMessage({ text: `E185: Cannot find color scheme '${raw.trim()}' (:colo lists them)`, error: true });
      return;
    }
    ui.update("terminalPalette", found.id);
    setMessage({ text: `:colorscheme ${found.name}` });
  }

  function nextScheme() {
    const at = SCHEMES.findIndex((x) => x.id === scheme?.id);
    const next = SCHEMES[(at + 1) % SCHEMES.length]!;
    ui.update("terminalPalette", next.id);
    setMessage({ text: `:colorscheme ${next.name}` });
  }

  function close() {
    setOpen(null);
    setDirty(false);
    writePref(LAST_KEY, "");
    setMessage(null);
  }

  async function saveAs(raw: string) {
    let name = raw.trim();
    if (!name.includes(".")) name += open ? "." + extOf(open.name) : ".py";
    if (!ALLOWED.includes(extOf(name))) {
      setMessage({ text: `E32: Kairos Code can make ${ALLOWED.map((e) => "." + e).join(" ")} files`, error: true });
      return;
    }
    try {
      if (open && dirty) await save(true);
      await saveCode(name, text.current);
      refresh();
      await openFile(name, true, true);
      setMessage({ text: `"${name}" ${text.current.split("\n").length}L written` });
    } catch (e) {
      setMessage({ text: `E212: Can't write: ${String(e)}`, error: true });
    }
  }

  function focusTree() {
    const tree = treeRef.current;
    const target = tree?.querySelector<HTMLElement>('li[data-open="true"] .code-file') ?? tree?.querySelector<HTMLElement>(".code-file") ?? tree?.querySelector<HTMLElement>(".code-icon-button");
    target?.focus();
  }

  function focusTerm() {
    if (stdinInput.current) stdinInput.current.focus();
    else termRef.current?.focus();
  }

  function focusEditor() {
    editor.current?.focus();
  }

  /** Leader keys and : commands from the editor. */
  async function onVim(c: VimCommand) {
    switch (c.kind) {
      case "save":
        if (c.name) await saveAs(c.name);
        else await save();
        return;
      case "save-all":
        await save();
        return;
      case "run":
        return void run();
      case "quit":
        if (!open) return;
        if (c.save) {
          if (!(await save(true))) return;
        } else if (dirty && !c.force) {
          setMessage({ text: "E37: No write since last change (add ! to override)", error: true });
          return;
        }
        close();
        requestAnimationFrame(focusTree);
        return;
      case "edit": {
        if (!c.name) {
          if (open) await openFile(open.name, false, c.force);
          return;
        }
        const found = files.find((f) => f.name.toLowerCase() === c.name.toLowerCase());
        if (found) await openFile(found.name);
        else await create(c.name);
        return;
      }
      case "new":
        setNewName("");
        return;
      case "buffer": {
        if (files.length === 0) return;
        const at = files.findIndex((f) => f.name === open?.name);
        const next = files[(at + c.step + files.length) % files.length]!;
        await openFile(next.name);
        return;
      }
      case "list":
        setLines([]);
        print("info", ":ls\n");
        files.forEach((f, i) => print(f.name === open?.name ? "out" : "info", `  ${String(i + 1).padStart(3)} ${f.name === open?.name ? "%a" : "  "}  "${f.name}"\n`));
        if (files.length === 0) print("info", "  (no files)\n");
        return;
      case "window":
        if (c.to === "tree" || (c.to === "toggle-tree" && !treeRef.current?.contains(document.activeElement))) focusTree();
        else if (c.to === "term") focusTerm();
        else focusEditor();
        return;
      case "help":
        setShowKeys(true);
        return;
      case "health":
        return void checkHealth();
      case "stop":
        return void stop();
      case "colorscheme":
        return colorscheme(c.name);
      case "relative-numbers":
        setRelativeNumbers(c.on);
        writePref(RNU_KEY, c.on ? "on" : "off");
        return;
    }
  }

  /** nvim-tree keys on a file in the tree. */
  function onTreeKey(e: React.KeyboardEvent<HTMLButtonElement>, name: string) {
    const key = e.key;
    const buttons = Array.from(treeRef.current?.querySelectorAll<HTMLButtonElement>(".code-file") ?? []);
    const at = buttons.indexOf(e.currentTarget);
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.ctrlKey && (key === "l" || key === "k")) return handled(), focusEditor();
    if (e.ctrlKey && key === "j") return handled(), focusTerm();
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (key === "F2" || key === "r") return handled(), setRenaming(name);
    if (key === "Delete" || key === "d") return handled(), void remove(name);
    if (key === "j") return handled(), buttons[Math.min(at + 1, buttons.length - 1)]?.focus();
    if (key === "k") return handled(), buttons[Math.max(at - 1, 0)]?.focus();
    if (key === "G") return handled(), buttons[buttons.length - 1]?.focus();
    if (key === "l" || key === "o") return handled(), void openFile(name);
    if (key === "a" || key === "%") return handled(), setNewName("");
    if (key === "R") return handled(), refresh();
    if (key === "q" || key === "Escape") return handled(), focusEditor();
  }

  /** Leaving the terminal split for the code. */
  function onTermKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" || (e.ctrlKey && (e.key === "k" || e.key === "l"))) {
      e.preventDefault();
      focusEditor();
    } else if (e.ctrlKey && e.key === "h") {
      e.preventDefault();
      focusTree();
    }
  }

  function toggleVim() {
    const next = !vimKeys;
    setVimKeys(next);
    writePref(VIM_KEY, next ? "on" : "off");
    setMessage({ text: next ? ":set keymap=vim  (i to type, Esc or jk for normal mode, :help lists the shortcuts)" : ":set keymap=normal" });
    requestAnimationFrame(() => editor.current?.focus());
  }

  function onStdinKey(e: React.KeyboardEvent<HTMLInputElement>) {
    const id = runRef.current;
    if (id === null) return;
    if (e.key === "Enter") {
      e.preventDefault();
      print("in", stdin + "\n");
      void sendStdin(id, stdin + "\n").catch((err) => print("err", `${String(err)}\n`));
      setStdin("");
    } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void stop();
    } else if (e.ctrlKey && (e.key.toLowerCase() === "d" || e.key.toLowerCase() === "z")) {
      e.preventDefault();
      print("info", "^D\n");
      void closeStdin(id);
    }
  }

  const language = open ? languageOf(open.name) : undefined;
  const percent = cursor.lines <= 1 ? "All" : cursor.line === 1 ? "Top" : cursor.line >= cursor.lines ? "Bot" : `${Math.round((cursor.line / cursor.lines) * 100)}%`;

  return (
    <section
      className="code-page"
      aria-label="Code"
      onKeyDownCapture={(e) => {
        if (e.key === "F5" && e.shiftKey && runRef.current !== null) {
          e.preventDefault();
          e.stopPropagation();
          void stop();
        }
      }}
    >
      <h1 className="visually-hidden">Code</h1>
      <div className="code-split">
        <nav className="code-tree" aria-label="Files" ref={treeRef}>
          <div className="code-tree-head">
            <span className="code-tree-root" title={folder}>
              ~/Focus Code
            </span>
            <button type="button" className="code-icon-button" title="New file" aria-label="New file" onClick={() => setNewName("")}>
              +
            </button>
          </div>
          <ul className="code-files">
            {files.map((f, i) => {
              const last = i === files.length - 1 && newName === null;
              const lang = languageOf(f.name);
              return (
                <li key={f.name} data-open={open?.name === f.name}>
                  {renaming === f.name ? (
                    <input
                      className="code-name-input"
                      defaultValue={f.name}
                      autoFocus
                      aria-label={`New name for ${f.name}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(f.name, e.currentTarget.value);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={(e) => void rename(f.name, e.currentTarget.value)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="code-file"
                      onClick={() => void openFile(f.name)}
                      onKeyDown={(e) => onTreeKey(e, f.name)}
                      title="Enter or l opens · j k move · a new · r renames · d deletes · q back to the code"
                    >
                      <span className="code-branch" aria-hidden="true">
                        {last ? "└─" : "├─"}
                      </span>
                      <span className="code-tag" data-ext={extOf(f.name)} aria-hidden="true">
                        {lang?.tag ?? "txt"}
                      </span>
                      <span className="code-file-name">{f.name}</span>
                      {open?.name === f.name && dirty && <span className="code-dirty">●</span>}
                    </button>
                  )}
                </li>
              );
            })}
            {newName !== null && (
              <li>
                <input
                  className="code-name-input"
                  autoFocus
                  placeholder="name.py / main.cpp / Main.java"
                  aria-label="New file name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void create(newName);
                    if (e.key === "Escape") setNewName(null);
                  }}
                  onBlur={() => newName.trim() === "" && setNewName(null)}
                />
              </li>
            )}
          </ul>
          {files.length === 0 && newName === null && <p className="code-empty-tree">No files yet. Press + to make one.</p>}
          <div className="code-tree-foot">
            <button type="button" className="code-link" onClick={() => void checkHealth()}>
              :checkhealth
            </button>
            <button type="button" className="code-link" onClick={nextScheme} title="Next colour scheme (:colo lists them all)">
              colorscheme: {scheme?.name ?? "custom"}
            </button>
            <button type="button" className="code-link" onClick={toggleVim} aria-pressed={vimKeys}>
              vim keys: {vimKeys ? "on" : "off"}
            </button>
            {vimKeys && (
              <button type="button" className="code-link" onClick={() => void onVim({ kind: "help" })}>
                :help  vim shortcuts
              </button>
            )}
          </div>
        </nav>

        <div className="code-main">
          <div className="code-tabline" role="toolbar" aria-label="File">
            {open ? (
              <span className="code-tab" data-active="true">
                <span className="code-tag" data-ext={extOf(open.name)}>
                  {language?.tag ?? "txt"}
                </span>{" "}
                {open.name}
                {dirty ? " ●" : ""}
              </span>
            ) : (
              <span className="code-tab">[No Name]</span>
            )}
            <span className="code-tabline-fill" />
            <button
              type="button"
              className="code-tab-action code-keys-button"
              onClick={() => (showKeys ? closeKeys() : setShowKeys(true))}
              aria-pressed={showKeys}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (:help or Space ?)"
            >
              ⌨ ?
            </button>
            {open && (
              <>
                <button type="button" className="code-tab-action" onClick={() => setRenaming(open.name)}>
                  rename
                </button>
                <button type="button" className="code-tab-action" onClick={() => void remove(open.name)}>
                  delete
                </button>
              </>
            )}
            {runId !== null ? (
              <button type="button" className="button" onClick={() => void stop()} title="Stop (Ctrl+C in the terminal, or Shift+F5)">
                ■ Stop
              </button>
            ) : (
              <button type="button" className="button primary" onClick={() => void run()} disabled={!open} title="Run (F5 or Ctrl+Enter)">
                ▶ Run
              </button>
            )}
          </div>

          {showKeys && (
            <div
              ref={keysPanel}
              className="code-keys"
              role="dialog"
              aria-label="Keyboard shortcuts"
              tabIndex={-1}
              onKeyDown={(e) => {
                if (e.key === "Escape" || e.key === "q" || (e.key === "?" && !e.ctrlKey)) {
                  e.preventDefault();
                  e.stopPropagation();
                  closeKeys();
                } else if (e.key === "j" || e.key === "k") {
                  e.preventDefault();
                  keysPanel.current?.querySelector(".code-keys-body")?.scrollBy(0, e.key === "j" ? 40 : -40);
                }
              }}
            >
              <div className="code-keys-head">
                <span>:help vim-keys</span>
                <span className="muted">{vimKeys ? "j k or the wheel scroll · q or Esc closes" : "vim keys are off: switch them on under the file tree"}</span>
                <button type="button" className="code-tab-action" onClick={closeKeys} aria-label="Close shortcuts">
                  [ x ]
                </button>
              </div>
              <pre className="code-keys-body">{VIM_HELP}</pre>
            </div>
          )}

          <div className="code-buffer">
            {open ? (
              <Editor
                ref={editor}
                name={open.name}
                text={open.text}
                vimKeys={vimKeys}
                relativeNumbers={relativeNumbers}
                onChange={(t) => {
                  text.current = t;
                  setDirty(true);
                }}
                onCursor={(line, col, n) => setCursor({ line, col, lines: n })}
                onMode={setMode}
                onSave={() => void save()}
                onRun={() => void run()}
                onVim={(c) => void onVim(c)}
              />
            ) : (
              <Intro onNew={() => setNewName("")} />
            )}
          </div>

          <div className="code-statusline" data-mode={mode}>
            <span className="code-mode">{mode}</span>
            <span className="code-seg">{language?.name ?? "text"}</span>
            <span className="code-seg code-seg-file">
              {open?.name ?? "[No Name]"}
              {dirty ? " [+]" : ""}
            </span>
            <span className="code-fill" />
            <span className="code-seg">utf-8</span>
            <span className="code-seg">{percent}</span>
            <span className="code-pos">
              {cursor.line}:{cursor.col}
            </span>
          </div>
          <div className="code-cmdline" role="status" aria-live="polite" data-error={message?.error || undefined}>
            {message?.text ?? ""}
          </div>

          <div className="code-term" ref={termRef} tabIndex={-1} onKeyDown={onTermKey} onClick={() => stdinInput.current?.focus()}>
            <div className="code-term-head">
              <span>term://{open?.name ?? "focus"}</span>
              <span className="code-term-hint">
                {runId !== null ? "running · Enter sends a line · Ctrl+C stops · Ctrl+D ends input" : "F5 runs · output appears here"}
              </span>
              {lines.length > 0 && runId === null && (
                <button type="button" className="code-link" onClick={() => setLines([])}>
                  clear
                </button>
              )}
            </div>
            <pre className="code-output" aria-live="polite">
              {lines.map((l) => (
                <span key={l.id} data-stream={l.stream}>
                  {l.text}
                </span>
              ))}
              {runId !== null && (
                <input
                  ref={stdinInput}
                  className="code-stdin"
                  value={stdin}
                  onChange={(e) => setStdin(e.target.value)}
                  onKeyDown={onStdinKey}
                  aria-label="Type into the running program"
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
              <div ref={outEnd} />
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Neovim's start screen, Focus style. */
function Intro(props: { onNew: () => void }) {
  return (
    <div className="code-intro">
      <Logo />
      <p>Kairos Code · write and run small programs</p>
      <p className="muted">{LANGUAGES.map((l) => l.name).join(" · ")}</p>
      <p>
        <button type="button" className="code-link" onClick={props.onNew}>
          + new file
        </button>
        <span className="muted"> · pick one on the left · :checkhealth shows what is installed</span>
      </p>
    </div>
  );
}
