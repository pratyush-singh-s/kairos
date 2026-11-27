import { Extension, InputRule } from "@tiptap/core";
import type { MarkType } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";

/**
 * Typing x^2 then a space (or . , ; : ! ? )) turns it into x²: the characters after ^ become
 * superscript and the ^ goes away. Works for words too (e^iπ, 10^-3).
 */
export const SUPERSCRIPT_RULE = /(?<=\S)\^([\p{L}\p{N}+\-−=()]+)([\s.,;:!?)])$/u;

/** Typing x_2 then a space makes x₂. Only numbers or one letter, so snake_case words stay as typed. */
export const SUBSCRIPT_RULE = /(?<=\S)_(\p{N}+|\p{L})([\s.,;:!?)])$/u;

function scriptRule(find: RegExp, markName: string) {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const mark: MarkType | undefined = state.schema.marks[markName];
      const [, raised, after] = match;
      if (!mark || !raised || !after) return null;
      const marks = state.doc.resolve(range.from).marks().filter((m) => m.type !== mark);
      state.tr
        .replaceWith(range.from, range.to, Fragment.from([state.schema.text(raised, [...marks, mark.create()]), state.schema.text(after, marks)]))
        .removeStoredMark(mark);
    },
  });
}

export const SuperscriptShortcut = Extension.create({
  name: "scriptShortcuts",

  addInputRules() {
    return [scriptRule(SUPERSCRIPT_RULE, "superscript"), scriptRule(SUBSCRIPT_RULE, "subscript")];
  },
});
