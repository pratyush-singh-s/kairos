import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  crosshairCursor,
  gutter,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { HighlightStyle, bracketMatching, foldGutter, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import { languageOf } from "./languages";
import { setRelativeNumbers, setUpVim, setVimHandler, type VimCommand } from "./vimKeys";

class LineNumber extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  eq(other: LineNumber) {
    return other.text === this.text;
  }
  toDOM() {
    return document.createTextNode(this.text);
  }
}

/** :set rnu: distances from the cursor line, which keeps its own number (like Neovim with nu + rnu). */
const relativeLineNumbers = gutter({
  class: "cm-lineNumbers",
  lineMarker(view, line) {
    const doc = view.state.doc;
    const here = doc.lineAt(view.state.selection.main.head).number;
    const n = doc.lineAt(line.from).number;
    return new LineNumber(String(n === here ? n : Math.abs(n - here)));
  },
  lineMarkerChange: (u) => u.selectionSet || u.docChanged,
  initialSpacer: (view) => new LineNumber(String(view.state.doc.lines)),
});

/** Colours from the Terminal palette, so every palette (and Custom) works in the editor too. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--accent)" },
  { tag: [t.string, t.special(t.string), t.character], color: "var(--ok)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--text-muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--focus-ring)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--pending)" },
  { tag: [t.processingInstruction, t.meta, t.annotation], color: "var(--failed)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "color-mix(in srgb, var(--text) 75%, var(--text-muted))" },
  { tag: t.invalid, color: "var(--failed)", textDecoration: "underline wavy" },
]);

const look = EditorView.theme(
  {
    "&": { height: "100%", color: "var(--text)", backgroundColor: "transparent", fontSize: "14px" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
    ".cm-content": { caretColor: "var(--text)", padding: "4px 0" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--text-muted)", border: "none", paddingRight: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--number)", fontWeight: "600" },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text) 6%, transparent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--text)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent) !important",
    },
    ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--number) 30%, transparent)", outline: "none" },
    ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--focus-ring) 20%, transparent)" },
    ".cm-tooltip": { backgroundColor: "var(--bg)", border: "1px solid var(--accent)", color: "var(--text)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--on-status)" },
    ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--text)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "none" },
    ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "var(--text-muted)" },
    // Vim: a block cursor in normal mode, and the : command line.
    ".cm-fat-cursor": { background: "var(--text) !important", color: "var(--bg) !important" },
    "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid var(--text)" },
    ".cm-vim-panel": { fontFamily: "var(--font-mono)", padding: "2px 6px" },
    ".cm-vim-panel input": { color: "var(--text)", fontFamily: "var(--font-mono)" },
  },
  { dark: true },
);

export type EditorMode = "NORMAL" | "INSERT" | "VISUAL" | "V-LINE" | "V-BLOCK" | "REPLACE" | "COMMAND";

export interface EditorHandle {
  focus: () => void;
}

interface Props {
  name: string;
  text: string;
  vimKeys: boolean;
  relativeNumbers: boolean;
  onChange: (text: string) => void;
  onCursor: (line: number, col: number, lines: number) => void;
  onMode: (mode: EditorMode) => void;
  onSave: () => void;
  onRun: () => void;
  onVim: (c: VimCommand) => void;
}

/** CodeMirror set up like Neovim: line numbers, active line, brackets, completion, optional Vim keys. */
export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const keys = useRef(new Compartment());
  const numbers = useRef(new Compartment());
  const vimMode = useRef<EditorMode>("NORMAL");
  const cb = useRef(props);
  cb.current = props;

  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), []);

  // Neovim's leader keys and : commands (see vimKeys.ts) talk to the Code page.
  setUpVim();
  setRelativeNumbers(props.relativeNumbers);
  useEffect(() => {
    setVimHandler((c) => cb.current.onVim(c));
    return () => setVimHandler(null);
  }, []);

  // One editor per open file: a new file gets a fresh history (undo doesn't cross files).
  useEffect(() => {
    if (!host.current) return;
    const language = languageOf(props.name);
    const state = EditorState.create({
      doc: props.text,
      extensions: [
        keys.current.of(props.vimKeys ? vim({ status: true }) : []),
        numbers.current.of(props.relativeNumbers ? relativeLineNumbers : lineNumbers()),
        foldGutter({ openText: "▾", closedText: "▸" }),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of("    "),
        syntaxHighlighting(highlight),
        bracketMatching(),
        // Thin lines down each indent level, from { to }, like VS Code; the block the cursor is in is brighter.
        indentationMarkers({
          highlightActiveBlock: true,
          markerType: "codeOnly",
          thickness: 1,
          colors: {
            dark: "color-mix(in srgb, var(--text-muted) 28%, transparent)",
            activeDark: "color-mix(in srgb, var(--text-muted) 75%, transparent)",
            light: "color-mix(in srgb, var(--text-muted) 28%, transparent)",
            activeLight: "color-mix(in srgb, var(--text-muted) 75%, transparent)",
          },
        }),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
          { key: "Mod-Enter", preventDefault: true, run: () => (cb.current.onRun(), true) },
          { key: "F5", preventDefault: true, run: () => (cb.current.onRun(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        lang.current.of(language ? language.support() : []),
        look,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            cb.current.onCursor(line.number, head - line.from + 1, u.state.doc.lines);
          }
          if (u.focusChanged && !cb.current.vimKeys) cb.current.onMode(u.view.hasFocus ? "INSERT" : "NORMAL");
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    cb.current.onCursor(1, 1, state.doc.lines);
    return () => {
      v.destroy();
      view.current = null;
    };
    // The text prop is only the starting text; edits stay in the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.name]);

  useEffect(() => {
    view.current?.dispatch({ effects: numbers.current.reconfigure(props.relativeNumbers ? relativeLineNumbers : lineNumbers()) });
  }, [props.relativeNumbers]);

  // The : and / line is a separate field: COMMAND while it has the keyboard.
  useEffect(() => {
    const el = host.current;
    if (!el || !props.vimKeys) return;
    const inPanel = (t: EventTarget | null) => t instanceof Element && !!t.closest(".cm-vim-panel");
    const onIn = (e: FocusEvent) => inPanel(e.target) && cb.current.onMode("COMMAND");
    const onOut = (e: FocusEvent) => inPanel(e.target) && cb.current.onMode(vimMode.current);
    el.addEventListener("focusin", onIn);
    el.addEventListener("focusout", onOut);
    return () => {
      el.removeEventListener("focusin", onIn);
      el.removeEventListener("focusout", onOut);
    };
  }, [props.vimKeys]);

  // Vim keys on or off without losing the text.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: keys.current.reconfigure(props.vimKeys ? vim({ status: true }) : []) });
    vimMode.current = "NORMAL";
    cb.current.onMode("NORMAL");
    if (!props.vimKeys) return;
    const cm = getCM(v);
    const onMode = (e: { mode: string; subMode?: string }) => {
      const m: EditorMode =
        e.mode === "insert"
          ? "INSERT"
          : e.mode === "visual"
            ? e.subMode === "linewise"
              ? "V-LINE"
              : e.subMode === "blockwise"
                ? "V-BLOCK"
                : "VISUAL"
            : e.mode === "replace"
              ? "REPLACE"
              : "NORMAL";
      vimMode.current = m;
      cb.current.onMode(m);
    };
    cm?.on("vim-mode-change", onMode);
    return () => cm?.off("vim-mode-change", onMode);
  }, [props.vimKeys, props.name]);

  return <div ref={host} className="code-editor" />;
});
