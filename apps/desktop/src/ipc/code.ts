import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `CodeFile` in src-tauri/src/code.rs. */
export interface CodeFile {
  name: string;
  size: number;
  modifiedMs: number;
}

export interface Toolchain {
  language: string;
  found: string | null;
  get: string;
}

export interface CodeOutput {
  runId: number;
  stream: "out" | "err" | "info";
  text: string;
}

export interface CodeExit {
  runId: number;
  code: number | null;
  ms: number;
}

export const codeFolder = () => invoke<string>("code_folder");
export const listCode = () => invoke<CodeFile[]>("code_list");
export const readCode = (name: string) => invoke<string>("code_read", { name });
export const saveCode = (name: string, text: string) => invoke<void>("code_save", { name, text });
export const deleteCode = (name: string) => invoke<void>("code_delete", { name });
export const renameCode = (from: string, to: string) => invoke<void>("code_rename", { from, to });
export const codeToolchains = () => invoke<Toolchain[]>("code_toolchains");
export const runCode = (name: string) => invoke<number>("code_run", { name });
export const sendStdin = (runId: number, text: string) => invoke<void>("code_stdin", { runId, text });
export const closeStdin = (runId: number) => invoke<void>("code_close_stdin", { runId });
/** false = Focus knows of no such run (it already ended). */
export const stopCode = (runId: number) => invoke<boolean>("code_stop", { runId });

export function onCodeOutput(handler: (o: CodeOutput) => void): Promise<UnlistenFn> {
  return listen<CodeOutput>("code-output", (e) => handler(e.payload));
}

export function onCodeExit(handler: (o: CodeExit) => void): Promise<UnlistenFn> {
  return listen<CodeExit>("code-exit", (e) => handler(e.payload));
}
