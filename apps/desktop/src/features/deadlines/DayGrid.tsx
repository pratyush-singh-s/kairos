import type { CSSProperties } from "react";
import type { DayCell } from "@focus/core";
import type { CellShape, ProgressStyle } from "../../ipc/deadlines";
import { useUi } from "../../theme/UiProvider";

const longDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
const parse = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12);
};

/** Cells per row when "automatic": a week per row for the grid, one row of bars up to a month. */
export function autoColumns(style: ProgressStyle, total: number): number {
  if (style === "bars") return Math.min(total, 31);
  return Math.min(total, 7);
}

/** Terminal blocks: gone █, today ▓, the due day ▒, still to come ░. */
function block(c: DayCell): string {
  if (c.kind === "past") return "█";
  if (c.kind === "today") return "▓";
  if (c.isDueDay) return "▒";
  return "░";
}

/**
 * One cell per day from the start day to the due day (or per week for long periods), filled by
 * itself as the days go by, like a progress bar: it only shows how much time is left, so it
 * cannot be clicked. Drawn as rows of cells ("grid") or tall bars ("bars"), in the deadline's
 * colour and chosen shape; the Terminal theme draws █▓▒░ blocks instead.
 */
export function DayGrid(props: {
  cells: DayCell[];
  byWeek: boolean;
  style: ProgressStyle;
  shape: CellShape;
  /** Cells per row; null = automatic. */
  columns: number | null;
  /** The deadline's colour; null = the theme's accent. */
  color: string | null;
}) {
  const { theme } = useUi();
  const total = props.cells.length;
  const cols = Math.max(1, Math.min(total || 1, props.columns ?? autoColumns(props.style, total)));
  const gone = props.cells.filter((c) => c.kind === "past").length;
  const unit = props.byWeek ? "weeks" : "days";

  const style = {
    "--grid-cols": cols,
    ...(props.color ? { "--dl-color": props.color } : {}),
  } as CSSProperties;

  return (
    <div
      className="day-grid"
      data-style={props.style}
      data-shape={props.shape}
      style={style}
      role="img"
      aria-label={`${gone} of ${total} ${unit} gone`}
    >
      {props.cells.map((c, n) => {
        const left = total - n - 1;
        const name = props.byWeek ? `Week ${n + 1} from` : `Day ${n + 1} ·`;
        const tip = `${name} ${longDate.format(parse(c.date))} · ${c.kind}${c.isDueDay ? " · due day" : ""}${
          props.byWeek ? "" : ` · ${left} ${left === 1 ? "day" : "days"} remaining`
        }`;
        return (
          <span key={c.dayIndex} className="day-cell" data-kind={c.kind} data-due={c.isDueDay} title={tip}>
            {theme === "terminal" && <span className="cell-block">{block(c)}</span>}
          </span>
        );
      })}
    </div>
  );
}
