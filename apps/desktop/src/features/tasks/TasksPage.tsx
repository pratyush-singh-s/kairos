import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useHistoryChanged } from "../../ipc/history";
import { OPEN_NOTE_KEY } from "../../ipc/notes";
import { createSpace, deleteSpace, listSpaces, restoreSpace, updateSpace, type Space, type SpaceKind } from "../../ipc/spaces";
import { createTask, deleteTasks, listTasks, restoreTasks, today as todayIso, updateTask, type Task } from "../../ipc/tasks";
import { useCommand } from "../../useCommand";
import { CaseBoard } from "./CaseBoard";
import { FreeBoard } from "./FreeBoard";
import { PlanBoard } from "./PlanBoard";
import { SpaceForm } from "./SpaceForm";
import { TaskForm } from "./TaskForm";
import { UndoToast, useUndo } from "./UndoToast";
import { WeekBoard } from "./WeekBoard";

/** Opens a note on the Notes page (a detective board's "Open in Notes"). */
export function openNoteFrom(id: string, goToNotes: (page: "notes") => void) {
  try {
    localStorage.setItem(OPEN_NOTE_KEY, id);
  } catch {
    // The Notes page then opens the last note instead.
  }
  goToNotes("notes");
}

/** The open space is remembered on this PC ("" = Everyday). */
const SPACE_KEY = "focus.todoSpace";

function readSpace(): string {
  try {
    return localStorage.getItem(SPACE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Your own order of the space tabs, on this PC (space ids; spaces not in it go last). */
const ORDER_KEY = "focus.spaceOrder";

function readOrder(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The tab groups, in the order they show: day boards (with Everyday), case boards, free boards. */
type TabGroup = "days" | "case" | "free";
const groupOf = (kind: SpaceKind): TabGroup => (kind === "case" ? "case" : kind === "free" ? "free" : "days");
const GROUP_LABEL: Record<TabGroup, string> = { days: "", case: "Case boards", free: "Free boards" };

/** What the editor is open for: a task, a new task (on a date or a plan day), or a space. */
export type Editing =
  | { task: Task }
  | { newOn: string | null }
  | { newOnDay: number | null }
  | { space: Space | null }
  | null;

/**
 * The To-do page. "Everyday" is the main week board; your own spaces sit next to it as tabs:
 * more week boards (e.g. College), day-by-day plans (Day 1 write the code, Day 2 fix bugs...),
 * free boards (lists of cards) and detective boards (cards and sticky notes tied with string).
 */
export function TasksPage(props: { onOpenNote?: (id: string) => void } = {}) {
  // Refresh every minute and on focus, so the board moves on at midnight.
  const [state, reload] = useCommand(listTasks, 60_000);
  const [spacesState, reloadSpaces] = useCommand(listSpaces);
  useHistoryChanged(reload, "tasks-changed");
  useHistoryChanged(reloadSpaces, "tasks-changed");
  const [spaceId, setSpaceId] = useState(readSpace);
  const [order, setOrder] = useState(readOrder);
  const [editing, setEditing] = useState<Editing>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const undo = useUndo();

  const tasks = state.kind === "ready" ? state.value : [];
  const spaces = useMemo(() => {
    const list = spacesState.kind === "ready" ? spacesState.value : [];
    const at = new Map(order.map((id, i) => [id, i]));
    // Spaces you have not placed keep the order they were made in, after the placed ones.
    return list
      .map((s, i) => ({ s, i }))
      .sort((a, b) => (at.get(a.s.id) ?? order.length + a.i) - (at.get(b.s.id) ?? order.length + b.i))
      .map((x) => x.s);
  }, [spacesState, order]);
  const tabDrag = useTabDrag(spaces, (ids) => {
    setOrder(ids);
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
    } catch {
      // Only a convenience.
    }
  });
  // A space deleted (or not synced yet) falls back to Everyday.
  const space = spaces.find((s) => s.id === spaceId) ?? null;
  const shown = useMemo(() => tasks.filter((t) => t.spaceId === (space?.id ?? null)), [tasks, space]);
  const today = todayIso();

  function open(id: string) {
    setSpaceId(id);
    try {
      localStorage.setItem(SPACE_KEY, id);
    } catch {
      // Only a convenience.
    }
  }

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setEditing(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing]);

  async function act(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(String(err));
    } finally {
      reload();
      reloadSpaces();
    }
  }

  const remove = (t: Task) =>
    act(async () => {
      await deleteTasks([t.id]);
      setEditing(null);
      undo.offer(`Deleted "${t.title}".`, () => void act(() => restoreTasks([t.id])));
    });

  const removeSpace = (s: Space) =>
    act(async () => {
      await deleteSpace(s.id);
      setEditing(null);
      open("");
      undo.offer(`Deleted the space "${s.name}".`, () =>
        void act(async () => {
          await restoreSpace(s.id);
          open(s.id);
        }),
      );
    });

  const plan = space?.kind === "plan" ? space : null;
  const planContext = (day: number | null) => (plan ? { days: plan.days, startDate: plan.startDate, day } : undefined);

  return (
    <section aria-labelledby="tasks-title" className="tasks-page board-page">
      <nav className="space-tabs" aria-label="Spaces">
        <h1 id="tasks-title" className="page-title space-tabs-title">
          To-do
        </h1>
        <div className="space-tab-list" role="tablist" data-dragging={tabDrag.dragging ? "true" : undefined}>
          {(["days", "case", "free"] as const).map((g) => {
            const inGroup = spaces.filter((s) => groupOf(s.kind) === g);
            if (g !== "days" && inGroup.length === 0) return null;
            return (
              <div key={g} className="space-tab-group" data-group={g} role="group" aria-label={GROUP_LABEL[g] || "Day boards"}>
                {GROUP_LABEL[g] && <span className="space-tab-group-label">{GROUP_LABEL[g]}</span>}
                {g === "days" && <SpaceTab name="Everyday" active={space === null} onClick={() => open("")} />}
                {inGroup.map((s) => (
                  <SpaceTab
                    key={s.id}
                    id={s.id}
                    name={s.name}
                    color={s.color}
                    kind={g === "days" ? s.kind : undefined}
                    active={space?.id === s.id}
                    onClick={() => !tabDrag.justDragged() && open(s.id)}
                    onPointerDown={(e) => tabDrag.start(e, s.id)}
                    drop={tabDrag.over?.id === s.id ? tabDrag.over.side : undefined}
                    lifted={tabDrag.dragging === s.id}
                  />
                ))}
              </div>
            );
          })}
          <button type="button" className="space-tab space-tab-new" onClick={() => setEditing({ space: null })} title="Make a new space">
            + New space
          </button>
        </div>
      </nav>

      {(state.kind === "error" || spacesState.kind === "error") && (
        <div className="card notice error-notice" role="alert">
          <p>
            <strong>Could not load your tasks.</strong> {state.kind === "error" ? state.message : spacesState.kind === "error" ? spacesState.message : ""}
          </p>
          <button
            type="button"
            className="button"
            onClick={() => {
              reload();
              reloadSpaces();
            }}
          >
            Try again
          </button>
        </div>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      {space?.kind === "free" ? (
        <FreeBoard key={space.id} space={space} undo={undo} onEditSpace={() => setEditing({ space })} />
      ) : space?.kind === "case" ? (
        <CaseBoard key={space.id} space={space} undo={undo} onEditSpace={() => setEditing({ space })} onOpenNote={props.onOpenNote} onOpenSpace={open} />
      ) : plan ? (
        <PlanBoard
          plan={plan}
          tasks={shown}
          today={today}
          act={act}
          onOpen={(t) => setEditing({ task: t })}
          onNew={(day) => setEditing({ newOnDay: day })}
          onEditSpace={() => setEditing({ space: plan })}
        />
      ) : (
        <WeekBoard
          space={space}
          tasks={shown}
          today={today}
          act={act}
          undo={undo}
          onOpen={(t) => setEditing({ task: t })}
          onNew={(day) => setEditing({ newOn: day })}
          onEditSpace={space ? () => setEditing({ space }) : undefined}
        />
      )}

      {editing && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal card" role="dialog" aria-modal="true" aria-label={modalTitle(editing)}>
            <h2 className="card-title">
              <span className="card-title-text">{modalTitle(editing)}</span>
            </h2>
            {"space" in editing ? (
              <SpaceForm
                space={editing.space}
                onSave={async (input) => {
                  if (editing.space) {
                    await updateSpace(editing.space.id, input);
                  } else {
                    open((await createSpace(input)).id);
                  }
                  setEditing(null);
                  reloadSpaces();
                }}
                onCancel={() => setEditing(null)}
                onDelete={editing.space ? () => void removeSpace(editing.space!) : undefined}
                stepCount={editing.space ? tasks.filter((t) => t.spaceId === editing.space!.id).length : 0}
              />
            ) : "task" in editing ? (
              <TaskForm
                withDescription
                task={editing.task}
                plan={planContext(editing.task.planDay)}
                onSave={async (input) => {
                  await updateTask(editing.task.id, { ...input, spaceId: editing.task.spaceId, planDay: plan ? input.planDay : null });
                  setEditing(null);
                  reload();
                }}
                onCancel={() => setEditing(null)}
                extra={
                  <button type="button" className="button danger push-right" onClick={() => void remove(editing.task)}>
                    Delete
                  </button>
                }
              />
            ) : "newOnDay" in editing ? (
              <TaskForm
                withDescription
                plan={planContext(editing.newOnDay)}
                onSave={async (input) => {
                  await createTask({ ...input, spaceId: plan?.id ?? null });
                  setEditing(null);
                  reload();
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <TaskForm
                withDescription
                defaultWhen={editing.newOn === today ? "today" : editing.newOn ? "date" : "none"}
                defaultDate={editing.newOn ?? undefined}
                onSave={async (input) => {
                  await createTask({ ...input, spaceId: space?.id ?? null });
                  setEditing(null);
                  reload();
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        </div>
      )}

      <UndoToast undo={undo} />
    </section>
  );
}

function modalTitle(e: NonNullable<Editing>): string {
  if ("space" in e) return e.space ? `Edit ${e.space.name}` : "New space";
  if ("task" in e) return "Edit task";
  if ("newOnDay" in e) return "New step";
  return "New task";
}

const KIND_TAGS: Partial<Record<SpaceKind, [string, string]>> = {
  plan: ["plan", "day-by-day plan"],
  free: ["free", "free space"],
  case: ["case", "detective board"],
};

/**
 * Drag a space tab to a new place within its group (pointer events: the window's own file drop
 * handling stops HTML drag and drop on Windows). Calls `onOrder` with every space id in the new order.
 */
function useTabDrag(spaces: Space[], onOrder: (ids: string[]) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const dragged = useRef(0);

  function start(e: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const group = groupOf(spaces.find((s) => s.id === id)!.kind);
    let live = false;
    let target: { id: string; side: "before" | "after" } | null = null;
    const move = (ev: PointerEvent) => {
      if (!live) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        live = true;
        setDragging(id);
      }
      const el = document
        .elementsFromPoint(ev.clientX, ev.clientY)
        .map((n) => n.closest<HTMLElement>("[data-space-id]"))
        .find((n) => n && n.closest<HTMLElement>("[data-group]")?.dataset.group === group);
      const tid = el?.dataset.spaceId;
      if (!el || !tid || tid === id) {
        target = null;
      } else {
        const r = el.getBoundingClientRect();
        target = { id: tid, side: ev.clientX < r.left + r.width / 2 ? "before" : "after" };
      }
      setOver(target);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!live) return;
      dragged.current = Date.now();
      setDragging(null);
      setOver(null);
      if (!target) return;
      const ids = spaces.map((s) => s.id).filter((x) => x !== id);
      const i = ids.indexOf(target.id);
      ids.splice(target.side === "before" ? i : i + 1, 0, id);
      onOrder(ids);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  return { start, dragging, over, justDragged: () => Date.now() - dragged.current < 250 };
}

function SpaceTab(props: {
  id?: string;
  name: string;
  color?: string | null;
  kind?: SpaceKind;
  active: boolean;
  onClick: () => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  drop?: "before" | "after";
  lifted?: boolean;
}) {
  const tag = props.kind ? KIND_TAGS[props.kind] : undefined;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      className="space-tab"
      data-active={props.active}
      data-space-id={props.id}
      data-drop={props.drop}
      data-lifted={props.lifted ? "true" : undefined}
      onPointerDown={props.onPointerDown}
      style={props.color ? { ["--space-color" as string]: props.color } : undefined}
      onClick={props.onClick}
      title={tag ? `${props.name} (${tag[1]})` : props.name}
    >
      {props.color && <span className="space-tab-dot" aria-hidden="true" />}
      {props.name}
      {tag && (
        <span className="space-tab-kind" aria-hidden="true">
          {tag[0]}
        </span>
      )}
    </button>
  );
}
