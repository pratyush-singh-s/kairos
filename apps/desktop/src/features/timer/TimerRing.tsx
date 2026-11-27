import { formatClock } from "@focus/core";
import { ENDLESS_FOCUS_MS, PHASE_LABEL, isEndless, sessionCount, type TimerSnapshot } from "../../ipc/timer";
import { useRemaining } from "./useTimer";
import { AsciiRing, useAscii } from "../../components/Ascii";

const SIZE = 320;
const STROKE = 12;
const R = (SIZE - STROKE) / 2 - 4;
const CIRC = 2 * Math.PI * R;

/** The circular timer: the ring fills as the phase goes by. */
export function TimerRing(props: { snap: TimerSnapshot; idleDurationMs: number; terminal: boolean }) {
  const s = props.snap;
  const ascii = useAscii();
  const remaining = useRemaining(s);
  const idle = s.status === "idle";
  const duration = idle ? props.idleDurationMs : s.durationMs;
  const shown = idle ? props.idleDurationMs : remaining;
  // Endless focus counts up, and the ring goes round once a minute like a second hand.
  const endless = idle ? props.idleDurationMs >= ENDLESS_FOCUS_MS : s.status !== "finished" && isEndless(s);
  const elapsed = idle ? 0 : s.durationMs - remaining;
  const progress = endless
    ? (elapsed % 60_000) / 60_000
    : duration > 0 && !idle ? Math.min(1, 1 - remaining / duration) : s.status === "finished" ? 1 : 0;
  const seconds = endless ? Math.floor(elapsed / 1000) : Math.ceil(shown / 1000);
  const isBreak = s.phase !== "focus" && !idle;

  const label =
    s.status === "finished"
      ? "Done"
      : s.status === "paused"
        ? `${PHASE_LABEL[s.phase]} · paused`
        : s.status === "waiting"
          ? `${PHASE_LABEL[s.phase]} ready`
          : idle
            ? endless ? "Endless focus" : "Focus"
            : endless ? "Focus · endless" : PHASE_LABEL[s.phase];
  const sessions = idle || endless ? null : `Session ${sessionCount(s)}`;

  return (
    <div className="timer-ring" data-break={isBreak} data-status={s.status} data-endless={endless || undefined}>
      {ascii ? (
        <AsciiRing fraction={idle ? 0 : progress} dots={72} thickness={4} />
      ) : (
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle className="ring-track" cx={SIZE / 2} cy={SIZE / 2} r={R} strokeWidth={STROKE} />
        <circle
          className="ring-progress"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          strokeWidth={STROKE}
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - progress)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          data-sweep={endless || undefined}
        />
      </svg>
      )}
      <div className="ring-center">
        <div className="ring-time">{formatClock(seconds)}</div>
        <div className="ring-phase">{label}</div>
        {sessions && <div className="ring-session">{sessions}</div>}
        {props.terminal && !idle && <div className="ring-bar">{asciiBar(progress)}</div>}
      </div>
      {/* Screen readers hear phase changes, not every passing second. */}
      <p className="sr-only" aria-live="polite">
        {label}
        {sessions ? `, ${sessions}` : ""}
      </p>
    </div>
  );
}

function asciiBar(progress: number): string {
  const width = 16;
  const filled = Math.round(progress * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${Math.floor(progress * 100)}%`;
}
