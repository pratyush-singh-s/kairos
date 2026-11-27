import { generateHTML } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { Superscript } from "@tiptap/extension-superscript";
import { Subscript } from "@tiptap/extension-subscript";

/** The note editor's schema (features/notes/NoteEditor.tsx), for showing a note read-only. */
const EXTENSIONS = [
  StarterKit.configure({ heading: false, code: false, codeBlock: false, blockquote: false, horizontalRule: false, link: false }),
  TextStyle,
  FontSize,
  Color,
  Superscript,
  Subscript,
];

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A saved note body as HTML. The HTML is written by the editor's schema, so it only holds the
 * nodes and marks notes can have; a body it cannot read falls back to the plain text.
 */
export function noteHtml(body: string, plainText: string): string {
  if (body) {
    try {
      return generateHTML(JSON.parse(body) as object, EXTENSIONS);
    } catch {
      // Fall through to the plain text.
    }
  }
  return plainText
    .split("\n")
    .map((line) => `<p>${escape(line)}</p>`)
    .join("");
}
