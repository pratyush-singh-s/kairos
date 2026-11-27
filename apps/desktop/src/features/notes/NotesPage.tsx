import { useCallback, useEffect, useRef, useState } from "react";
import { useHistoryChanged } from "../../ipc/history";
import {
  OPEN_NOTE_KEY,
  createNote,
  deleteNotes,
  getNote,
  listNotes,
  listNoteFolders,
  restoreNotes,
  setNoteFolder,
  setNotePinned,
  type Note,
  type NoteKind,
  type NoteSummary,
} from "../../ipc/notes";
import { UndoToast, useUndo } from "../tasks/UndoToast";
import { InkNote } from "./InkNote";
import { NewNoteChoice } from "./NewNoteChoice";
import { NoteEditor } from "./NoteEditor";
import { NotesTree } from "./NotesTree";

function readOpen(): string | null {
  try {
    return localStorage.getItem(OPEN_NOTE_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(OPEN_NOTE_KEY, id);
    else localStorage.removeItem(OPEN_NOTE_KEY);
  } catch {
    // Only a convenience.
  }
}

/** The Notes page: a searchable list on the left (pinned first), the open note on the right. */
export function NotesPage() {
  const [search, setSearch] = useState("");
  const [list, setList] = useState<NoteSummary[] | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  /** The folder a new note goes in (its + button or "New note here"); null = no folder. */
  const newIn = useRef<string | null>(null);
  const [open, setOpen] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // Full screen: only the open note, the list and the rest of the app put away (Esc comes back).
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".ink-pop, .modal-backdrop") && setFull(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [full]);
  const undo = useUndo();

  const reload = useCallback(() => {
    listNotes(search)
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
    listNoteFolders()
      .then((f) => setFolders(Array.isArray(f) ? f : []))
      .catch(() => setFolders([]));
  }, [search]);

  useEffect(reload, [reload]);
  useHistoryChanged(reload, "notes-changed");

  async function show(id: string | null) {
    remember(id);
    if (!id) return setOpen(null);
    try {
      setOpen(await getNote(id));
    } catch (err) {
      setError(String(err));
    }
  }

  // Open the note picked on the dashboard, or the one open last time.
  useEffect(() => {
    void show(readOpen());
  }, []);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(String(err));
    } finally {
      reload();
    }
  }

  const newNote = (kind: NoteKind) =>
    act(async () => {
      setChoosing(false);
      setSearch("");
      let n = await createNote(kind);
      const folder = newIn.current;
      newIn.current = null;
      if (folder) {
        await setNoteFolder(n.id, folder);
        n = { ...n, folder };
      }
      remember(n.id);
      setOpen(n);
    });

  const remove = (n: Note) =>
    act(async () => {
      await deleteNotes([n.id]);
      void show(null);
      undo.offer(`Deleted "${n.title || "Untitled"}".`, () =>
        void act(async () => {
          await restoreNotes([n.id]);
          await show(n.id);
        }),
      );
    });

  const pin = (n: Note, pinned: boolean) =>
    act(async () => {
      await setNotePinned(n.id, pinned);
      setOpen({ ...n, pinned });
    });

  return (
    <section aria-labelledby="notes-title" className="notes-page" data-full={full && open ? "true" : undefined}>
      <div className="page-head">
        <h1 id="notes-title" className="page-title">
          Notes
        </h1>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            newIn.current = null;
            setChoosing(true);
          }}
        >
          New note
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="notes-layout">
        <nav className="notes-list card" aria-label="Notes">
          <input
            type="search"
            className="notes-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes"
            aria-label="Search notes"
          />
          {list === null ? null : list.length === 0 && folders.length === 0 ? (
            <p className="muted small notes-empty">{search.trim() ? "No note has those words." : "No notes yet. Press New note to write one."}</p>
          ) : search.trim() && list.length === 0 ? (
            <p className="muted small notes-empty">No note has those words.</p>
          ) : (
            <NotesTree
              notes={list}
              folders={folders}
              openId={open?.id ?? null}
              searching={!!search.trim()}
              onShow={(id) => void show(id)}
              onNewNoteIn={(f) => {
                newIn.current = f;
                setChoosing(true);
              }}
              onChanged={reload}
              onError={setError}
            />
          )}
        </nav>

        {open ? (
          (() => {
            const Editor = open.kind === "ink" ? InkNote : NoteEditor;
            return (
              <Editor
                key={open.id}
                note={open}
                onSaved={(n) => {
                  setOpen((cur) => (cur?.id === n.id ? { ...n, pinned: cur.pinned } : cur));
                  reload();
                }}
                onPin={(p) => void pin(open, p)}
                onDelete={() => void remove(open)}
                fullscreen={full}
                onFullscreen={setFull}
              />
            );
          })()
        ) : (
          <div className="note-editor card note-none">
            <p className="note-none-word" aria-label="No note open">
              NOTES
            </p>
          </div>
        )}
      </div>

      {choosing && (
        <NewNoteChoice
          onPick={(kind) => void newNote(kind)}
          onClose={() => {
            newIn.current = null;
            setChoosing(false);
          }}
        />
      )}
      <UndoToast undo={undo} />
    </section>
  );
}
