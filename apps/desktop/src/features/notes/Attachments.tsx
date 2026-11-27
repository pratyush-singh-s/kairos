import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { formatBytes } from "@focus/core";
import { useHistoryChanged } from "../../ipc/history";
import {
  attachFiles,
  listNoteAttachments,
  openAttachment,
  removeAttachment,
  restoreAttachment,
  saveAttachment,
  type NoteAttachment,
} from "../../ipc/notes";
import type { SyncProgress } from "../../ipc/sync";
import { UndoToast, useUndo, type Undo } from "../tasks/UndoToast";

export interface NoteFiles {
  list: NoteAttachment[];
  busy: boolean;
  /** The last thing worth saying: an error or where a copy was saved. */
  message: { text: string; error: boolean } | null;
  /** How far the files coming from the other device are, while a sync brings them (0-100). */
  incoming: number | null;
  attach: () => void;
  open: (a: NoteAttachment) => void;
  save: (a: NoteAttachment) => void;
  remove: (a: NoteAttachment) => void;
  undo: Undo;
}

/** A note's attached files and what can be done with them. */
export function useNoteFiles(noteId: string): NoteFiles {
  const [list, setList] = useState<NoteAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<NoteFiles["message"]>(null);
  const [incoming, setIncoming] = useState<number | null>(null);
  const undo = useUndo();

  const reload = useCallback(() => {
    listNoteAttachments(noteId)
      .then(setList)
      .catch(() => {});
  }, [noteId]);
  useEffect(reload, [reload]);
  useHistoryChanged(reload, "notes-changed");

  useEffect(() => {
    const off = listen<SyncProgress | null>("sync-progress", (e) => {
      const p = e.payload;
      if (p?.stage === "receiving-files" && p.bytesTotal > 0) setIncoming(Math.round((100 * p.bytesDone) / p.bytesTotal));
      else setIncoming(null);
    });
    // A sync that ends sends no more progress: clear the bar on the next status change.
    const end = listen("sync-changed", () => setIncoming(null));
    return () => {
      void off.then((f) => f());
      void end.then((f) => f());
    };
  }, []);

  const fail = (err: unknown) => setMessage({ text: String(err), error: true });

  return {
    list,
    busy,
    message,
    incoming,
    undo,
    attach: () => {
      setBusy(true);
      setMessage(null);
      attachFiles(noteId)
        .then((added) => {
          if (added.length) reload();
        })
        .catch(fail)
        .finally(() => setBusy(false));
    },
    open: (a) => {
      setMessage(null);
      openAttachment(a.id).catch(fail);
    },
    save: (a) => {
      setMessage(null);
      saveAttachment(a.id)
        .then((where) => where && setMessage({ text: `Saved "${a.name}" to ${where}`, error: false }))
        .catch(fail);
    },
    remove: (a) => {
      removeAttachment(a.id)
        .then(() => {
          reload();
          undo.offer(`Removed "${a.name}".`, () => void restoreAttachment(a.id).then(reload).catch(fail));
        })
        .catch(fail);
    },
  };
}

/** The paperclip in the note's header. */
export function AttachButton(props: { files: NoteFiles }) {
  return (
    <button
      type="button"
      className="icon-button"
      onClick={props.files.attach}
      disabled={props.files.busy}
      title="Attach files (zip, PDF, slides, anything). They go to your other devices with sync."
      aria-label="Attach files"
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M13.5 6.5l-6 6a1.8 1.8 0 0 0 2.5 2.5l6.5-6.5a3.2 3.2 0 0 0-4.5-4.5L5.5 10.5a4.6 4.6 0 0 0 6.5 6.5l5-5" />
      </svg>
    </button>
  );
}

/** "PDF", "ZIP", "PPTX" … for the file's badge. */
function kind(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
  return ext && ext.length <= 4 ? ext : "FILE";
}

/** The note's files under the text: click one to open it; save a copy or take it off. */
export function AttachmentList(props: { files: NoteFiles }) {
  const f = props.files;
  if (!f.list.length && !f.busy && !f.message && !f.undo.current) return null;
  return (
    <section className="note-files" aria-label="Attached files">
      {f.list.length > 0 && (
        <ul className="note-file-list">
          {f.list.map((a) => (
            <li key={a.id} className="note-file" data-missing={!a.available || undefined}>
              <button
                type="button"
                className="note-file-open"
                onClick={() => f.open(a)}
                disabled={!a.available}
                title={a.available ? `Open ${a.name}` : "Still on your other device. It arrives with the next sync."}
              >
                <span className="note-file-kind" aria-hidden="true">
                  {kind(a.name)}
                </span>
                <span className="note-file-text">
                  <span className="note-file-name">{a.name}</span>
                  <span className="note-file-size muted small">
                    {formatBytes(a.size)}
                    {!a.available && (f.incoming !== null ? ` · arriving ${f.incoming}%` : " · on your other device")}
                  </span>
                </span>
              </button>
              <button type="button" className="icon-button note-file-action" onClick={() => f.save(a)} disabled={!a.available} title="Save a copy" aria-label={`Save a copy of ${a.name}`}>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 3v10M6 9l4 4 4-4M4 16h12" />
                </svg>
              </button>
              <button type="button" className="icon-button note-file-action" onClick={() => f.remove(a)} title="Take off the note" aria-label={`Remove ${a.name}`}>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M6 6l8 8M14 6l-8 8" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      {f.busy && <p className="muted small">Attaching…</p>}
      {f.message && (
        <p className={f.message.error ? "error small" : "muted small"} role="status">
          {f.message.text}
        </p>
      )}
      <UndoToast undo={f.undo} />
    </section>
  );
}
