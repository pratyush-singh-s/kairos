import { Vim } from "@replit/codemirror-vim";

/** What a Vim key or : command asks the Code page to do. The editor itself handles the rest. */
export type VimCommand =
  | { kind: "save"; name?: string }
  | { kind: "save-all" }
  | { kind: "run" }
  | { kind: "quit"; force: boolean; save: boolean }
  | { kind: "edit"; name: string; force: boolean }
  | { kind: "new" }
  | { kind: "buffer"; step: 1 | -1 }
  | { kind: "list" }
  | { kind: "window"; to: "tree" | "term" | "editor" | "toggle-tree" }
  | { kind: "help" }
  | { kind: "health" }
  | { kind: "stop" }
  | { kind: "colorscheme"; name: string }
  | { kind: "relative-numbers"; on: boolean };

interface ExParams {
  argString?: string;
}

let handler: ((c: VimCommand) => void) | null = null;
let relative = false;

/** The Code page that is open receives the commands (there is only ever one). */
export function setVimHandler(h: ((c: VimCommand) => void) | null) {
  handler = h;
}

export function setRelativeNumbers(on: boolean) {
  relative = on;
}

function send(c: VimCommand) {
  handler?.(c);
}

/** `:q!` arrives as command "q" with argString "!"; `:e foo.py` as "e" with " foo.py". */
function parse(p: ExParams): { bang: boolean; arg: string } {
  const raw = p.argString ?? "";
  const bang = raw.startsWith("!");
  return { bang, arg: (bang ? raw.slice(1) : raw).trim() };
}

let ready = false;

/**
 * Neovim habits on top of @replit/codemirror-vim (which already has the motions, operators, text
 * objects, registers, macros, marks, / search, :s and gc comments): Space as the leader key, jk to
 * leave insert mode, Ctrl+h/j/k/l and Ctrl+w to move between the file tree, the code and the
 * terminal, buffers as files, and the : commands a Neovim user types without thinking.
 */
export function setUpVim() {
  if (ready) return;
  ready = true;

  // Files and buffers.
  Vim.defineEx("write", "w", (_cm: unknown, p: ExParams) => {
    const { arg } = parse(p);
    send(arg ? { kind: "save", name: arg } : { kind: "save" });
  });
  Vim.defineEx("saveas", "sav", (_cm: unknown, p: ExParams) => {
    const { arg } = parse(p);
    if (arg) send({ kind: "save", name: arg });
  });
  Vim.defineEx("wall", "wa", () => send({ kind: "save-all" }));
  Vim.defineEx("wq", "wq", (_cm: unknown, p: ExParams) => send({ kind: "quit", force: parse(p).bang, save: true }));
  Vim.defineEx("wqall", "wqa", () => send({ kind: "quit", force: false, save: true }));
  Vim.defineEx("xit", "x", () => send({ kind: "quit", force: false, save: true }));
  Vim.defineEx("xall", "xa", () => send({ kind: "quit", force: false, save: true }));
  Vim.defineEx("quit", "q", (_cm: unknown, p: ExParams) => send({ kind: "quit", force: parse(p).bang, save: false }));
  Vim.defineEx("qall", "qa", (_cm: unknown, p: ExParams) => send({ kind: "quit", force: parse(p).bang, save: false }));
  Vim.defineEx("bdelete", "bd", (_cm: unknown, p: ExParams) => send({ kind: "quit", force: parse(p).bang, save: false }));
  Vim.defineEx("edit", "e", (_cm: unknown, p: ExParams) => {
    const { bang, arg } = parse(p);
    send({ kind: "edit", name: arg, force: bang });
  });
  Vim.defineEx("enew", "ene", () => send({ kind: "new" }));
  Vim.defineEx("bnext", "bn", () => send({ kind: "buffer", step: 1 }));
  Vim.defineEx("bprevious", "bp", () => send({ kind: "buffer", step: -1 }));
  Vim.defineEx("ls", "ls", () => send({ kind: "list" }));
  Vim.defineEx("buffers", "buffers", () => send({ kind: "list" }));

  // Windows: the file tree (like nvim-tree / netrw) and the terminal split.
  Vim.defineEx("Explore", "Ex", () => send({ kind: "window", to: "tree" }));
  Vim.defineEx("Lexplore", "Lex", () => send({ kind: "window", to: "toggle-tree" }));
  Vim.defineEx("NvimTreeToggle", "NvimTreeToggle", () => send({ kind: "window", to: "toggle-tree" }));
  Vim.defineEx("NvimTreeFocus", "NvimTreeFocus", () => send({ kind: "window", to: "tree" }));
  Vim.defineEx("terminal", "term", () => send({ kind: "window", to: "term" }));

  // Running and help.
  Vim.defineEx("run", "run", () => send({ kind: "run" }));
  Vim.defineEx("make", "mak", () => send({ kind: "run" }));
  Vim.defineEx("help", "h", () => send({ kind: "help" }));
  Vim.defineEx("checkhealth", "checkh", () => send({ kind: "health" }));
  Vim.defineEx("stop", "sto", () => send({ kind: "stop" }));
  Vim.defineEx("colorscheme", "colo", (_cm: unknown, p: ExParams) => send({ kind: "colorscheme", name: parse(p).arg }));

  // :set rnu / :set nornu / :set rnu! / :set rnu?
  (Vim.defineOption as (name: string, def: unknown, type: string, aliases: string[], cb: (v?: boolean, cm?: unknown) => boolean | void) => void)(
    "relativenumber",
    undefined,
    "boolean",
    ["rnu"],
    (value, cm) => {
      if (value === undefined) return relative;
      // The callback runs once for the global value and once for the editor; act once.
      if (cm === undefined) return;
      relative = value;
      send({ kind: "relative-numbers", on: value });
    },
  );

  const action = (name: string, keys: string, c: VimCommand) => {
    Vim.defineAction(name, () => send(c));
    Vim.mapCommand(keys, "action", name, {}, { context: "normal" });
  };

  // Space is the leader (by default it only moves right, like l).
  Vim.unmap("<Space>", undefined as unknown as string);
  action("focusSave", "<Space>w", { kind: "save" });
  action("focusQuit", "<Space>q", { kind: "quit", force: false, save: true });
  action("focusRun", "<Space>r", { kind: "run" });
  action("focusTree", "<Space>e", { kind: "window", to: "toggle-tree" });
  action("focusTerm", "<Space>t", { kind: "window", to: "term" });
  action("focusNew", "<Space>n", { kind: "new" });
  action("focusHelp", "<Space>?", { kind: "help" });
  action("focusList", "<Space>b", { kind: "list" });
  action("focusNext", "]b", { kind: "buffer", step: 1 });
  action("focusPrev", "[b", { kind: "buffer", step: -1 });
  // Space y / Space p use the Windows clipboard, like "+y and "+p.
  for (const ctx of ["normal", "visual"]) {
    Vim.map("<Space>y", '"+y', ctx);
    Vim.map("<Space>p", '"+p', ctx);
    Vim.map("<Space>P", '"+P', ctx);
  }

  // Moving between windows: Ctrl+h tree, Ctrl+j terminal, Ctrl+w then h/j/k/l/w.
  Vim.unmap("<C-w>", "normal");
  action("focusWinTree", "<C-h>", { kind: "window", to: "tree" });
  action("focusWinTerm", "<C-j>", { kind: "window", to: "term" });
  action("focusWinTreeW", "<C-w>h", { kind: "window", to: "tree" });
  action("focusWinTermW", "<C-w>j", { kind: "window", to: "term" });
  action("focusWinNextW", "<C-w>w", { kind: "window", to: "tree" });
  action("focusWinNextCW", "<C-w><C-w>", { kind: "window", to: "tree" });
  action("focusWinCloseW", "<C-w>q", { kind: "quit", force: false, save: true });
  // Ctrl+w k / l have nothing above or to the right of the code; stay put.
  action("focusWinUpW", "<C-w>k", { kind: "window", to: "editor" });
  action("focusWinRightW", "<C-w>l", { kind: "window", to: "editor" });

  // ZZ saves and closes, ZQ closes without saving.
  Vim.map("ZZ", ":x<CR>", "normal");
  Vim.map("ZQ", ":q!<CR>", "normal");

  // jk leaves insert mode, as in most Neovim setups (type j and k quickly).
  Vim.map("jk", "<Esc>", "insert");
}

/** The cheat sheet behind the ⌨ ? button, :help and Space ?. */
export const VIM_HELP = `Kairos Code: Vim keys (Neovim style)

MODES        i a o I A O  insert   ·  Esc / jk / Ctrl+[  normal  ·  v V Ctrl+v  visual  ·  R replace
MOVE         h j k l  ·  w b e W B E  words  ·  0 ^ $  line  ·  gg G 42G  file  ·  { }  paragraphs
             f F t T x  ; ,  ·  %  matching bracket  ·  Ctrl+d Ctrl+u  half page  ·  zz zt zb  scroll
EDIT         x  dd  D  cc  C  s S  r  J  ·  dw ciw di( ca"  (operator + motion or text object)
             yy yw  p P  ·  u undo  Ctrl+r redo  ·  .  repeat  ·  >> <<  indent  ·  ~  case
             gcc  comment line  ·  gc + motion  comment block  ·  Ctrl+a Ctrl+x  number +1 / -1
SEARCH       /text  ?text  n N  ·  * #  word under cursor  ·  :noh  clear highlight
             :%s/old/new/g  replace  ·  :g/text/d  delete matching lines  ·  :sort
REGISTERS    "ay  "ap  ·  "+y "+p  Windows clipboard  ·  qa … q  record macro  ·  @a  @@  play
MARKS        ma  'a  \`a  ·  Ctrl+o Ctrl+i  jump back / forward

LEADER       Space w  save         Space q  save + close     Space r  run
(Space)      Space e  file tree    Space t  terminal         Space n  new file
             Space b  list files   Space y / p  clipboard    Space ?  this help
             ]b  [b   next / previous file

WINDOWS      Ctrl+h  file tree  ·  Ctrl+j  terminal  ·  Ctrl+l or Ctrl+k  back to the code
             Ctrl+w h/j/k/l/w  the same, Vim style
FILE TREE    j k  move  ·  l o Enter  open  ·  a  new  ·  r  rename  ·  d  delete  ·  R  refresh
             q Esc Ctrl+l  back to the code
TERMINAL     Enter  send a line  ·  Ctrl+C  stop  ·  Ctrl+D  end input  ·  Esc Ctrl+k  back to the code

COMMANDS     :w  save   ·  :w name.py  save as   ·  :wq :x ZZ  save + close
             :q  close   ·  :q! ZQ  close, drop changes   ·  :e!  reload from disk
             :e name.py  open or make   ·  :enew  new file   ·  :bn :bp  next / previous   ·  :ls  list files
             :Ex :Lex :NvimTreeToggle  file tree   ·  :term  terminal   ·  :set rnu / nornu  relative numbers
             :run :make  run (also F5, Ctrl+Enter)   ·  :stop or Shift+F5  stop   ·  :checkhealth  compilers found
             :colo  list colour schemes   ·  :colo tokyo-night  switch (also under the file tree)

Ctrl+S saves and F5 runs in every mode. The "vim keys" switch under the file tree turns all of this off.
`;
