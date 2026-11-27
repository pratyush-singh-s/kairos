import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { addNoteFolder, moveNoteFolder, removeNoteFolder, setNoteFolder, type NoteSummary } from "../../ipc/notes";
import { timeOfDay } from "@focus/core";
import { PencilIcon } from "./InkNote";

/** Folders you closed, per PC (not synced). */
const CLOSED_KEY = "focus.notes.closedFolders";

function readClosed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveClosed(s: Set<string>) {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...s]));
  } catch {
    // Only a convenience.
  }
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null);
const join = (parent: string | null, name: string) => (parent ? `${parent}/${name}` : name);
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

interface Folder {
  path: string;
  folders: Folder[];
  notes: NoteSummary[];
  /** Notes in it and in every folder inside it. */
  count: number;
}

function buildTree(paths: string[], notes: NoteSummary[]): { folders: Folder[]; notes: NoteSummary[] } {
  const byPath = new Map<string, Folder>();
  const top: Folder[] = [];
  const ensure = (path: string): Folder => {
    let f = byPath.get(path);
    if (f) return f;
    f = { path, folders: [], notes: [], count: 0 };
    byPath.set(path, f);
    const parent = parentOf(path);
    if (parent) ensure(parent).folders.push(f);
    else top.push(f);
    return f;
  };
  for (const p of paths) ensure(p);
  const loose: NoteSummary[] = [];
  for (const n of notes) {
    if (!n.folder) {
      loose.push(n);
      continue;
    }
    ensure(n.folder).notes.push(n);
    for (let p: string | null = n.folder; p; p = parentOf(p)) ensure(p).count++;
  }
  const sort = (list: Folder[]) => {
    list.sort((a, b) => nameOf(a.path).localeCompare(nameOf(b.path), undefined, { sensitivity: "base", numeric: true }));
    list.forEach((f) => sort(f.folders));
  };
  sort(top);
  return { folders: top, notes: loose };
}

/** A note or a folder being dragged onto a folder. */
type Dragged = { kind: "note"; id: string; label: string } | { kind: "folder"; path: string; label: string };

type Edit = { kind: "new"; parent: string | null } | { kind: "rename"; path: string } | null;

type Menu = { x: number; y: number; target: { kind: "note"; note: NoteSummary } | { kind: "folder"; path: string } } | null;

/** The notes list, grouped into folders that hold notes and other folders. Folders open and close,
 * and notes and folders can be dragged onto a folder (or onto "Notes" for the top level). */
export function NotesTree(props: {
  notes: NoteSummary[];
  folders: string[];
  openId: string | null;
  /** True while searching: a flat list of matches, each with its folder. */
  searching: boolean;
  onShow: (id: string) => void;
  onNewNoteIn: (folder: string | null) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { notes, folders, openId } = props;
  const tree = useMemo(() => buildTree(folders, notes), [folders, notes]);
  const [closed, setClosed] = useState(readClosed);
  const [edit, setEdit] = useState<Edit>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [moving, setMoving] = useState<Dragged | null>(null);
  const [drag, setDrag] = useState<{ item: Dragged; x: number; y: number; over: string | null | undefined } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  // The open note's folders open by themselves, so it can be seen in the list.
  useEffect(() => {
    const f = notes.find((n) => n.id === openId)?.folder;
    if (!f) return;
    setClosed((cur) => {
      let changed = false;
      const next = new Set(cur);
      for (let p: string | null = f; p; p = parentOf(p)) if (next.delete(p)) changed = true;
      if (changed) saveClosed(next);
      return changed ? next : cur;
    });
  }, [openId, notes]);

  const toggle = (path: string) =>
    setClosed((cur) => {
      const next = new Set(cur);
      if (!next.delete(path)) next.add(path);
      saveClosed(next);
      return next;
    });

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (err) {
      props.onError(String(err));
    } finally {
      props.onChanged();
    }
  }

  /** Drops a note or folder into `to` (null = the top level). */
  function drop(item: Dragged, to: string | null) {
    if (item.kind === "note") {
      const n = notes.find((x) => x.id === item.id);
      if ((n?.folder ?? null) === to) return;
      void run(() => setNoteFolder(item.id, to));
    } else {
      if (to !== null && within(to, item.path)) return;
      if (parentOf(item.path) === to) return;
      const dest = join(to, nameOf(item.path));
      if (folders.includes(dest)) return props.onError(`There is already a folder called "${nameOf(item.path)}" there.`);
      void run(async () => {
        await moveNoteFolder(item.path, dest);
        // Keep it open or closed as it was.
        setClosed((cur) => {
          const next = new Set([...cur].map((p) => (within(p, item.path) ? dest + p.slice(item.path.length) : p)));
          saveClosed(next);
          return next;
        });
      });
    }
  }

  // ---- dragging with the pointer (the browser's own drag and drop does not work in the Windows app)
  const press = useRef<{ item: Dragged; x: number; y: number; id: number } | null>(null);
  function onPointerDown(e: React.PointerEvent, item: Dragged) {
    if (e.button !== 0 || props.searching) return;
    press.current = { item, x: e.clientX, y: e.clientY, id: e.pointerId };
  }
  useEffect(() => {
    const target = (x: number, y: number): string | null | undefined => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
      if (!el) return undefined;
      return el.dataset.drop === "" ? null : el.dataset.drop;
    };
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.id) return;
      if (!dragRef.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      e.preventDefault();
      setDrag({ item: p.item, x: e.clientX, y: e.clientY, over: target(e.clientX, e.clientY) });
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.id) return;
      press.current = null;
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      // A drag is not also a click on what was pressed.
      const stop = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", stop, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
      const over = target(e.clientX, e.clientY);
      if (over !== undefined) drop(d.item, over);
    };
    const cancel = () => {
      press.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  });

  // Esc or a click elsewhere closes the menu.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.target instanceof Element && e.target.closest(".notes-menu")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, target: NonNullable<Menu>["target"]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const overOf = (path: string | null) => drag && drag.over === path && canDrop(drag.item, path, notes);

  function noteRow(n: NoteSummary, depth: number, showFolder = false) {
    return (
      <li key={n.id}>
        <button
          type="button"
          className="note-item"
          style={{ paddingLeft: 10 + depth * 16 }}
          aria-current={openId === n.id}
          data-dragging={drag?.item.kind === "note" && drag.item.id === n.id ? "true" : undefined}
          onClick={() => props.onShow(n.id)}
          onPointerDown={(e) => onPointerDown(e, { kind: "note", id: n.id, label: n.title || "Untitled" })}
          onContextMenu={(e) => openMenu(e, { kind: "note", note: n })}
        >
          <span className="note-item-title">
            {n.kind === "ink" && (
              <span className="note-kind-mark" title="Handwritten" aria-label="Handwritten">
                <PencilIcon />
              </span>
            )}
            {n.pinned && (
              <span className="note-pin" title="Pinned" aria-label="Pinned">
                ●{" "}
              </span>
            )}
            {n.title || <span className="muted">Untitled</span>}
          </span>
          <span className="note-item-meta">
            {showFolder && n.folder && <span className="note-item-folder">{n.folder.replace(/\//g, " / ")} · </span>}
            <span className="num">{edited(n.editedAt)}</span> {n.kind === "ink" ? "Handwritten" : n.preview.replace(/\s+/g, " ")}
          </span>
        </button>
      </li>
    );
  }

  function nameInput(depth: number, initial: string, done: (name: string | null) => void) {
    return (
      <li key="name-input" className="notes-folder-input" style={{ paddingLeft: 10 + depth * 16 }}>
        <FolderIcon open={false} />
        <NameInput initial={initial} onDone={done} />
      </li>
    );
  }

  function folderRows(f: Folder, depth: number): ReactNode {
    const isClosed = closed.has(f.path);
    const renaming = edit?.kind === "rename" && edit.path === f.path;
    return (
      <li key={f.path} className="notes-folder" data-drop={f.path}>
        {renaming ? (
          <ul>
            {nameInput(depth, nameOf(f.path), (name) => {
              setEdit(null);
              if (!name || name === nameOf(f.path)) return;
              const dest = join(parentOf(f.path), name);
              if (folders.includes(dest)) return props.onError(`There is already a folder called "${name}" there.`);
              void run(() => moveNoteFolder(f.path, dest));
            })}
          </ul>
        ) : (
          <div
            className="notes-folder-row"
            data-over={overOf(f.path) ? "true" : undefined}
            data-dragging={drag?.item.kind === "folder" && within(f.path, drag.item.path) ? "true" : undefined}
            style={{ paddingLeft: 4 + depth * 16 }}
            onContextMenu={(e) => openMenu(e, { kind: "folder", path: f.path })}
          >
            <button
              type="button"
              className="notes-folder-name"
              aria-expanded={!isClosed}
              onClick={() => toggle(f.path)}
              onPointerDown={(e) => onPointerDown(e, { kind: "folder", path: f.path, label: nameOf(f.path) })}
            >
              <span className="notes-caret" aria-hidden="true">
                {isClosed ? "▸" : "▾"}
              </span>
              <FolderIcon open={!isClosed} />
              <span className="notes-folder-label">{nameOf(f.path)}</span>
              <span className="notes-folder-count num">{f.count}</span>
            </button>
            <button type="button" className="notes-folder-act" title="New note in this folder" aria-label={`New note in ${nameOf(f.path)}`} onClick={() => props.onNewNoteIn(f.path)}>
              +
            </button>
            <button
              type="button"
              className="notes-folder-act"
              title="Folder menu"
              aria-label={`More for ${nameOf(f.path)}`}
              onClick={(e) => openMenu(e, { kind: "folder", path: f.path })}
            >
              ⋯
            </button>
          </div>
        )}
        {!isClosed && (
          <ul>
            {edit?.kind === "new" && edit.parent === f.path && newFolderInput(depth + 1)}
            {f.folders.map((c) => folderRows(c, depth + 1))}
            {f.notes.map((n) => noteRow(n, depth + 1))}
            {f.folders.length === 0 && f.notes.length === 0 && edit?.kind !== "new" && (
              <li className="muted small notes-folder-empty" style={{ paddingLeft: 30 + depth * 16 }}>
                Empty. Drag notes here.
              </li>
            )}
          </ul>
        )}
      </li>
    );
  }

  function newFolderInput(depth: number) {
    const parent = edit?.kind === "new" ? edit.parent : null;
    return nameInput(depth, "", (name) => {
      setEdit(null);
      if (!name) return;
      void run(async () => {
        const path = await addNoteFolder(join(parent, name));
        if (moving) {
          await dropAsync(moving, path);
          setMoving(null);
        }
      });
    });
  }

  async function dropAsync(item: Dragged, to: string | null) {
    if (item.kind === "note") await setNoteFolder(item.id, to);
    else await moveNoteFolder(item.path, join(to, nameOf(item.path)));
  }

  if (props.searching) {
    return <ul>{notes.map((n) => noteRow(n, 0, true))}</ul>;
  }

  return (
    <>
      <div className="notes-tree-head" data-drop="" data-over={overOf(null) ? "true" : undefined}>
        <span className="muted small">{drag ? "Drop here for no folder" : "Folders"}</span>
        <button type="button" className="notes-new-folder" title="New folder" onClick={() => setEdit({ kind: "new", parent: null })}>
          <FolderIcon open={false} plus />
          <span className="small">New folder</span>
        </button>
      </div>
      <ul className="notes-tree" data-drop="">
        {edit?.kind === "new" && edit.parent === null && newFolderInput(0)}
        {tree.folders.map((f) => folderRows(f, 0))}
        {tree.notes.map((n) => noteRow(n, 0))}
      </ul>
      {/* The empty space under the list is the top level too. */}
      <div className="notes-tree-rest" data-drop="" />

      {drag && (
        <div className="notes-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 10 }}>
          {drag.item.kind === "folder" && <FolderIcon open={false} />} {drag.item.label}
        </div>
      )}

      {menu && (
        <div className="case-menu notes-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          {menu.target.kind === "folder" ? (
            (() => {
              const path = menu.target.path;
              const pick = (f: () => void) => () => {
                setMenu(null);
                f();
              };
              return (
                <>
                  <button type="button" role="menuitem" onClick={pick(() => props.onNewNoteIn(path))}>
                    New note here
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={pick(() => {
                      setClosed((cur) => {
                        const next = new Set(cur);
                        next.delete(path);
                        saveClosed(next);
                        return next;
                      });
                      setEdit({ kind: "new", parent: path });
                    })}
                  >
                    New folder inside
                  </button>
                  <hr />
                  <button type="button" role="menuitem" onClick={pick(() => setEdit({ kind: "rename", path }))}>
                    Rename
                  </button>
                  <button type="button" role="menuitem" onClick={pick(() => setMoving({ kind: "folder", path, label: nameOf(path) }))}>
                    Move to…
                  </button>
                  <hr />
                  <button type="button" role="menuitem" onClick={pick(() => void run(() => removeNoteFolder(path)))}>
                    Remove folder (keep notes)
                  </button>
                </>
              );
            })()
          ) : (
            (() => {
              const n = menu.target.note;
              return (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      setMoving({ kind: "note", id: n.id, label: n.title || "Untitled" });
                    }}
                  >
                    Move to folder…
                  </button>
                  {n.folder && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        void run(() => setNoteFolder(n.id, null));
                      }}
                    >
                      Take out of folder
                    </button>
                  )}
                </>
              );
            })()
          )}
        </div>
      )}

      {moving && (
        <MoveDialog
          item={moving}
          folders={folders}
          current={moving.kind === "note" ? notes.find((n) => n.id === moving.id)?.folder ?? null : parentOf(moving.path)}
          onPick={(to) => {
            const item = moving;
            setMoving(null);
            drop(item, to);
          }}
          onNew={async (name) => {
            const item = moving;
            setMoving(null);
            await run(async () => {
              const path = await addNoteFolder(name);
              await dropAsync(item, path);
            });
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </>
  );
}

function canDrop(item: Dragged, to: string | null, notes: NoteSummary[]) {
  if (item.kind === "note") return (notes.find((n) => n.id === item.id)?.folder ?? null) !== to;
  if (to !== null && within(to, item.path)) return false;
  return parentOf(item.path) !== to;
}

/** "Move to…": every folder, indented, plus the top level and a new folder. */
function MoveDialog(props: {
  item: Dragged;
  folders: string[];
  current: string | null;
  onPick: (to: string | null) => void;
  onNew: (path: string) => void;
  onClose: () => void;
}) {
  const { item } = props;
  const [name, setName] = useState("");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  });
  const allowed = (p: string) => !(item.kind === "folder" && within(p, item.path));
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal card notes-move" role="dialog" aria-label={`Move ${item.label}`}>
        <h2 className="card-title">Move "{item.label}" to</h2>
        <ul className="notes-move-list">
          <li>
            <button type="button" className="note-item" aria-current={props.current === null} onClick={() => props.onPick(null)}>
              <span className="note-item-title">No folder (top level)</span>
            </button>
          </li>
          {props.folders.filter(allowed).map((p) => (
            <li key={p}>
              <button
                type="button"
                className="note-item"
                style={{ paddingLeft: 10 + (p.split("/").length - 1) * 16 }}
                aria-current={props.current === p}
                onClick={() => props.onPick(p)}
              >
                <span className="note-item-title">
                  <FolderIcon open={false} /> {nameOf(p)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="notes-move-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) props.onNew(name.trim());
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New folder (School/Physics makes one inside another)" aria-label="New folder name" maxLength={300} />
          <button type="submit" className="button" disabled={!name.trim()}>
            Make and move
          </button>
        </form>
        <div className="notes-move-foot">
          <button type="button" className="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Typing a folder name: Enter keeps it, Esc or leaving the box without a name drops it. */
function NameInput(props: { initial: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(props.initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    props.onDone(name);
  };
  return (
    <input
      autoFocus
      className="notes-folder-field"
      value={v}
      maxLength={60}
      placeholder="Folder name"
      aria-label="Folder name"
      onChange={(e) => setV(e.target.value.replace(/\//g, ""))}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(v.trim() || null);
        if (e.key === "Escape") {
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => finish(v.trim() || null)}
    />
  );
}

export function FolderIcon(props: { open: boolean; plus?: boolean }) {
  return (
    <svg className="notes-folder-icon" viewBox="0 0 20 20" aria-hidden="true" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      {props.open ? (
        <path d="M2.5 6V4.5h5l1.5 2h8.5V8M2.5 6v9.5h13l2-7.5h-13l-2 7.5" />
      ) : (
        <path d="M2.5 4.5h5l1.5 2h8.5v9h-15z" />
      )}
      {props.plus && <path d="M10 9v5M7.5 11.5h5" />}
    </svg>
  );
}

const dayTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
function edited(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? timeOfDay(d) : dayTime.format(d);
}
