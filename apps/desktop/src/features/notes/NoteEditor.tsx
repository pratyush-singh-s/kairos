import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { Superscript } from "@tiptap/extension-superscript";
import { Subscript } from "@tiptap/extension-subscript";
import { saveExport, saveNote, type Note } from "../../ipc/notes";
import { AttachButton, AttachmentList, useNoteFiles, type NoteFiles } from "./Attachments";
import { listSelection } from "./listSelection";
import { SuperscriptShortcut } from "./superscriptRule";
import type { Paper } from "./pdf";

/** Text sizes offered in the toolbar; "" = normal. */
export const SIZES: [string, string][] = [
  ["13px", "Small"],
  ["", "Normal"],
  ["20px", "Large"],
  ["28px", "Huge"],
];

/** Text colours offered in the toolbar; bright enough to read on both themes' dark backgrounds. */
export const TEXT_COLORS: [string, string][] = [
  ["#ff6b6b", "Red"],
  ["#ffa94d", "Orange"],
  ["#ffd43b", "Yellow"],
  ["#69db7c", "Green"],
  ["#38d9a9", "Teal"],
  ["#74c0fc", "Blue"],
  ["#b197fc", "Purple"],
  ["#f783ac", "Pink"],
];

/** How long after the last keystroke the note is saved. */
const SAVE_DELAY_MS = 600;

export type SaveState = "saved" | "saving" | "unsaved" | { error: string };

function parseBody(body: string) {
  if (!body) return "";
  try {
    return JSON.parse(body) as object;
  } catch {
    return "";
  }
}

/**
 * One note: its title and rich text with a small toolbar (bold, italic, size, bullet and
 * numbered lists, x²). Saves by itself a moment after you stop typing, and when you leave.
 * Opened again (keyed by id) for every note, so nothing carries over between notes.
 */
export function NoteEditor(props: {
  note: Note;
  onSaved: (n: Note) => void;
  onPin: (pinned: boolean) => void;
  onDelete: () => void;
  fullscreen?: boolean;
  onFullscreen?: (on: boolean) => void;
}) {
  const [title, setTitle] = useState(props.note.title);
  const [state, setState] = useState<SaveState>("saved");
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const titleRef = useRef(title);
  titleRef.current = title;
  const onSaved = useRef(props.onSaved);
  onSaved.current = props.onSaved;
  const files = useNoteFiles(props.note.id);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, code: false, codeBlock: false, blockquote: false, horizontalRule: false, link: false }),
      TextStyle,
      FontSize,
      Color,
      // A letter is either raised or lowered, never both.
      Superscript.extend({ excludes: "subscript" }),
      Subscript.extend({ excludes: "superscript" }),
      SuperscriptShortcut,
    ],
    content: parseBody(props.note.body),
    onUpdate: () => schedule(),
  });

  const id = props.note.id;
  const editorRef = useRef<Editor | null>(editor);
  editorRef.current = editor;

  async function flush() {
    window.clearTimeout(timer.current);
    const ed = editorRef.current;
    if (!dirty.current || !ed) return;
    dirty.current = false;
    setState("saving");
    try {
      const empty = ed.isEmpty;
      const saved = await saveNote(id, titleRef.current, empty ? "" : JSON.stringify(ed.getJSON()), empty ? "" : ed.getText({ blockSeparator: "\n" }));
      setState(dirty.current ? "unsaved" : "saved");
      onSaved.current(saved);
    } catch (err) {
      dirty.current = true;
      setState({ error: String(err) });
    }
  }

  function schedule() {
    dirty.current = true;
    setState("unsaved");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  // Leaving the note (or the page) saves what is not saved yet.
  useEffect(() => () => void flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <article className="note-editor card" aria-label={title || "Untitled note"}>
      <NoteHead
        note={props.note}
        title={title}
        state={state}
        files={files}
        onTitle={(t) => {
          setTitle(t);
          schedule();
        }}
        onEnter={() => {
          // Focus right away (the editor's own focus waits a frame and the next key would land in the title).
          editor?.commands.setTextSelection(1);
          editor?.view.focus();
        }}
        onPin={props.onPin}
        onDelete={props.onDelete}
        body={() => (editor && !editor.isEmpty ? JSON.stringify(editor.getJSON()) : "")}
        fullscreen={props.fullscreen}
        onFullscreen={props.onFullscreen}
      />
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="note-body" />
      <AttachmentList files={files} />
    </article>
  );
}

/** A note's title, whether it is saved, and its attach, pin and delete buttons (text and handwritten notes). */
export function NoteHead(props: {
  note: Note;
  title: string;
  state: SaveState;
  files: NoteFiles;
  onTitle: (title: string) => void;
  /** Enter in the title: go on to the note itself. */
  onEnter: () => void;
  onPin: (pinned: boolean) => void;
  onDelete: () => void;
  /** The note as it is now (saved or not), for Export as PDF. */
  body: () => string;
  fullscreen?: boolean;
  onFullscreen?: (on: boolean) => void;
}) {
  const { state } = props;
  const status = typeof state === "object" ? `Not saved: ${state.error}` : state === "saved" ? "Saved" : "Saving…";
  return (
    <header className="note-head">
      <input
        className="note-title"
        value={props.title}
        maxLength={200}
        placeholder="Untitled"
        aria-label="Title"
        autoFocus={!props.note.title && !props.note.body}
        onChange={(e) => props.onTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            props.onEnter();
          }
        }}
      />
      <span className={typeof state === "object" ? "error small" : "muted small"} role="status" aria-live="polite">
        {status}
      </span>
      <AttachButton files={props.files} />
      <ExportButton note={props.note} title={props.title} body={props.body} />
      {props.onFullscreen && (
        <button
          type="button"
          className="icon-button"
          aria-pressed={props.fullscreen}
          onClick={() => props.onFullscreen?.(!props.fullscreen)}
          title={props.fullscreen ? "Leave full screen (Esc)" : "Full screen: only the note"}
          aria-label={props.fullscreen ? "Leave full screen" : "Full screen"}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d={props.fullscreen ? "M8 3v5H3 M12 3v5h5 M8 17v-5H3 M12 17v-5h5" : "M3 8V3h5 M17 8V3h-5 M3 12v5h5 M17 12v5h-5"} />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        aria-pressed={props.note.pinned}
        onClick={() => props.onPin(!props.note.pinned)}
        title={props.note.pinned ? "Unpin" : "Pin to the top and the dashboard"}
        aria-label={props.note.pinned ? "Unpin" : "Pin"}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M7 3h6l-1 5 3 3H5l3-3z M10 11v6" fill={props.note.pinned ? "currentColor" : "none"} />
        </svg>
      </button>
      <button type="button" className="icon-button" onClick={props.onDelete} aria-label="Delete note" title="Delete">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15" />
        </svg>
      </button>
    </header>
  );
}

/** "Export as PDF": white paper (to print or share) or a dark page like the app's. */
function ExportButton(props: { note: Note; title: string; body: () => string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open && !message) return;
    const away = (ev: MouseEvent) => {
      if (!box.current?.contains(ev.target as Node)) {
        setOpen(false);
        setMessage(null);
      }
    };
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && (setOpen(false), setMessage(null));
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, message]);

  async function run(paper: Paper) {
    setOpen(false);
    setBusy(true);
    setMessage(null);
    try {
      // Made only when asked, so the PDF code and fonts load the first time you export.
      const { noteToPdf, pdfName } = await import("./pdf");
      const bytes = await noteToPdf({ title: props.title.trim(), kind: props.note.kind }, props.body(), paper);
      const where = await saveExport(pdfName(props.title), bytes);
      if (where) setMessage({ text: `Saved to ${where}`, error: false });
    } catch (err) {
      setMessage({ text: `Could not export: ${String(err)}`, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="note-export" ref={box}>
      <button
        type="button"
        className="icon-button"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          setMessage(null);
          setOpen((o) => !o);
        }}
        title={busy ? "Making the PDF…" : "Export as PDF"}
        aria-label="Export as PDF"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 2.5h7l3.5 3.5v11.5H5z M12 2.5V6h3.5 M10 8.5v6 M7.5 12l2.5 2.5 2.5-2.5" />
        </svg>
      </button>
      {open && (
        <div className="note-export-pop" role="menu" aria-label="Export as PDF">
          <span className="muted small">Export as PDF</span>
          <button type="button" role="menuitem" className="note-export-item" onClick={() => void run("light")}>
            <span className="note-export-paper" data-paper="light" />
            White paper <span className="muted small">to print or share</span>
          </button>
          <button type="button" role="menuitem" className="note-export-item" onClick={() => void run("dark")}>
            <span className="note-export-paper" data-paper="dark" />
            Dark page <span className="muted small">as on screen</span>
          </button>
        </div>
      )}
      {message && (
        <p className={`note-export-pop note-export-msg small ${message.error ? "error" : ""}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}

/** Bold, italic, size, colour, list, superscript, subscript; each button shows whether it is on where the cursor is. */
function Toolbar(props: { editor: Editor }) {
  const e = props.editor;
  const on = useEditorState({
    editor: e,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      bullets: editor.isActive("bulletList"),
      numbers: editor.isActive("orderedList"),
      sup: editor.isActive("superscript"),
      sub: editor.isActive("subscript"),
      size: (editor.getAttributes("textStyle").fontSize as string | undefined) ?? "",
      color: (editor.getAttributes("textStyle").color as string | undefined) ?? "",
    }),
  });
  const run = (f: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => f(e.chain().focus()).run();
  const button = (label: ReactNode, title: string, active: boolean, action: () => void, className = "") => (
    <button
      type="button"
      className={`note-tool ${className}`}
      aria-pressed={active}
      title={title}
      // Keep the text selection while clicking the toolbar.
      onMouseDown={(ev) => ev.preventDefault()}
      onClick={action}
    >
      {label}
    </button>
  );
  return (
    <div className="note-toolbar" role="toolbar" aria-label="Formatting">
      {button("B", "Bold (Ctrl+B)", on.bold, () => run((c) => c.toggleBold()), "tool-bold")}
      {button("I", "Italic (Ctrl+I)", on.italic, () => run((c) => c.toggleItalic()), "tool-italic")}
      <label className="note-size">
        <span className="sr-only">Text size</span>
        <select
          value={SIZES.some(([v]) => v === on.size) ? on.size : ""}
          onChange={(ev) => {
            const size = ev.target.value;
            run((c) => (size ? c.setFontSize(size) : c.unsetFontSize()));
          }}
          title="Text size"
        >
          {SIZES.map(([value, label]) => (
            <option key={label} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <TextColor editor={e} color={on.color} />
      <span className="note-tool-gap" />
      {/* One List button: it shows the list it will make. In a bullet list it offers numbers, and back. */}
      {on.bullets
        ? button(<ListIcon numbered />, "Change to a numbered list", true, () => listSelection(e, "orderedList"), "tool-list")
        : button(<ListIcon />, on.numbers ? "Change to a bullet list" : "Make a list from the highlighted lines (or type - then a space)", on.numbers, () => listSelection(e, "bulletList"), "tool-list")}
      <span className="note-tool-gap" />
      {button(
        <>
          x<sup>2</sup>
        </>,
        "Superscript (Ctrl+.), or type x^2 then a space",
        on.sup,
        () => run((c) => c.toggleSuperscript()),
        "tool-sup",
      )}
      {button(
        <>
          x<sub>2</sub>
        </>,
        "Subscript (Ctrl+,), or type x_2 then a space",
        on.sub,
        () => run((c) => c.toggleSubscript()),
        "tool-sup",
      )}
    </div>
  );
}

/** The "A" button: shows the colour where the cursor is, and opens swatches to colour the highlighted text. */
function TextColor(props: { editor: Editor; color: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const custom = useRef<HTMLInputElement>(null);
  const run = (f: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => f(props.editor.chain().focus()).run();
  const pick = (color: string | null) => {
    run((c) => (color ? c.setColor(color) : c.unsetColor()));
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const away = (ev: MouseEvent) => {
      if (!box.current?.contains(ev.target as Node)) setOpen(false);
    };
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const name = TEXT_COLORS.find(([v]) => v === props.color.toLowerCase())?.[1] ?? (props.color ? props.color : "Default");
  return (
    <div className="note-color" ref={box}>
      <button
        type="button"
        className="note-tool tool-color"
        aria-haspopup="true"
        aria-expanded={open}
        title={`Text colour (${name})`}
        aria-label={`Text colour: ${name}`}
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tool-color-letter">A</span>
        <span className="tool-color-bar" style={{ background: props.color || "currentColor" }} />
      </button>
      {open && (
        <div className="note-color-pop" role="group" aria-label="Text colour">
          <button type="button" className="note-swatch note-swatch-default" title="Default" aria-label="Default colour" aria-pressed={!props.color} onMouseDown={(ev) => ev.preventDefault()} onClick={() => pick(null)}>
            A
          </button>
          {TEXT_COLORS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="note-swatch"
              title={label}
              aria-label={label}
              aria-pressed={props.color.toLowerCase() === value}
              style={{ background: value }}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => pick(value)}
            />
          ))}
          <button
            type="button"
            className="note-swatch note-swatch-custom"
            title="Pick any colour"
            aria-label="Pick any colour"
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => custom.current?.click()}
          >
            <svg className="swatch-plus" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5v7M1.5 5h7" /></svg>
          </button>
          <input
            ref={custom}
            type="color"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            defaultValue={props.color || "#74c0fc"}
            onChange={(ev) => pick(ev.target.value)}
          />
        </div>
      )}
    </div>
  );
}

/** "⋮ List" (bullets) or "1 2 3 List" (numbers), the marks stacked like the list itself. Drawn so it stays sharp at any size. */
function ListIcon(props: { numbered?: boolean }) {
  const rows = [4.5, 13, 21.5];
  return (
    <span className="list-icon">
      <svg className="list-icon-marks" viewBox="0 0 12 26" aria-hidden="true">
        {rows.map((y, i) =>
          props.numbered ? (
            <text key={y} x="6" y={y + 3.2} textAnchor="middle">
              {i + 1}
            </text>
          ) : (
            <circle key={y} cx="6" cy={y} r="2" />
          ),
        )}
      </svg>
      List
    </span>
  );
}
