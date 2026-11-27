import { useState } from "react";
import { formatDurationShort } from "@focus/core";
import type { AppTime } from "../../ipc/tracking";
import { openable } from "./openable";

/** How many programs get their own slice; the rest become "Other". */
const SLICES = 4;
const SIZE = 168;
const STROKE = 22;
/** Smallest share of the day that gets its own slice. */
const MIN_SHARE = 0.04;
/** Labels on one side keep at least this far apart, in px. */
const LABEL_GAP = 18;
/** Each slice runs this far under the next one, in degrees, so no hairline shows between them. */
const OVERLAP = 0.6;
/** How far a slice moves out when pointed at, in px. */
const POP = 7;

interface Slice {
  name: string;
  seconds: number;
  from: number;
  to: number;
}

/** Top programs, then everything else as one "Other" slice. */
export function usageSlices(apps: AppTime[]): Slice[] {
  const sorted = [...apps].filter((a) => a.seconds > 0).sort((a, b) => b.seconds - a.seconds);
  const sum = sorted.reduce((s, a) => s + a.seconds, 0) || 1;
  // Slivers under 4% would only crowd their labels together: they join "Other".
  const big = sorted.filter((a) => a.seconds / sum >= MIN_SHARE);
  const keep = big.length > 0 ? big.slice(0, SLICES) : sorted.slice(0, 1);
  const rest = sorted.slice(keep.length).reduce((s, a) => s + a.seconds, 0);
  const parts = rest > 0 ? [...keep, { name: "Other", seconds: rest }] : keep;
  const total = parts.reduce((s, a) => s + a.seconds, 0) || 1;
  let at = 0;
  return parts.map((p) => {
    const from = at;
    at += (p.seconds / total) * 360;
    return { ...p, from, to: at };
  });
}

function point(deg: number, r: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [SIZE / 2 + r * Math.cos(a), SIZE / 2 + r * Math.sin(a)];
}

function arc(from: number, to: number, r: number): string {
  const [x1, y1] = point(from, r);
  const [x2, y2] = point(to, r);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

/**
 * Each label sits just outside the middle of its slice, on the left or right of the ring, and
 * labels on the same side are pushed apart so small neighbouring slices never overlap.
 */
function placeLabels(slices: Slice[]): { slice: Slice; side: "left" | "right"; x: number; y: number }[] {
  const out = slices.map((slice) => {
    const [x, y] = point((slice.from + slice.to) / 2, SIZE / 2 + 12);
    return { slice, side: (x < SIZE / 2 ? "left" : "right") as "left" | "right", x, y };
  });
  for (const side of ["left", "right"] as const) {
    const group = out.filter((l) => l.side === side).sort((a, b) => a.y - b.y);
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1]!;
      if (group[i]!.y - prev.y < LABEL_GAP) group[i]!.y = prev.y + LABEL_GAP;
    }
    // If pushing ran off the bottom, slide the whole column back up.
    const last = group[group.length - 1];
    const over = last ? last.y - (SIZE + 10) : 0;
    if (over > 0) for (const l of group) l.y -= over;
    for (let i = group.length - 2; i >= 0; i--) {
      const next = group[i + 1]!;
      if (next.y - group[i]!.y < LABEL_GAP) group[i]!.y = next.y - LABEL_GAP;
    }
    // Pushed labels stay clear of the ring sideways too.
    for (const l of group) {
      const dy = l.y - SIZE / 2;
      const room = Math.sqrt(Math.max(0, (SIZE / 2 + 12) ** 2 - dy * dy));
      l.x = side === "left" ? Math.min(l.x, SIZE / 2 - room) : Math.max(l.x, SIZE / 2 + room);
    }
  }
  return out;
}

/** Today's time per program as a ring, like Android's Digital Wellbeing. */
export function UsageDonut(props: { apps: AppTime[]; onOpen?: () => void }) {
  const slices = usageSlices(props.apps);
  const total = props.apps.reduce((s, a) => s + a.seconds, 0);
  const r = (SIZE - STROKE) / 2;
  const one = slices.length === 1;
  const label = slices.map((s) => `${s.name} ${formatDurationShort(s.seconds)}`).join(", ");
  // Pointing at a slice (or its legend row) moves it out and names it in the middle.
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover === null ? null : slices[hover];
  const pop = (s: Slice, i: number) => {
    const mid = (((s.from + s.to) / 2 - 90) * Math.PI) / 180;
    const out = hover === i ? POP : 0;
    return { transform: `translate(${Math.cos(mid) * out}px, ${Math.sin(mid) * out}px)` };
  };

  return (
    <figure className="usage-donut" aria-label={`Today ${formatDurationShort(total)}: ${label}`} {...openable(props.onOpen, `Screen time today ${formatDurationShort(total)}: ${label}. Open History`)}>
      <div className="usage-ring">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true" onMouseLeave={() => setHover(null)}>
          {one ? (
            <circle cx={SIZE / 2} cy={SIZE / 2} r={r} className="usage-slice" data-i={0} data-on={hover === 0 || undefined} onMouseEnter={() => setHover(0)} />
          ) : (
            slices.map((s, i) => {
              return (
                <path key={s.name} d={arc(s.from, Math.min(s.to + OVERLAP, s.from + 359.9), r)} className="usage-slice" data-i={i} data-other={s.name === "Other" || undefined} data-on={hover === i || undefined} style={pop(s, i)} onMouseEnter={() => setHover(i)} />
              );
            })
          )}
        </svg>
        <div className="usage-center">
          <span className="muted small usage-center-name">{shown ? shown.name : "Today"}</span>
          <span className="num">{formatDurationShort(shown ? shown.seconds : total)}</span>
        </div>
        {placeLabels(slices).map((l) => (
          <span
            key={l.slice.name}
            className="usage-label"
            data-side={l.side}
            style={{ left: `${l.x}px`, top: `${l.y}px` }}
            title={`${l.slice.name} · ${formatDurationShort(l.slice.seconds)}`}
          >
            {l.slice.name}
          </span>
        ))}
      </div>
      <ul className="usage-legend" aria-hidden="true">
        {slices.map((s, i) => (
          <li key={s.name} data-on={hover === i || undefined} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <i data-i={s.name === "Other" ? undefined : i} data-other={s.name === "Other" || undefined} />
            <span>{s.name}</span>
            <span className="num">{formatDurationShort(s.seconds)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
