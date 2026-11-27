import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { newBoardId, type BoardItem, type CardData, type ListData } from "../../ipc/boards";
import type { Space } from "../../ipc/spaces";
import { today as todayIso } from "../../ipc/tasks";
import { ColorDot } from "./ColorDot";
import type { Undo } from "./UndoToast";
import { between, useBoard, type Board } from "./useBoard";
import { QuickAdd } from "./WeekBoard";

type ListItem = BoardItem<ListData>;
type CardItem = BoardItem<CardData>;

const DRAG_START_PX = 5;
/** How long a finger holds a card or list before it lifts (phone). */
const HOLD_MS = 350;
const dueFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** Where a dragged card would land: before `before` in `list` (null = at the end). */
interface CardDrop {
  list: string;
  before: string | null;
}

/**
 * A free space: lists side by side with cards on them, like a kanban board. Cards move between
 * lists by dragging; lists move by dragging their title bar. No dates needed, but a card can
 * have one, a colour, a description and a tick.
 */
export function FreeBoard(props: { space: Space; undo: Undo; onEditSpace: () => void }) {
  const board = useBoard(props.space.id);
  const lists = useMemo(
    () => (board.items.filter((i) => i.kind === "list") as unknown as ListItem[]).sort((a, b) => a.data.order - b.data.order),
    [board.items],
  );
  const cardsOf = useMemo(() => {
    const by = new Map<string, CardItem[]>();
    for (const c of board.items.filter((i) => i.kind === "card") as unknown as CardItem[]) {
      const arr = by.get(c.data.list) ?? [];
      arr.push(c);
      by.set(c.data.list, arr);
    }
    for (const arr of by.values()) arr.sort((a, b) => a.data.order - b.data.order);
    return by;
  }, [board.items]);
  const [editing, setEditing] = useState<CardItem | null>(null);
  const drag = useFreeDrag(board, lists, cardsOf);
  const today = todayIso();

  const addList = (title: string) =>
    board.put([{ id: newBoardId(), kind: "list", data: { title, order: between(lists.at(-1)?.data.order, undefined) } }]);
  const addCard = (list: string, title: string) => {
    const last = cardsOf.get(list)?.at(-1);
    board.put([{ id: newBoardId(), kind: "card", data: { list, title, order: between(last?.data.order, undefined) } }]);
  };
  const saveCard = (c: CardItem, data: CardData) => board.put([{ id: c.id, kind: "card", data: { ...data } }]);

  async function remove(ids: string[], what: string) {
    const gone = await board.remove(ids);
    if (gone.length) props.undo.offer(`Deleted ${what}.`, () => void board.restore(gone));
  }

  return (
    <>
      <div className="board-toolbar">
        <span className="muted small">{lists.length === 0 ? "Start with a list." : "Drag cards between lists."}</span>
        <span className="push-right" />
        <button type="button" className="button small-button" onClick={props.onEditSpace}>
          Edit space
        </button>
      </div>
      {board.error && (
        <p className="error" role="alert">
          {board.error}
        </p>
      )}

      <div className="free-board" data-dragging={drag.active ? "true" : undefined}>
        {lists.map((l) => {
          const cards = cardsOf.get(l.id) ?? [];
          return (
            <section key={l.id} className="free-list" data-list-id={l.id} data-moving={drag.movingId === l.id} aria-label={l.data.title}>
              <ListHead
                list={l}
                count={cards.length}
                dragProps={drag.listProps(l.id)}
                onRename={(title) => board.put([{ id: l.id, kind: "list", data: { ...l.data, title } }])}
                onDelete={() => void remove([l.id], `the list "${l.data.title}" and its ${cards.length} ${cards.length === 1 ? "card" : "cards"}`)}
              />
              <ul className="free-cards">
                {cards.map((c) => (
                  <li key={c.id}>
                    {drag.drop?.list === l.id && drag.drop.before === c.id && <div className="free-drop-mark" aria-hidden="true" />}
                    <FreeCard
                      card={c}
                      today={today}
                      moving={drag.movingId === c.id}
                      dragProps={drag.cardProps(c.id)}
                      onOpen={() => !drag.wasDrag() && setEditing(c)}
                      onToggle={() => saveCard(c, { ...c.data, done: !c.data.done })}
                    />
                  </li>
                ))}
                {drag.drop?.list === l.id && drag.drop.before === null && (
                  <li aria-hidden="true">
                    <div className="free-drop-mark" />
                  </li>
                )}
              </ul>
              <QuickAdd label={`Add a card to ${l.data.title}`} button="+ Add a card" placeholder="Card title, Enter to add" onAdd={(t) => addCard(l.id, t)} />
            </section>
          );
        })}
        <section className="free-list free-list-new" aria-label="New list">
          <QuickAdd label="Add a list" button={lists.length ? "+ Add another list" : "+ Add a list"} placeholder="List name, Enter to add" onAdd={addList} />
        </section>
      </div>

      {editing && (
        <CardEditor
          card={(board.items.find((i) => i.id === editing.id) as unknown as CardItem | undefined) ?? editing}
          listName={lists.find((l) => l.id === editing.data.list)?.data.title ?? ""}
          onSave={(data) => {
            saveCard(editing, data);
            setEditing(null);
          }}
          onDelete={() => {
            setEditing(null);
            void remove([editing.id], `"${editing.data.title}"`);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ListHead(props: {
  list: ListItem;
  count: number;
  dragProps: ReturnType<ReturnType<typeof useFreeDrag>["listProps"]>;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(props.list.data.title);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setTitle(props.list.data.title), [props.list.data.title]);

  if (renaming) {
    const done = () => {
      setRenaming(false);
      const t = title.trim();
      if (t && t !== props.list.data.title) props.onRename(t);
      else setTitle(props.list.data.title);
    };
    return (
      <header className="free-list-head">
        <input
          className="task-title-input free-list-title-input"
          value={title}
          autoFocus
          maxLength={80}
          aria-label="List name"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={done}
          onKeyDown={(e) => {
            if (e.key === "Enter") done();
            if (e.key === "Escape") {
              setTitle(props.list.data.title);
              setRenaming(false);
            }
          }}
        />
      </header>
    );
  }
  return (
    <header className="free-list-head" {...props.dragProps} onDoubleClick={() => setRenaming(true)} title="Drag to move the list; double-click to rename">
      <h3 className="free-list-title">{props.list.data.title}</h3>
      <span className="muted small num">{props.count}</span>
      {confirm ? (
        <span className="free-list-confirm">
          <button type="button" className="link-button small danger-text" onClick={props.onDelete}>
            Delete list
          </button>
          <button type="button" className="link-button small" onClick={() => setConfirm(false)}>
            Keep
          </button>
        </span>
      ) : (
        <span className="free-list-tools">
          <button type="button" className="icon-button" aria-label="Rename list" title="Rename" onClick={() => setRenaming(true)}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 14.5V16h1.5l8.8-8.8-1.5-1.5L4 14.5zM14.9 4.6l1.5 1.5" />
            </svg>
          </button>
          <button type="button" className="icon-button" aria-label="Delete list" title="Delete list" onClick={() => (props.count ? setConfirm(true) : props.onDelete())}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 6h10M8 6V4h4v2M6.5 6l.7 10h5.6l.7-10" />
            </svg>
          </button>
        </span>
      )}
    </header>
  );
}

function FreeCard(props: {
  card: CardItem;
  today: string;
  moving: boolean;
  dragProps: ReturnType<ReturnType<typeof useFreeDrag>["cardProps"]>;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const d = props.card.data;
  const due = d.due ?? null;
  const dueState = d.done ? "done" : due && due < props.today ? "late" : due === props.today ? "today" : "later";
  return (
    <article
      className="free-card"
      data-done={d.done ? "true" : undefined}
      data-moving={props.moving}
      style={d.color ? { ["--card-color" as string]: d.color } : undefined}
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(e) => e.key === "Enter" && props.onOpen()}
      {...props.dragProps}
    >
      {d.color && <span className="free-card-label" aria-hidden="true" />}
      <span className="free-card-row">
        <button
          type="button"
          className="free-card-tick"
          aria-label={d.done ? `Mark "${d.title}" not done` : `Mark "${d.title}" done`}
          aria-pressed={!!d.done}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle();
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        </button>
        <span className="free-card-title">{d.title}</span>
      </span>
      {(due || d.text) && (
        <span className="free-card-badges">
          {due && (
            <span className="free-card-due" data-state={dueState}>
              {dueFormat.format(new Date(`${due}T12:00:00`))}
            </span>
          )}
          {d.text && (
            <span className="free-card-has-text" title="Has a description" aria-label="Has a description">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 4h10M3 8h10M3 12h6" />
              </svg>
            </span>
          )}
        </span>
      )}
    </article>
  );
}

function CardEditor(props: { card: CardItem; listName: string; onSave: (d: CardData) => void; onDelete: () => void; onClose: () => void }) {
  const d = props.card.data;
  const [title, setTitle] = useState(d.title);
  const [text, setText] = useState(d.text ?? "");
  const [color, setColor] = useState<string | null>(d.color ?? null);
  const [due, setDue] = useState(d.due ?? "");
  const [done, setDone] = useState(!!d.done);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    props.onSave({ ...d, title: title.trim(), text: text.trim() ? text : "", color, due: due || null, done });
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label="Edit card">
        <h2 className="card-title">
          <span className="card-title-text">Card</span>
          {props.listName && <span className="muted small">in {props.listName}</span>}
        </h2>
        <form className="deadline-form" onSubmit={submit}>
          <div className="task-form-main wide">
            <ColorDot color={color} label={title || "the card"} onChange={setColor} />
            <input
              className="task-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              aria-label="Card title"
              autoComplete="off"
            />
          </div>
          <label className="wide task-description">
            <span className="sr-only">Description</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder="Description" autoFocus maxLength={20000} />
          </label>
          <label className="dl-cols">
            <span>Due</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
            {due && (
              <button type="button" className="link-button small" onClick={() => setDue("")}>
                No date
              </button>
            )}
          </label>
          <label className="check-row">
            <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
            <span>Done</span>
          </label>
          <div className="form-actions wide">
            <button type="submit" className="button primary" disabled={!title.trim()}>
              Save
            </button>
            <button type="button" className="button" onClick={props.onClose}>
              Cancel
            </button>
            <button type="button" className="button danger push-right" onClick={props.onDelete}>
              Delete
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Pointer dragging for cards (between and within lists) and for lists (left and right). Pointer
 * events rather than HTML drag and drop, which the Windows webview never starts (see useCardDrag).
 */
function useFreeDrag(board: Board, lists: ListItem[], cardsOf: Map<string, CardItem[]>) {
  const [movingId, setMovingId] = useState<string | null>(null);
  const [drop, setDrop] = useState<CardDrop | null>(null);
  const [active, setActive] = useState(false);
  const justDragged = useRef(false);
  // The handlers outlive a render; read the newest lists and cards.
  const latest = useRef({ lists, cardsOf });
  latest.current = { lists, cardsOf };

  function start(e: ReactPointerEvent<HTMLElement>, id: string, kind: "card" | "list") {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, select")) return;
    const el = kind === "card" ? e.currentTarget : (e.currentTarget.closest(".free-list") as HTMLElement);
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost: HTMLElement | null = null;
    let cardDrop: CardDrop | null = null;
    let listBefore: string | null | undefined;
    // A finger has to hold still first (so swiping still scrolls); a mouse just moves.
    const touch = e.pointerType === "touch";
    let armed = !touch;
    let last = { x: startX, y: startY };
    const holdTimer = touch
      ? window.setTimeout(() => {
          armed = true;
          navigator.vibrate?.(12);
          lift();
          follow(last.x, last.y);
        }, HOLD_MS)
      : undefined;
    // Once a finger is dragging, the page must not scroll under it.
    const stopScroll = (ev: TouchEvent) => ghost && ev.cancelable && ev.preventDefault();

    function lift() {
      const box = el.getBoundingClientRect();
      ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add("free-ghost");
      Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: kind === "list" ? `${box.height}px` : "" });
      document.body.appendChild(ghost);
      document.body.classList.add("is-dragging-card");
      board.hold(true);
      setMovingId(id);
      setActive(true);
    }

    const move = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!armed) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) finish(false);
        return;
      }
      if (!ghost) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_PX) return;
        lift();
      }
      follow(ev.clientX, ev.clientY);
    };

    function follow(x: number, y: number) {
      if (!ghost) return;
      const dx = x - startX;
      const dy = y - startY;
      ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(${kind === "card" ? 3 : 1.5}deg)`;
      const cs = latest.current.cardsOf;
      if (kind === "card") {
        const col = document.elementsFromPoint(x, y).map((n) => n.closest<HTMLElement>("[data-list-id]")).find(Boolean);
        if (!col) {
          cardDrop = null;
        } else {
          const list = col.dataset.listId!;
          const nodes = [...col.querySelectorAll<HTMLElement>(".free-card")].filter((n) => n.dataset.moving !== "true");
          const ids = (cs.get(list) ?? []).filter((c) => c.id !== id).map((c) => c.id);
          let before: string | null = null;
          nodes.forEach((n, i) => {
            const r = n.getBoundingClientRect();
            if (before === null && y < r.top + r.height / 2) before = ids[i] ?? null;
          });
          cardDrop = { list, before };
        }
        setDrop(cardDrop);
      } else {
        const cols = [...document.querySelectorAll<HTMLElement>(".free-list[data-list-id]")];
        listBefore = null;
        for (const c of cols) {
          if (c.dataset.listId === id) continue;
          const r = c.getBoundingClientRect();
          if (x < r.left + r.width / 2) {
            listBefore = c.dataset.listId!;
            break;
          }
        }
      }
    }

    const finish = (commit: boolean) => {
      window.clearTimeout(holdTimer);
      window.removeEventListener("touchmove", stopScroll);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("is-dragging-card");
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      setMovingId(null);
      setDrop(null);
      setActive(false);
      board.hold(false);
      if (!commit) return;
      const { lists: ls, cardsOf: cs } = latest.current;
      if (kind === "card" && cardDrop) {
        const card = [...cs.values()].flat().find((c) => c.id === id);
        if (!card) return;
        const others = (cs.get(cardDrop.list) ?? []).filter((c) => c.id !== id);
        const at = cardDrop.before === null ? others.length : others.findIndex((c) => c.id === cardDrop!.before);
        const order = between(others[at - 1]?.data.order, others[at]?.data.order);
        if (card.data.list !== cardDrop.list || card.data.order !== order) {
          board.put([{ id, kind: "card", data: { ...card.data, list: cardDrop.list, order } }]);
        }
      } else if (kind === "list" && listBefore !== undefined) {
        const list = ls.find((l) => l.id === id);
        if (!list) return;
        const others = ls.filter((l) => l.id !== id);
        const at = listBefore === null ? others.length : others.findIndex((l) => l.id === listBefore);
        const order = between(others[at - 1]?.data.order, others[at]?.data.order);
        if (order !== list.data.order) board.put([{ id, kind: "list", data: { ...list.data, order } }]);
      }
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && finish(false);
    window.addEventListener("touchmove", stopScroll, { passive: false });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc);
  }

  return {
    movingId,
    drop,
    active,
    wasDrag: () => justDragged.current,
    cardProps: (id: string) => ({ onPointerDown: (e: ReactPointerEvent<HTMLElement>) => start(e, id, "card") }),
    listProps: (id: string) => ({ onPointerDown: (e: ReactPointerEvent<HTMLElement>) => start(e, id, "list") }),
  };
}
