import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TerminalShell } from "../../ipc/ui";
import { PAGE_COMMANDS, complete, promptFor, runCommand, type CommandResult } from "./shell";
import type { RouteId } from "../routes";

/** The prompt itself ("PS C:\Focus> "), coloured like the real shell's. */
export function PromptText(props: { shell: TerminalShell }) {
  const p = promptFor(props.shell);
  return (
    <span className="term-ps" data-shell={props.shell}>
      {p.lead}
      {p.user && <span className="term-ps-user">{p.user}</span>}
      {p.user && ":"}
      <span className="term-ps-path">{p.path}</span>
      {p.end}
    </span>
  );
}

/** The line at the top of a page: the command that "printed" it. */
export function CommandEcho(props: { shell: TerminalShell; route: RouteId }) {
  return (
    <div className="term-echo" aria-hidden="true">
      <PromptText shell={props.shell} />
      <span className="term-cmd">focus</span> {PAGE_COMMANDS[props.route]}
    </div>
  );
}

interface Entry {
  id: number;
  cmd: string;
  lines: string[];
  error?: boolean;
}

export interface ShellPromptHandle {
  focus: () => void;
}

/**
 * The live prompt under each page, with a block cursor. Typing a page name opens it ("notes",
 * "cd todo"); help lists the rest. What it prints stays until you change page or type clear.
 */
export const ShellPrompt = forwardRef<
  ShellPromptHandle,
  { shell: TerminalShell; route: RouteId; onResult: (r: CommandResult) => void; /** Vim's ":" instead of the shell prompt. */ colon?: boolean }
>(function ShellPrompt(props, ref) {
  const lead = props.colon ? <span className="term-ps term-colon">:</span> : <PromptText shell={props.shell} />;
  const [value, setValue] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [focused, setFocused] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const recall = useRef<{ list: string[]; at: number }>({ list: [], at: 0 });
  const nextId = useRef(1);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  // A new page starts with a clean screen under it.
  useEffect(() => setEntries([]), [props.route]);

  function trackCaret() {
    const el = input.current;
    if (el) setAtEnd(el.selectionStart === el.value.length && el.selectionEnd === el.value.length);
  }

  function submit() {
    const cmd = value;
    setValue("");
    if (cmd.trim()) {
      recall.current.list.push(cmd);
      if (recall.current.list.length > 50) recall.current.list.shift();
    }
    recall.current.at = recall.current.list.length;
    const result = runCommand(cmd, props.shell, new Date(), props.colon);
    if (result.kind === "clear") {
      setEntries([]);
      return;
    }
    const lines = result.kind === "print" ? result.lines : [];
    const error = result.kind === "print" && result.error;
    if (result.kind !== "open") setEntries((e) => [...e.slice(-5), { id: nextId.current++, cmd, lines, error }]);
    props.onResult(result);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const r = recall.current;
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && r.at > 0) {
      e.preventDefault();
      r.at -= 1;
      setValue(r.list[r.at] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      r.at = Math.min(r.list.length, r.at + 1);
      setValue(r.list[r.at] ?? "");
    } else if (e.key === "Tab" && value.trim() && !e.shiftKey) {
      const done = complete(value);
      if (done !== value) {
        e.preventDefault();
        setValue(done);
      }
    } else if (e.key === "Escape") {
      setValue("");
      input.current?.blur();
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setEntries([]);
    }
  }

  return (
    <div className="term-shell" data-colon={props.colon || undefined} onClick={() => input.current?.focus()}>
      {props.colon ? (
        // Vim's command line: one row, showing only the answer to the last command (until you type again).
        entries.length > 0 &&
        !value && (
          <div className="term-entry term-colon-msg">
            {entries[entries.length - 1]!.lines.map((l, i) => (
              <div key={i} className="term-out" data-error={entries[entries.length - 1]!.error || undefined}>
                {l}
              </div>
            ))}
          </div>
        )
      ) : entries.map((en) => (
        <div key={en.id} className="term-entry">
          <div className="term-line">
            {lead}
            {en.cmd}
          </div>
          {en.lines.map((l, i) => (
            <div key={i} className="term-out" data-error={en.error || undefined}>
              {l}
            </div>
          ))}
        </div>
      ))}
      <label className="term-line term-live">
        {lead}
        <input
          ref={input}
          className="term-input"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label="Command (type help)"
          data-at-end={atEnd}
          style={{ width: `calc(${value.length}ch + 1px)` }}
          onChange={(e) => {
            setValue(e.target.value);
            requestAnimationFrame(trackCaret);
          }}
          onSelect={trackCaret}
          onKeyDown={onKeyDown}
          onKeyUp={trackCaret}
          onFocus={() => {
            setFocused(true);
            trackCaret();
          }}
          onBlur={() => setFocused(false)}
        />
        <span className="term-cursor" data-focused={focused} data-hidden={focused && !atEnd} aria-hidden="true" />
      </label>
    </div>
  );
});
