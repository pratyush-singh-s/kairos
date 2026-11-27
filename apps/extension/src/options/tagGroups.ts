/**
 * Blocked tags on the options page, gathered into groups like the app's Blocking page: drag a
 * tag onto another to group them (#gaming + #sologaming = Gaming), onto a group to add it, or
 * onto "No group" to take it out. Each tag also has a menu that does the same without dragging.
 * Groups only tidy the list; every tag is still blocked on its own.
 */
import { MAX_GROUP_NAME, groupTagWith, moveTagToGroup, newTagGroup, removeTagGroup, renameTagGroup, type YoutubeRules } from "@focus/core";

type Drop = { kind: "tag"; tag: string } | { kind: "group"; name: string } | { kind: "none" };

export interface TagGroupHandlers {
  /** Saves the YouTube choices with new groups. */
  change: (next: (yt: YoutubeRules) => YoutubeRules) => void;
  /** Stops blocking a tag; null while the app manages the lists (tags are removed there). */
  remove: ((tag: string) => void) | null;
}

const DRAG_START_PX = 5;
const NEW_GROUP = "\u0000new";

/** A group made by the last change; its name box gets focus after the next render. */
let focusGroupOf: string | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function dropAt(x: number, y: number): { drop: Drop; el: HTMLElement } | null {
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tag-drop]");
  const v = target?.dataset.tagDrop;
  if (!target || !v) return null;
  if (v === "none") return { drop: { kind: "none" }, el: target };
  if (v.startsWith("tag:")) return { drop: { kind: "tag", tag: v.slice(4) }, el: target };
  if (v.startsWith("group:")) return { drop: { kind: "group", name: v.slice(6) }, el: target };
  return null;
}

/** Fills `box` with the tags of `yt`, grouped. `enabled` false shows them without controls. */
export function renderTagGroups(box: HTMLElement, yt: YoutubeRules, enabled: boolean, h: TagGroupHandlers): void {
  box.replaceChildren();
  if (yt.tags.length === 0) return;
  const grouped = new Set(yt.groups.flatMap((g) => g.tags));
  const loose = yt.tags.filter((t) => !grouped.has(t));

  const row = (tag: string, group: string | null): HTMLLIElement => {
    const move = el("select", { className: "tag-move", ariaLabel: `Group for #${tag}`, disabled: !enabled });
    move.append(el("option", { value: "", textContent: "No group", selected: group === null }));
    for (const g of yt.groups) move.append(el("option", { value: g.name, textContent: g.name, selected: g.name === group }));
    move.append(el("option", { value: NEW_GROUP, textContent: "New group…" }));
    move.addEventListener("change", () => {
      if (move.value === NEW_GROUP) {
        focusGroupOf = tag;
        h.change((cur) => newTagGroup(cur, tag, tag));
      } else h.change((cur) => moveTagToGroup(cur, tag, move.value === "" ? null : move.value));
    });
    const li = el(
      "li",
      { className: "tag-row", title: enabled ? "Drag onto another tag to group them" : "" },
      el("span", { className: "tag-grip", ariaHidden: "true", textContent: "⠿" }),
      el("span", { className: "domain" }, el("span", { className: "kind kind-tag", textContent: "tag" }), `#${tag}`),
      move,
    );
    if (h.remove) {
      const remove = el("button", { type: "button", className: "button link", textContent: "Remove", ariaLabel: `Remove #${tag}`, disabled: !enabled });
      remove.addEventListener("click", () => h.remove?.(tag));
      li.append(remove);
    } else li.append(el("span"));
    li.dataset.tagDrop = `tag:${tag}`;
    if (enabled) li.addEventListener("pointerdown", (e) => startDrag(e, li, tag, box, h));
    return li;
  };

  box.append(el("h3", { className: "sub-title", textContent: "Tags" }));
  if (enabled) box.append(el("p", { className: "muted small", textContent: "Drag a tag onto another to group them, like #gaming and #sologaming under Gaming." }));

  for (const g of yt.groups) {
    const name = el("input", { type: "text", className: "tag-group-name", value: g.name, maxLength: MAX_GROUP_NAME, ariaLabel: "Group name", disabled: !enabled });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      if (e.key === "Escape") {
        name.value = g.name;
        name.blur();
      }
    });
    name.addEventListener("blur", () => {
      if (name.value.trim() && name.value !== g.name) h.change((cur) => renameTagGroup(cur, g.name, name.value));
      else name.value = g.name;
    });
    const ungroup = el("button", { type: "button", className: "button link small", textContent: "Ungroup", disabled: !enabled });
    ungroup.addEventListener("click", () => h.change((cur) => removeTagGroup(cur, g.name, false)));
    const head = el("div", { className: "tag-group-head" }, name, el("span", { className: "muted small", textContent: `${g.tags.length} ${g.tags.length === 1 ? "tag" : "tags"}` }));
    if (enabled) head.append(ungroup);
    const section = el("section", { className: "tag-group", ariaLabel: `Group ${g.name}` }, head, el("ul", { className: "rules tag-rules" }, ...g.tags.map((t) => row(t, g.name))));
    section.dataset.tagDrop = `group:${g.name}`;
    box.append(section);
    if (focusGroupOf !== null && g.tags.includes(focusGroupOf)) {
      focusGroupOf = null;
      requestAnimationFrame(() => {
        name.focus();
        name.select();
      });
    }
  }

  const rest = el("section", { className: "tag-loose", ariaLabel: "Tags in no group" });
  rest.dataset.tagDrop = "none";
  if (yt.groups.length > 0) rest.append(el("h4", { className: "tag-loose-title muted small", textContent: "No group" }));
  if (loose.length > 0) rest.append(el("ul", { className: "rules tag-rules" }, ...loose.map((t) => row(t, null))));
  else rest.append(el("p", { className: "muted small tag-loose-empty", textContent: "Drop here to take a tag out of its group." }));
  rest.hidden = loose.length === 0;
  box.append(rest);
}

function startDrag(e: PointerEvent, row: HTMLElement, tag: string, box: HTMLElement, h: TagGroupHandlers): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, select, input")) return;
  e.preventDefault();
  try {
    row.setPointerCapture(e.pointerId);
  } catch {
    /* capture is a nicety */
  }
  const startX = e.clientX;
  const startY = e.clientY;
  const loose = box.querySelector<HTMLElement>(".tag-loose");
  let ghost: HTMLElement | null = null;
  let target: Drop | null = null;
  let lit: HTMLElement | null = null;
  const light = (next: HTMLElement | null) => {
    if (lit === next) return;
    lit?.removeAttribute("data-drop");
    next?.setAttribute("data-drop", "true");
    lit = next;
  };
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!ghost) {
      if (Math.hypot(dx, dy) < DRAG_START_PX) return;
      const r = row.getBoundingClientRect();
      ghost = row.cloneNode(true) as HTMLElement;
      ghost.classList.add("tag-ghost");
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
      document.body.appendChild(ghost);
      document.body.classList.add("is-dragging");
      row.dataset.dragging = "true";
      if (loose) loose.hidden = false;
    }
    ghost.style.transform = `translate(${dx}px, ${dy}px)`;
    const at = dropAt(ev.clientX, ev.clientY);
    const self = at?.drop.kind === "tag" && at.drop.tag === tag;
    target = at && !self ? at.drop : null;
    light(at && !self ? at.el : null);
  };
  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", esc);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("is-dragging");
    delete row.dataset.dragging;
    light(null);
    const t = target;
    if (!drop || !t) {
      if (loose && !loose.querySelector("li")) loose.hidden = true;
      return;
    }
    if (t.kind === "tag") {
      h.change((cur) => {
        // A brand-new group is named after the tag dropped on; offer to rename it.
        if (!cur.groups.some((g) => g.tags.includes(t.tag))) focusGroupOf = t.tag;
        return groupTagWith(cur, tag, t.tag);
      });
    } else h.change((cur) => moveTagToGroup(cur, tag, t.kind === "group" ? t.name : null));
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const esc = (ev: KeyboardEvent) => ev.key === "Escape" && finish(false);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", esc);
}
