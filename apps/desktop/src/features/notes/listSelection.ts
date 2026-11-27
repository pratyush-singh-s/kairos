import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

export type ListKind = "bulletList" | "orderedList";

/**
 * Makes a list from exactly the highlighted lines. The paragraph is split where the highlight
 * starts and ends, and every line break (Shift+Enter) inside it becomes its own item, so
 * highlighting three lines in the middle of a block gives a three-item list and leaves the
 * text around it as it was. With nothing highlighted, or inside a list already, it simply
 * switches the list kind (or turns it on for the current line).
 */
export function listSelection(editor: Editor, kind: ListKind) {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  const inList = editor.isActive("bulletList") || editor.isActive("orderedList");
  const toggle = () => (kind === "bulletList" ? editor.chain().focus().toggleBulletList().run() : editor.chain().focus().toggleOrderedList().run());
  if (empty || inList) {
    // Inside a list the button switches between bullets and numbers rather than removing it.
    if (inList && !editor.isActive(kind)) {
      return kind === "bulletList" ? editor.chain().focus().toggleBulletList().run() : editor.chain().focus().toggleOrderedList().run();
    }
    return toggle();
  }

  const tr = state.tr;
  const isBreak = (n: { type: { name: string } } | null | undefined) => n?.type.name === "hardBreak";
  // Split at the end first so the start position stays valid. A line break right at the edge
  // of the highlight goes away, as the split takes its place.
  let $to = tr.doc.resolve(to);
  if (isBreak($to.nodeAfter)) {
    tr.delete(to, to + 1);
    $to = tr.doc.resolve(to);
  }
  if ($to.parent.isTextblock && $to.parentOffset < $to.parent.content.size) tr.split(to);
  let start = from;
  let $from = tr.doc.resolve(from);
  if (isBreak($from.nodeBefore)) {
    tr.delete(from - 1, from);
    start = from - 1;
    $from = tr.doc.resolve(start);
  }
  if ($from.parent.isTextblock && $from.parentOffset > 0) {
    tr.split(start);
    start += 2;
  }
  let end = tr.mapping.map(to, -1);
  // Each Shift+Enter line break inside the highlight becomes its own list item.
  const breaks: number[] = [];
  tr.doc.nodesBetween(start, end, (node, pos) => {
    if (node.type.name === "hardBreak") breaks.push(pos);
  });
  for (const pos of breaks.reverse()) {
    tr.delete(pos, pos + 1);
    tr.split(pos);
  }
  end = end + breaks.length; // each break (1) became a split (2)
  tr.setSelection(TextSelection.create(tr.doc, start, Math.min(end, tr.doc.content.size)));
  editor.view.dispatch(tr);
  return toggle();
}
