import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { deleteBoardItems, listBoardItems, restoreBoardItems, saveBoardItems, type BoardItem, type BoardItemInput, type BoardKind } from "../../ipc/boards";

/**
 * Everything on one free board or case board, changed here first and saved behind the scenes,
 * so dragging a card never waits for the database. Reloads when another device's changes
 * arrive ("boards-changed"), except while something is being dragged.
 */
export function useBoard(spaceId: string) {
  const [items, setItems] = useState<BoardItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const holding = useRef(false);
  const pending = useRef(0);

  const reload = useCallback(() => {
    if (holding.current || pending.current > 0) return;
    listBoardItems(spaceId)
      .then((list) => {
        if (holding.current || pending.current > 0) return;
        setItems(list);
        setLoaded(true);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [spaceId]);

  useEffect(() => {
    setItems([]);
    setLoaded(false);
    reload();
    let off: (() => void) | undefined;
    let gone = false;
    listen("boards-changed", () => reload())
      .then((un) => (gone ? un() : (off = un)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [reload]);

  async function track(work: Promise<unknown>) {
    pending.current += 1;
    try {
      await work;
      setError(null);
    } catch (e) {
      setError(String(e));
      pending.current -= 1;
      reload();
      return;
    }
    pending.current -= 1;
  }

  /** Puts these items on the board (new or changed) and saves them. */
  function put(changes: { id: string; kind: BoardKind; data: Record<string, unknown> }[]) {
    if (changes.length === 0) return;
    setItems((now) => {
      const next = [...now];
      for (const c of changes) {
        const i = next.findIndex((x) => x.id === c.id);
        if (i >= 0) next[i] = { ...next[i]!, data: c.data };
        else next.push({ id: c.id, spaceId, kind: c.kind, data: c.data, createdAt: Date.now() });
      }
      return next;
    });
    const input: BoardItemInput[] = changes.map((c) => ({ id: c.id, spaceId, kind: c.kind, data: c.data }));
    void track(saveBoardItems(input));
  }

  /** Removes items (and what goes with them); resolves to every removed ID for Undo. */
  async function remove(ids: string[]): Promise<string[]> {
    pending.current += 1;
    try {
      const gone = await deleteBoardItems(ids);
      setItems((now) => now.filter((x) => !gone.includes(x.id)));
      return gone;
    } catch (e) {
      setError(String(e));
      return [];
    } finally {
      pending.current -= 1;
    }
  }

  async function restore(ids: string[]) {
    await track(restoreBoardItems(ids));
    reload();
  }

  /** While true, reloads wait (a drag is moving things). */
  const hold = (on: boolean) => {
    holding.current = on;
  };

  return { items, loaded, error, put, remove, restore, hold, reload };
}

export type Board = ReturnType<typeof useBoard>;

/** Order value between two neighbours (fractional, so a move changes one card). */
export function between(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}
