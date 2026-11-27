import { useRef, useState, type PointerEvent } from "react";
import { MAX_GROUP_NAME, groupItems, renameTagGroup, type GroupItem, type YoutubeRules } from "@focus/core";

/** Where a dragged tag or phrase can land: on another one, on a group, or back in "No group". */
type Drop = { kind: "item"; item: string } | { kind: "group"; name: string } | { kind: "none" };

/** "tag:gaming" or "phrase:minecraft": one key per row. */
const keyOf = (i: GroupItem) => `${i.kind}:${i.value}`;
const itemOf = (key: string): GroupItem => {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at) === "tag" ? "tag" : "phrase", value: key.slice(at + 1) };
};
const labelOf = (i: GroupItem) => (i.kind === "tag" ? `#${i.value}` : i.value);

const DRAG_START_PX = 5;

function dropAt(x: number, y: number): Drop | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tag-drop]");
  const v = el?.dataset.tagDrop;
  if (!v) return null;
  if (v === "none") return { kind: "none" };
  if (v.startsWith("item:")) return { kind: "item", item: v.slice(5) };
  if (v.startsWith("group:")) return { kind: "group", name: v.slice(6) };
  return null;
}

const sameDrop = (a: Drop | null, b: Drop | null) => JSON.stringify(a) === JSON.stringify(b);

/** Collapsed group names, kept on this device only (a view setting, not synced). */
const COLLAPSED_KEY = "focus.blocking.collapsedTagGroups";

function readCollapsed(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}
function writeCollapsed(names: string[]) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(names));
  } catch {
    // Only a convenience.
  }
}

/**
 * Blocked tags and phrases, gathered into groups: drag one onto another to make a group
 * ("#gaming" + "minecraft" = Gaming), onto a group to add it, or onto "No group" to take it out.
 * Each row also has a menu that does the same from the keyboard. Groups only tidy the list;
 * everything is still blocked on its own.
 */
export function TagGroups(props: {
  youtube: YoutubeRules;
  onGroupWith: (item: GroupItem, onto: GroupItem) => void;
  onMove: (item: GroupItem, group: string | null) => void;
  onNewGroup: (item: GroupItem) => void;
  onRename: (name: string, to: string) => void;
  onUngroup: (name: string) => void;
  onRemove: (item: GroupItem) => void;
}) {
  const { tags, keywords, groups } = props.youtube;
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Drop | null>(null);
  // A group made by the last drop: its name box gets focus so it can be renamed straight away.
  const [fresh, setFresh] = useState<string | null>(null);
  const before = useRef(groups.map((g) => g.name));
  const [collapsed, setCollapsedList] = useState<string[]>(readCollapsed);
  const isCollapsed = (name: string) => collapsed.includes(name);
  const setCollapsed = (next: string[]) => {
    setCollapsedList(next);
    writeCollapsed(next);
  };
  const toggle = (name: string) => setCollapsed(isCollapsed(name) ? collapsed.filter((n) => n !== name) : [...collapsed, name]);
  const allCollapsed = groups.length > 0 && groups.every((g) => isCollapsed(g.name));
  const grouped = new Set(groups.flatMap((g) => groupItems(g).map(keyOf)));
  const all = [...tags.map((value) => keyOf({ kind: "tag", value })), ...keywords.map((value) => keyOf({ kind: "phrase", value }))];
  const loose = all.filter((k) => !grouped.has(k));

  function startDrag(e: PointerEvent<HTMLElement>, tag: string) {
    // `tag` is a row key ("tag:…" or "phrase:…").
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, select, input")) return;
    const row = e.currentTarget;
    e.preventDefault();
    try {
      row.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost: HTMLElement | null = null;
    let target: Drop | null = null;
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!ghost) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        const box = row.getBoundingClientRect();
        ghost = row.cloneNode(true) as HTMLElement;
        ghost.classList.add("tag-ghost");
        Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` });
        document.body.appendChild(ghost);
        document.body.classList.add("is-dragging-card");
        setDragging(tag);
      }
      ghost.style.transform = `translate(${dx}px, ${dy}px)`;
      const t = dropAt(ev.clientX, ev.clientY);
      target = t?.kind === "item" && t.item === tag ? null : t;
      setOver((o) => (sameDrop(o, target) ? o : target));
    };
    const finish = (drop: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("is-dragging-card");
      setDragging(null);
      setOver(null);
      if (!drop || !target) return;
      before.current = groups.map((g) => g.name);
      if (target.kind === "item") {
        const onto = target.item;
        const joins = groups.find((g) => groupItems(g).some((i) => keyOf(i) === onto));
        props.onGroupWith(itemOf(tag), itemOf(onto));
        // A brand-new group is named after what it was dropped on; offer to rename it.
        if (!joins) setFresh(onto);
      } else if (target.kind === "group") props.onMove(itemOf(tag), target.name);
      else props.onMove(itemOf(tag), null);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc);
  }

  function row(key: string, group: string | null) {
    const item = itemOf(key);
    const label = labelOf(item);
    return (
      <li
        key={key}
        className="tag-row"
        data-tag-drop={`item:${key}`}
        data-drop={over?.kind === "item" && over.item === key}
        data-dragging={dragging === key}
        onPointerDown={(e) => startDrag(e, key)}
        title="Drag onto another tag or phrase to group them"
      >
        <span className="tag-grip" aria-hidden="true">
          ⠿
        </span>
        <span className="blocking-domain">
          <span className={`blocking-kind blocking-kind-${item.kind}`}>{item.kind}</span>
          {label}
        </span>
        <select
          className="tag-move"
          aria-label={`Group for ${label}`}
          value={group ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "\u0000new") {
              before.current = groups.map((g) => g.name);
              setFresh(key);
              props.onNewGroup(item);
            } else props.onMove(item, v === "" ? null : v);
          }}
        >
          <option value="">No group</option>
          {groups.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name}
            </option>
          ))}
          <option value={"\u0000new"}>New group…</option>
        </select>
        <button type="button" className="link-button" aria-label={`Remove ${label}`} onClick={() => props.onRemove(item)}>
          Remove
        </button>
      </li>
    );
  }

  return (
    <div className="tag-groups">
      <div className="tag-groups-intro">
        <p className="muted small">Drag one onto another to group them.</p>
        {groups.length > 1 && (
          <button
            type="button"
            className="link-button small"
            onClick={() => setCollapsed(allCollapsed ? [] : groups.map((g) => g.name))}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
      </div>
      {groups.map((g) => {
        const shut = isCollapsed(g.name);
        const listId = `tag-group-list-${g.name.replace(/[^\w-]/g, "_")}`;
        return (
        <section
          key={g.name}
          className="tag-group"
          data-tag-drop={`group:${g.name}`}
          data-drop={over?.kind === "group" && over.name === g.name}
          data-collapsed={shut}
          aria-label={`Group ${g.name}`}
        >
          <div className="tag-group-head">
            <button
              type="button"
              className="tag-group-toggle"
              aria-expanded={!shut}
              aria-controls={listId}
              aria-label={`${shut ? "Expand" : "Collapse"} ${g.name}`}
              title={shut ? "Show the tags in this group" : "Hide the tags in this group"}
              onClick={() => toggle(g.name)}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
            <input
              className="tag-group-name"
              defaultValue={g.name}
              key={g.name}
              maxLength={MAX_GROUP_NAME}
              aria-label="Group name"
              autoFocus={fresh !== null && groupItems(g).some((i) => keyOf(i) === fresh) && !before.current.includes(g.name)}
              onFocus={(e) => {
                if (fresh !== null) e.currentTarget.select();
                setFresh(null);
              }}
              onBlur={(e) => {
                // Keep a collapsed group collapsed under its new name.
                if (shut) {
                  const at = groups.indexOf(g);
                  const to = renameTagGroup(props.youtube, g.name, e.target.value.slice(0, MAX_GROUP_NAME)).groups[at]?.name;
                  if (to && to !== g.name) setCollapsed([...collapsed.filter((n) => n !== g.name), to]);
                }
                props.onRename(g.name, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.currentTarget.value = g.name;
                  e.currentTarget.blur();
                }
              }}
            />
            <span className="muted small">{countLabel(g.tags.length, (g.phrases ?? []).length)}</span>
            <button type="button" className="link-button small" onClick={() => props.onUngroup(g.name)}>
              Ungroup
            </button>
          </div>
          <div className="tag-group-body" id={listId} inert={shut}>
            <div className="tag-group-fold">
              <ul className="list blocking-rules">{groupItems(g).map((i) => row(keyOf(i), g.name))}</ul>
            </div>
          </div>
        </section>
        );
      })}
      {(loose.length > 0 || dragging) && (
        <section className="tag-loose" data-tag-drop="none" data-drop={over?.kind === "none"} aria-label="Tags and phrases in no group">
          {groups.length > 0 && <h4 className="tag-loose-title muted small">No group</h4>}
          {loose.length > 0 ? (
            <ul className="list blocking-rules">{loose.map((t) => row(t, null))}</ul>
          ) : (
            <p className="muted small tag-loose-empty">Drop here to take it out of its group.</p>
          )}
        </section>
      )}
    </div>
  );
}

function countLabel(tags: number, phrases: number): string {
  const part = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (phrases === 0) return part(tags, "tag", "tags");
  if (tags === 0) return part(phrases, "phrase", "phrases");
  return `${part(tags, "tag", "tags")}, ${part(phrases, "phrase", "phrases")}`;
}
