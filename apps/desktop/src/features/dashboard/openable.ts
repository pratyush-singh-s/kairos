import type { KeyboardEvent } from "react";

/** Props that make a non-button block open something on click, Enter or Space. */
export function openable(onOpen: (() => void) | undefined, label: string) {
  if (!onOpen) return {};
  return {
    role: "link",
    tabIndex: 0,
    "aria-label": label,
    "data-openable": true,
    onClick: onOpen,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen();
      }
    },
  } as const;
}
