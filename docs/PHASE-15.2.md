# Focus 0.12.1: drag cards and add a description

## What changed
- **Dragging works on Windows.** Cards on the To-do board now move with the mouse: press on a card, drag it to another day (or to "No date") and let go. Esc while dragging cancels. Repeating tasks stay put (they belong to their weekdays).
- **Click anywhere on a card to open it.** The editor opens with the cursor in a new **Description** box. Write as many lines as you like; Ctrl+Enter or Save stores it.
- Cards show the first three lines of the description under the name.

## Why dragging did nothing before
Windows' webview passed every drag to the app's file-drop handler, so the browser-style drag never started. The board now uses its own pointer-based drag, and the file-drop handler is switched off (Focus does not take dropped files).

## Under the hood
- Migration 0006 adds `tasks.description` (text, default empty, max 5000 characters).
- `useCardDrag.ts` replaces HTML drag and drop on the board.

## Install
Unzip `Focus-0.12.1-installer.zip` and run the setup. It upgrades in place; your tasks are kept.
