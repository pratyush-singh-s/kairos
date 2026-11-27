import type { DeadlineView } from "@focus/core";
import { useUi } from "../../theme/UiProvider";
import { AsciiRing, useAscii } from "../../components/Ascii";

const TICKS = 60;

/**
 * The 360° ring: its length is the share of time left, starting at 12 o'clock and shrinking
 * clockwise. Glass draws a smooth stroke; Terminal draws 60 segments.
 */
export function DeadlineRing(props: { view: DeadlineView; size?: number; color?: string | null; children?: React.ReactNode }) {
  const { theme } = useUi();
  const ascii = useAscii();
  const v = props.view;
  const size = props.size ?? 150;
  const r = 52;
  const c = 2 * Math.PI * r;
  const percent = Math.round(v.fraction * 100);
  return (
    <div
      className="deadline-ring"
      data-state={v.state}
      style={{ width: size, height: size, ...(props.color ? { ["--ring-color" as string]: props.color } : {}) }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={v.countdown}
    >
      {ascii ? (
        <AsciiRing fraction={v.state === "completed" ? 1 : v.fraction} size={size} />
      ) : (
      <svg viewBox="0 0 120 120" aria-hidden="true">
        {theme === "terminal" ? (
          Array.from({ length: TICKS }, (_, i) => {
            const a = (i / TICKS) * 2 * Math.PI - Math.PI / 2;
            const lit = v.state === "completed" || i < Math.round(v.fraction * TICKS);
            return (
              <line
                key={i}
                className={lit ? "ring-tick lit" : "ring-tick"}
                x1={60 + 46 * Math.cos(a)}
                y1={60 + 46 * Math.sin(a)}
                x2={60 + 56 * Math.cos(a)}
                y2={60 + 56 * Math.sin(a)}
              />
            );
          })
        ) : (
          <>
            <circle className="dl-ring-track" cx="60" cy="60" r={r} />
            <circle
              className="dl-ring-arc"
              cx="60"
              cy="60"
              r={r}
              strokeDasharray={c}
              strokeDashoffset={v.state === "completed" ? 0 : c * (1 - v.fraction)}
              transform="rotate(-90 60 60)"
            />
          </>
        )}
      </svg>
      )}
      {props.children && <div className="deadline-ring-center">{props.children}</div>}
    </div>
  );
}
