import { useState } from "react";
import { computeDeadline } from "@focus/core";
import {
  createDeadline,
  deleteDeadlines,
  listDeadlines,
  restoreDeadlines,
  setDeadlineCompleted,
  updateDeadline,
  type Deadline,
} from "../../ipc/deadlines";
import { useHistoryChanged } from "../../ipc/history";
import { useCommand } from "../../useCommand";
import { UndoToast, useUndo } from "../tasks/UndoToast";
import { DeadlineForm } from "./DeadlineForm";
import { DeadlineTile } from "./DeadlineTile";
import { useNow } from "./useNow";

export function DeadlinesPage() {
  const [state, reload] = useCommand(listDeadlines, 60_000);
  useHistoryChanged(reload, "deadlines-changed");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const undo = useUndo();

  const all = state.kind === "ready" ? state.value : [];
  const open = all.filter((d) => d.completedAt === null);
  const finished = all.filter((d) => d.completedAt !== null);
  // Tick as fast as the most pressing countdown needs (every minute at most, every second near the end).
  const fastest = Math.min(60_000, ...open.map((d) => computeDeadline(d, Date.now()).refreshMs));
  const now = useNow(fastest);

  async function act(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(String(err));
    } finally {
      reload();
    }
  }

  const card = (d: Deadline) =>
    editing === d.id ? (
      <div key={d.id} className="card deadline-card dl-editing">
        <DeadlineForm
          deadline={d}
          onSave={async (input) => {
            await updateDeadline(d.id, input);
            setEditing(null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    ) : (
      <DeadlineTile
        key={d.id}
        deadline={d}
        now={now}
        act={(a) => void act(a)}
        onEdit={() => setEditing(d.id)}
        onComplete={(done) => void act(() => setDeadlineCompleted(d.id, done))}
        onDelete={() =>
          void act(async () => {
            await deleteDeadlines([d.id]);
            undo.offer(`Deleted "${d.title}".`, () => void act(() => restoreDeadlines([d.id])));
          })
        }
      />
    );

  return (
    <section aria-labelledby="deadlines-title" className="deadlines-page">
      <div className="page-head">
        <h1 id="deadlines-title" className="page-title">
          Deadlines
        </h1>
        {editing !== "new" && (
          <button type="button" className="button primary" onClick={() => setEditing("new")}>
            New deadline
          </button>
        )}
      </div>

      {editing === "new" && (
        <div className="card">
          <DeadlineForm
            onSave={async (input) => {
              await createDeadline(input);
              setEditing(null);
              reload();
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {state.kind === "error" && (
        <div className="card notice error-notice" role="alert">
          <p>
            <strong>Could not load your deadlines.</strong> {state.message}
          </p>
          <button type="button" className="button" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      {state.kind === "ready" && open.length === 0 && editing !== "new" && (
        <div className="card notice empty">
          <p>No deadlines yet.</p>
          <p className="muted small">
            Add an exam, project or anything with a due date.
          </p>
        </div>
      )}

      <div className="deadline-tiles">{open.map(card)}</div>

      {finished.length > 0 && (
        <>
          <h2 className="section-title">Finished</h2>
          <div className="deadline-tiles">{finished.map(card)}</div>
        </>
      )}

      <UndoToast undo={undo} />
    </section>
  );
}
